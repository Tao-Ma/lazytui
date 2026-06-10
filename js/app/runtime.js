/**
 * Root model + reducer (`update`) + Cmd descriptors.
 *
 * The root model lives here, owned by the runtime. The reducer
 * `update(model, msg) → [newModel, cmds]` is the single writer for the
 * chrome / modal / config / framework layers; Component slices are
 * written by each Component's own `update`. Cross-layer ops route
 * through `apply_msg` / `dispatch_msg` Cmds (see docs/v0.5-layering.md).
 *
 * Contract:
 *   - Readers use `getModel()` (no global imports).
 *   - All writes to root-model fields flow through `update`, which
 *     returns a NEW model object on state change. Reducer-leaves
 *     (leaves/free-config / leaves/register / leaves/search / leaves/pane-tabs
 *     / leaves/nav) are pure return-new transforms; leaves/menu is a
 *     pure builder. Freeze-test coverage in `js/test/test-immutable-*.js`.
 *   - The reducer performs no I/O; effects are Cmd DESCRIPTORS the
 *     effects layer (effects.runEffects, called from dispatch.applyMsg)
 *     interprets.
 *   - Modal-close arms (confirm_reject / prompt_cancel / cmdline_cancel
 *     / register_popup_cancel / menu_close / copy_cancel / *_drop /
 *     *_accept / *_submit) guard on their mode flag — a stale double-
 *     fire after the modal closed is a no-op, not a re-execution of the
 *     staged Cmd.
 */
'use strict';

// Pure group-tree transforms (selectGroup cascade, expand/collapse,
// switch-tab). They mutate the model and do no I/O, so the reducer can run
// them inline — they live in their own leaf module (not state.js) precisely
// so importing them here introduces no require cycle.
// keybindings is a dependency-free leaf (the leader-chord registry tree), so
// the reducer can read it to walk the prefix tree without a require cycle.
const kb = require('../dispatch/keybindings');
// Pure command-menu item builder (leaf), so menu_open can build inline.
const menu = require('../leaves/menu');
// Pure pane-tab info builder (leaf) — flatTabInfo for jobs_activate's
// tab-idx resolution. Zero-dep leaf, safe direct import.
const pt = require('../leaves/pane-tabs');
// esc() for the jobs_activate info-card lines (background/tmux).
const { esc } = require('../io/ansi');
// Pure yank-register transforms (leaf) — push/promote/drop/clear taking
// `model`, so the reducer owns register mutations; OSC52 is an emit_osc52 Cmd.
const mreg = require('../leaves/register');
// Panel routing leaf — `wrap` for routed Msgs, `componentForPanel` /
// `getFocus` for the cross-layer dispatches in `escape`, `filter_*`,
// `reset_group_context`, etc. Direct import (zero deps) — no cycle.
// Replaces the old lazy `require('../panel/api')` peppered through this file.
const route = require('../panel/route');
// Nav-entry shape reader — zero-dep leaf; the only consumer here is the
// `escape` arm's multiSel probe.
const mnav = require('../leaves/nav');
// leaves/pane-tabs + leaves/search are leaves of the detail Component's
// update. The root reducer doesn't import them directly.

/**
 * The root model.
 *
 * Single owned object; `update` is its single writer. Component slices
 * (detail / groups / docker / files / config-status / layout) live in
 * the instance store (panel/route.js) and are written only by their
 * own `update`. The layout slice owns the grid (arrange, focus,
 * viewMode, freeConfig); per-panel chrome (cursor/scroll/multiSel/filter)
 * lives on each Navigator's `slice.nav`.
 *
 * Field map:
 *   - modes{}                        — 14 modal flags (single registry; see modes.js)
 *   - currentGroup                   — current group (chrome)
 *   - modal{ filter, menu, confirm, prompt, copy, registerPopup, cmdline }
 *                                    — modal sub-model editing buffers
 *   - config / projectDir / configPath — parsed config + paths
 *   - focused / prefixNode / prefixSeq — misc
 *   - register                       — yank register
 */
function init() {
  // Derive the initial modes bag from dispatch/modes.js MODES registry —
  // the registry is the single source of truth. Hardcoding the list
  // here let v0.6.3 D1's paneSelectMode drift: the registry had it but
  // init() didn't, so the mode_set Cmd's `flag in modes` guard refused
  // to arm the flag, and the pane-select overlay never painted in
  // production. (Tests pre-set the property in their setup() so they
  // missed the bug.) Lazy require avoids the modes.js ↔ runtime.js
  // module cycle.
  const { MODES } = require('../dispatch/modes');
  const initialModes = {};
  for (const md of MODES) initialModes[md.flag] = false;
  const m = {
    modes: initialModes,
    currentGroup: '',
    // Transient per-mode editing buffers (the modal sub-models). The
    // reducer owns them; each modal handler is an update branch.
    // `filter` here is the live `/`-filter draft (text + which panel
    // is being filtered); the COMMITTED filter text lives on each
    // Navigator's `slice.nav[panel].filter`.
    modal: {
      filter: { text: '', panel: '' },
      menu: { items: [], idx: 0 },
      // The pending confirm: a message + the Cmd DESCRIPTOR to emit on `y`
      // (data, not a closure — e.g. {type:'do_run', actionKey, action, args}).
      confirm: { message: '', cmd: null },
      // The args prompt: label/spec (display), text (typed), ghost
      // (autosuggest, seeded by the caller from the yank register), and the
      // base Cmd descriptor — submit parses args from text + merges them in.
      prompt: { label: '', spec: '', text: '', ghost: '', cmd: null },
      // Copy menu: only the render-safe {label, cancel} options + idx. The
      // actual content thunks (plugin closures) stay module-held in copy.js;
      // copy_commit invokes the selected one by index.
      copy: { options: [], idx: 0 },
      // Register-history popup (the `"` yank popup): the highlighted row +
      // the scroll offset of the fixed-height viewport. The register history
      // itself lives on model.register (manipulated only via register.js +
      // OSC52 — those stay effects, emitted as register_* Cmds).
      registerPopup: { idx: 0, scroll: 0 },
      // `:` cmdline: the typed text, the selected dropdown row, and the
      // render-safe match projection ({display, desc, kind} — NO run
      // closures). The closures stay module-held in cmdline.js (rebuilt from
      // the plugin facade each keystroke); cmdline_run invokes the selected
      // one by index. Mirrors the copy split.
      cmdline: { text: '', sel: 0, scroll: 0, matches: [] },
      // Design-mode state lives on the layout Component's slice —
      // `getInstanceSlice('layout').freeConfig`.
      // Running overlay (Phase 4.2) — cursor + scroll into the live jobs
      // list. Item snapshot is NOT stored here; the renderer reads
      // feature/jobs.list() at frame time so the overlay reflects
      // mid-overlay arrivals + status flips.
      jobs: { cursor: 0, scroll: 0 },
    },
    // Framework-level state: parsed config, paths, leader-mode buffers,
    // misc flags. The layout struct + freeConfig state + viewMode + focus
    // are on the layout Component's slice (see
    // docs/v0.5-layout-component.md).
    config: null,
    projectDir: '.',
    configPath: '',
    focused: true,
    prefixNode: null,
    prefixSeq: [],
    register: null,                  // yank register {history, cap} (register.js)
  };
  return m;
}

// Container pattern: the root model lives behind a single mutable ref
// the dispatcher swaps for a new snapshot post-reducer. The reducer
// now returns new models on every state-changing Msg (pure-TEA);
// no-op Msgs return the same ref so setModel can identity-check.
// getModel() always returns the current snapshot — callers MUST NOT
// cache the returned object across Msg dispatches (see the stale-ref
// hazards documented in v0.5-layering.md).
const _modelRef = { current: init() };

function getModel() { return _modelRef.current; }

/**
 * Replace the root model with a new snapshot. Called by the dispatch
 * boundary (`applyMsg`) after the reducer returns. No-op when the
 * reducer identity-preserves on a no-op Msg; otherwise the
 * reassignment is what makes the new state visible to `getModel()`.
 *
 * Reentrant dispatch ordering: setModel MUST be called BEFORE
 * `runEffects` so cross-layer Cmds (`apply_msg`, `dispatch_msg`) see
 * the post-Msg state when they re-enter the dispatch graph.
 */
function setModel(next) {
  if (next && next !== _modelRef.current) _modelRef.current = next;
}

/**
 * Pending suffix of the autosuggest ghost — empty unless `text` is a strict
 * prefix of `ghost`. Used by the prompt_key Tab/Right accept + (mirrored) by
 * the prompt renderer to draw the dim tail.
 */
function _ghostSuffix(text, ghost) {
  if (!ghost || !ghost.startsWith(text) || text.length >= ghost.length) return '';
  return ghost.slice(text.length);
}

/** ptyId is `${group}_${key}`; group keys can contain underscores, so
 *  match greedily against the live config. Falls back to the substring
 *  before the first underscore. Used by the jobs_activate reducer arm
 *  to resolve a target group when the registered job only carries the
 *  ptyId (no explicit owner.groupName). */
function _parsePtyIdGroup(model, ptyId) {
  const groups = (model.config && model.config.groups) || {};
  for (const name of Object.keys(groups)) {
    if (ptyId.startsWith(`${name}_`)) return name;
  }
  const u = ptyId.indexOf('_');
  return u < 0 ? ptyId : ptyId.slice(0, u);
}

// cmdline split + viewport size live in a zero-dep leaf so this file,
// dispatch/cmdline.js, and overlay/cmdline.js all read the same values.
const { splitQuery: _cmdlineSplit, DROPDOWN_VIEWPORT: CMDLINE_VW } = require('../leaves/cmdline-split');

/**
 * Clamp the register-popup cursor + scroll into bounds against the history
 * length `n` and the viewport height `vh` (resolved by the caller, since it
 * reads the terminal size — view-derived, not reducer state). Returns a new
 * `{idx, scroll}` value; mirrors register-popup.js's old _clamp().
 */
function _clampRegisterPopup(rp, n, vh) {
  if (n === 0) {
    if (rp.idx === 0 && rp.scroll === 0) return rp;
    return { idx: 0, scroll: 0 };
  }
  let idx = rp.idx;
  let scroll = rp.scroll;
  if (idx < 0) idx = 0;
  if (idx >= n) idx = n - 1;
  if (idx < scroll) scroll = idx;
  if (idx >= scroll + vh) scroll = idx - vh + 1;
  if (scroll < 0) scroll = 0;
  if (idx === rp.idx && scroll === rp.scroll) return rp;
  return { idx, scroll };
}

// Shallow update helpers. Spread chains for nested model writes are
// readable but verbose; these collapse the common cases. `_withModes`
// flips one or more mode flags; `_withModal` patches one or more modal
// sub-models. Both preserve object identity when no field actually
// changes (cheap skip — callers don't need to guard).
function _withModes(model, patch) {
  return { ...model, modes: { ...model.modes, ...patch } };
}
function _withModal(model, patch) {
  return { ...model, modal: { ...model.modal, ...patch } };
}

// `]`/`[` cycle the focused-or-sticky viewer's tab list. resolveTarget
// picks the right viewer pane (focus / sticky / first-in-arrange); null
// result (no viewer registered) drops the Cmd.
//
// v0.6.3 TEA Phase 3f: this arm used to emit a `tab_cycle` Msg that
// the pane-tabs leaf decoded via ctx.getModel + ctx.getTabInfo to
// compute the next idx and emit tab_switch. The intermediate Msg
// existed only because the chain dispatcher didn't have model/slice
// in scope. The root reducer DOES — its arg IS model — so compute
// directly here and emit tab_switch. tab_cycle Msg retired.
function _cycleViewerTab(model, dir) {
  const target = route.resolveTarget('viewer');
  if (!target) return [model, []];
  const slice = route.getInstanceSlice(target) || { tab: 0 };
  const groupName = (model && model.currentGroup) || '';
  const total = pt.flatTabInfo(slice, model, groupName).total;
  if (total <= 1) return [model, []];
  const next = (((slice.tab | 0) + (dir | 0) + total) % total + total) % total;
  const targetKey = pt.resolveTabKey(next, { ...slice, tab: next }, model);
  return [model, [{ type: 'msg', msg: route.wrap(target, {
    type: 'tab_switch', idx: next,
    targetKey, currentGroup: groupName,
  }) }]];
}

/**
 * The reducer — `(model, msg) → [nextModel, cmds]`.
 *
 * Two rules:
 *   1. Root-model writes happen HERE. The reducer is the single writer
 *      for every chrome / modal / config / framework field; Component
 *      slices are written by each Component's own `update`.
 *   2. No effects. `update` stays free of effectful imports (no viewer.js
 *      / layout.js) so it has no require cycle and is trivially unit-
 *      testable. Side effects go out as Cmd DESCRIPTORS (`{ type, ... }`)
 *      the effects layer (effects.runEffects) interprets.
 *
 * Every branch returns a NEW model object; no in-place writes. The
 * `_withModes` / `_withModal` helpers above keep the spread chains
 * readable. Identity-preserve on no-ops (skip alloc).
 */
function update(model, msg) {
  switch (msg.type) {
    case 'escape': {
      // Esc exits list-select mode (clearing the focused panel's
      // selection), else clears any lingering multi-selection; otherwise
      // a no-op. The multiSel clear dispatches into the focused
      // Navigator's update (each panel owns its own Set).
      const focus = route.getFocus();
      const compName = route.componentForPanel(focus);
      // v0.6.3 post-arch-arc — focus is paneId; mnav indexes by
      // panel-type. Translate via paneTypeOf for the entry lookup
      // AND for the downstream Msg payload (each Component's
      // set_cursor / multisel_clear arms index slice.nav by
      // panel-type for multi-panel Components like files).
      const panelType = route.paneTypeOf(focus) || focus;
      // v0.6.4 Theme C — `hadMultiSel` is threaded by the escape handler
      // (it read the focused nav's multiSel.size); the arm no longer
      // reaches into the Component slice. Routing reads (getFocus /
      // componentForPanel / paneTypeOf) stay — the blessed chokepoint.
      const had = !!msg.hadMultiSel;
      if (model.modes.listSelectMode) {
        const next = _withModes(model, { listSelectMode: false });
        if (compName) return [next, [{ type: 'msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: panelType }) }]];
        return [next, []];
      } else if (had) {
        return [model, [{ type: 'msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: panelType }) }]];
      }
      return [model, []];
    }
    case 'list_select': {
      // `mode:'toggle'` (v) flips list-select; turning it off drops the
      // operand selection. `mode:'on'` (*) forces it on (the caller then
      // fires selectAllVisible as an effect). The _isListPanel guard is
      // view derivation — the caller already applied it.
      const focus = route.getFocus();
      if (msg.mode === 'on') return [_withModes(model, { listSelectMode: true }), []];
      const nextOn = !model.modes.listSelectMode;
      const next = _withModes(model, { listSelectMode: nextOn });
      if (!nextOn) {
        const compName = route.componentForPanel(focus);
        const panelType = route.paneTypeOf(focus) || focus;
        if (compName) return [next, [{ type: 'msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: panelType }) }]];
      }
      return [next, []];
    }
    case 'enter_prefix':
      // Leader pressed — arm prefix mode at the binding-tree root. All of
      // prefixMode/prefixNode/prefixSeq are model-resident.
      return [{ ..._withModes(model, { prefixMode: true }), prefixNode: kb.rootNode(), prefixSeq: [] }, []];
    case 'prefix_key': {
      // Walk the leader tree. Esc / a second leader press cancels. An
      // unbound token silently drops out. A subtree descends (stay armed);
      // a leaf exits + emits a run_binding Cmd carrying the thunk (a Cmd is
      // a thunk the effects layer runs — TEA-shaped). kb.resolve is a pure
      // read of the leaf registry.
      const cancelled = () =>
        ({ ..._withModes(model, { prefixMode: false }), prefixNode: null, prefixSeq: [] });
      if (msg.key === 'escape' || msg.seq === ' ' || msg.key === ' ') return [cancelled(), []];
      const tok = kb.tokenForEvent(msg.key, msg.seq);
      const nextNode = kb.resolve(model.prefixNode, tok);
      if (!nextNode) return [cancelled(), []];
      const seq = model.prefixSeq.concat(tok);
      // Descend: which-key popup re-renders with the subtree's
      // continuations. If the subtree has fewer entries than the
      // current level, the centered overlay shrinks — its prior top/
      // bottom border rows are now exposed under-content the diff
      // cache treats as unchanged (panels are frozen during prefix
      // mode), so prior pixels stick. Same trap as pool_drag_motion +
      // free_config_mouse_motion. Force a full repaint on every descend.
      if (nextNode.children) return [{ ...model, prefixNode: nextNode, prefixSeq: seq }, [{ type: 'force_full_repaint' }]];
      // leaf — exit prefix mode and emit the binding
      return [{ ..._withModes(model, { prefixMode: false }), prefixNode: null, prefixSeq: [] },
              [{ type: 'run_binding', run: nextNode.run }]];
    }
    // --- Cmd-only verbs: no model change, the reducer just routes the
    // Msg to a Cmd the effects layer runs. Centralizing the Msg→Cmd
    // mapping here is what lets handleAction's arms collapse into update.
    case 'next_tab':    return _cycleViewerTab(model, +1);
    case 'prev_tab':    return _cycleViewerTab(model, -1);
    case 'nav_select': {
      // R6 — single-Msg cascade for "user selects row N in panel P,"
      // formerly orchestrated by dispatch.navSelect's 2-3 imperative
      // dispatches (set_cursor → showSelectedInfo → conditional
      // groups_selected). Collapsing to one Msg + multi-Cmd return
      // makes the cascade visible in the reducer instead of in the
      // handler, satisfying the TEA discipline call-out in
      // feedback_tea_reducer_discipline.
      const { panelType, index } = msg;
      const compName = route.componentForPanel(panelType);
      if (!compName) return [model, []];
      // v0.6.3 post-arch-arc — panelType may arrive as a paneId
      // post-B3 (`getFocus()` returns paneId; navSelect threads it
      // as-is). Translate to the panel-type form before fanning out
      // — set_cursor's downstream nav.entryOf indexes by panel-type
      // for multi-panel Components, and the kind comparison below
      // expects the type name. `paneTypeOf` is the canonical
      // resolver (handles docker-style panes that have no per-pane
      // instance via arrange walk).
      const kindForNav = route.paneTypeOf(panelType) || panelType;
      const cmds = [
        { type: 'msg', msg: route.wrap(compName, { type: 'set_cursor', panel: kindForNav, index }) },
        { type: 'show_selected_info' },
      ];
      if (kindForNav === 'groups') {
        // v0.6.3 Phase D1: thread the groups ctx so the reducer arm
        // stays pure of getModel().
        const groupsComp = require('../panel/navigator/groups');
        const ctx = { ...groupsComp.groupsBundle(model), tabListMode: !!model.modes.tabListMode };
        cmds.push({ type: 'msg', msg: route.wrap('groups', { type: 'groups_selected', index, ctx }) });
      }
      return [model, cmds];
    }
    // --- confirm modal (folded into update). The caller stages a message +
    // a Cmd DESCRIPTOR (the deferred effect as data); `y` re-emits that Cmd,
    // `n`/Esc clears. No closure in the model.
    case 'confirm_enter':
      return [{
        ..._withModes(model, { confirmMode: true }),
        modal: { ...model.modal, confirm: { message: msg.message || 'Are you sure?', cmd: msg.cmd || null } },
      }, []];
    case 'confirm_accept': {
      // Guard on the flag — a stale double-fire after the modal closed
      // would re-execute the staged Cmd against unstaged state. See
      // the modal-close contract in the file header.
      if (!model.modes.confirmMode) return [model, []];
      const cmd = model.modal.confirm.cmd;
      const next = {
        ..._withModes(model, { confirmMode: false }),
        modal: { ...model.modal, confirm: { message: '', cmd: null } },
      };
      return [next, cmd ? [cmd] : []];
    }
    case 'confirm_reject':
      if (!model.modes.confirmMode) return [model, []];
      return [{
        ..._withModes(model, { confirmMode: false }),
        modal: { ...model.modal, confirm: { message: '', cmd: null } },
      }, []];
    // --- args prompt (folded into update). Same Cmd-descriptor pattern as
    // confirm: the caller stages a base do_run Cmd; submit parses args from
    // the typed text and merges them in before emitting. The ghost is seeded
    // by the caller (reading the yank register, which the reducer can't).
    case 'prompt_enter':
      return [{
        ..._withModes(model, { promptMode: true }),
        modal: { ...model.modal, prompt: {
          label: msg.label || 'Input', spec: msg.spec || '',
          text: typeof msg.text === 'string' ? msg.text : '',
          ghost: msg.ghost || '', cmd: msg.cmd || null,
        } },
      }, []];
    case 'prompt_key': {
      const p = model.modal.prompt;
      let text = p.text;
      if (msg.seq === '\x09' || msg.key === 'right') {       // accept ghost suffix
        const tail = _ghostSuffix(text, p.ghost);
        if (tail) text += tail;
      } else if (msg.seq === '\x7f') { text = text.slice(0, -1); }      // backspace
      else if (msg.seq === '\x15')   { text = ''; }                     // Ctrl+U
      // T26 — paste: bracketed-paste content arrives as key='paste',
      // seq=<full content>. Append (single-line modal: collapse line
      // breaks to single spaces so a multi-line paste doesn't break
      // the single-line UX).
      else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text += msg.seq.replace(/[\r\n]+/g, ' ');
      }
      else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        text += msg.seq;
      }
      if (text === p.text) return [model, []];
      return [_withModal(model, { prompt: { ...p, text } }), []];
    }
    case 'prompt_submit': {
      if (!model.modes.promptMode) return [model, []];
      const p = model.modal.prompt;
      const text = p.text;
      const cmd = p.cmd;
      const next = {
        ..._withModes(model, { promptMode: false }),
        modal: { ...model.modal, prompt: { label: '', spec: '', text: '', ghost: '', cmd: null } },
      };
      const args = text.trim() ? text.trim().split(/\s+/) : [];
      return [next, cmd ? [{ ...cmd, args }] : []];
    }
    case 'prompt_cancel':
      if (!model.modes.promptMode) return [model, []];
      return [{
        ..._withModes(model, { promptMode: false }),
        modal: { ...model.modal, prompt: { label: '', spec: '', text: '', ghost: '', cmd: null } },
      }, []];
    // --- copy menu (folded into update; the content thunks stay module-held,
    // resolved by the copy_commit Cmd — decision-A copy-split).
    case 'copy_enter':
      return [{
        ..._withModes(model, { copyMode: true }),
        modal: { ...model.modal, copy: { options: msg.options || [], idx: 0 } },
      }, []];
    case 'copy_nav': {
      const c = model.modal.copy;
      if (!c.options.length) return [model, []];
      const idx = (c.idx + msg.dir + c.options.length) % c.options.length;
      if (idx === c.idx) return [model, []];
      return [_withModal(model, { copy: { ...c, idx } }), []];
    }
    case 'copy_select': {
      if (!model.modes.copyMode) return [model, []];
      const idx = model.modal.copy.idx;
      const next = {
        ..._withModes(model, { copyMode: false }),
        modal: { ...model.modal, copy: { options: [], idx: 0 } },
      };
      return [next, [{ type: 'copy_commit', idx }]];
    }
    case 'copy_cancel':
      if (!model.modes.copyMode) return [model, []];
      return [{
        ..._withModes(model, { copyMode: false }),
        modal: { ...model.modal, copy: { options: [], idx: 0 } },
      }, [{ type: 'copy_commit', idx: -1 }]];  // -1 = clear, no copy
    // --- register-history popup (`"`, folded into update). The reducer owns
    // the cursor/scroll (model.modal.registerPopup) + the mode flag AND the
    // history mutation (via the leaves/register leaf); OSC52 is the only effect,
    // emitted as an emit_osc52 Cmd. `vh` (viewport height) is caller-resolved
    // since it reads the terminal size.
    case 'register_popup_enter':
      return [{
        ..._withModes(model, { registerPopupMode: true }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      }, []];
    case 'register_popup_nav': {
      const rp = model.modal.registerPopup;
      const n = model.register.history.length;
      let idx = rp.idx;
      if (msg.to === 'top')         idx = 0;
      else if (msg.to === 'bottom') idx = n - 1;
      // Number.isInteger guard instead of `msg.dir || 0` — same arithmetic
      // result today (no caller passes 0), but the integer-typed contract
      // is explicit and a malformed call with `dir: 'up'` falls through
      // to 0 (a no-op) rather than producing NaN.
      else                          idx = rp.idx + (Number.isInteger(msg.dir) ? msg.dir : 0);
      const clamped = _clampRegisterPopup({ idx, scroll: rp.scroll }, n, msg.vh);
      // Value-equal clamps preserve the original ref (callers can still
      // distinguish "nothing changed" from "no-op").
      if (clamped.idx === rp.idx && clamped.scroll === rp.scroll) return [model, []];
      return [_withModal(model, { registerPopup: clamped }), []];
    }
    case 'register_popup_drop': {
      if (!model.modes.registerPopupMode) return [model, []];
      const rp = model.modal.registerPopup;
      if (model.register.history.length === 0) return [model, []];
      // The leaf returns `[newRegister, removed]`; clamp against the new
      // length (idx stays on the row the next-older entry slides into).
      const [nextReg] = mreg.drop(model.register, rp.idx);
      const nextRp = _clampRegisterPopup(rp, nextReg.history.length, msg.vh);
      const modes = nextReg.history.length === 0
        ? { ...model.modes, registerPopupMode: false }
        : model.modes;
      const next = {
        ...model,
        modes,
        register: nextReg,
        modal: { ...model.modal, registerPopup: nextRp },
      };
      // force_full_repaint reclaims the row the shrunk overlay no longer
      // covers (the main diff can't see the overlay geometry).
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'register_popup_commit': {
      if (!model.modes.registerPopupMode) return [model, []];
      const idx = model.modal.registerPopup.idx;
      const n = model.register.history.length;
      const baseNext = {
        ..._withModes(model, { registerPopupMode: false }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      };
      if (n === 0) return [baseNext, []];
      // idx>0 promotes the entry to top; idx===0 re-emits the current top so
      // opening the popup just to copy it still refreshes the OS clipboard.
      let nextReg = model.register;
      let v;
      if (idx > 0) {
        const [r, val] = mreg.promote(model.register, idx);
        nextReg = r;
        v = val;
      } else {
        v = model.register.history[0] || '';
      }
      return [{ ...baseNext, register: nextReg }, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    // --- yank-register push (folded into update). select.commit + any other
    // app yank emits this; the leaf does the dedup/cap, OSC52 rides out as a
    // Cmd. register.js keeps direct wrappers over the leaf for the test API.
    case 'register_push': {
      const [nextReg, v] = mreg.push(model.register, msg.text);
      if (nextReg === model.register && !v) return [model, []];
      return [{ ...model, register: nextReg }, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    case 'register_popup_cancel':
      if (!model.modes.registerPopupMode) return [model, []];
      return [{
        ..._withModes(model, { registerPopupMode: false }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      }, []];
    // --- `:` cmdline (folded into update). The reducer owns text + sel + the
    // render-safe match list (model.modal.cmdline); the run closures stay
    // module-held in cmdline.js. Any text change emits a cmdline_rebuild Cmd
    // — the effects layer rebuilds the registry from the plugin facade (which
    // the pure reducer can't touch) and re-applies cmdline_set_matches with
    // the render-safe projection. That Cmd→Msg writeback keeps the reducer
    // the single writer of model state while the effect supplies the data.
    case 'cmdline_enter':
      return [{
        ..._withModes(model, { cmdMode: true }),
        modal: { ...model.modal, cmdline: { text: '', sel: 0, scroll: 0, matches: [] } },
      }, [{ type: 'cmdline_rebuild' }]];
    case 'cmdline_set_matches': {
      const c = model.modal.cmdline;
      const matches = msg.matches || [];
      let sel = c.sel > matches.length - 1 ? Math.max(0, matches.length - 1) : c.sel;
      // Skip past hint entries when defaulting — they're discoverability
      // markers (e.g. `docker://`) with no meaningful run action, so
      // Enter shouldn't land on one by default. Once the user arrows TO
      // a hint deliberately, c.sel is preserved across rebuilds; this
      // fixup only fires when sel WOULD point to a hint as a side-effect
      // of the new match set.
      if (matches[sel] && matches[sel].kind === 'hint') {
        let i = sel;
        while (i < matches.length && matches[i].kind === 'hint') i++;
        if (i < matches.length) sel = i;
      }
      // Scroll viewport — match-set size changed, ensure sel is in view
      // and scroll is within bounds.
      const maxScroll = Math.max(0, matches.length - CMDLINE_VW);
      let scroll = Math.min(Math.max(0, c.scroll || 0), maxScroll);
      if (sel < scroll) scroll = sel;
      else if (sel >= scroll + CMDLINE_VW) scroll = sel - CMDLINE_VW + 1;
      // cmdline_preview drives the live-preview teardown/apply on the new
      // sel (typing-narrowed match set). Entries opt in via preview(); the
      // framework calls teardown when sel moves off.
      return [_withModal(model, { cmdline: { ...c, matches, sel, scroll } }),
              [{ type: 'cmdline_preview', sel }]];
    }
    case 'cmdline_nav': {
      const c = model.modal.cmdline;
      // up (dir>0) walks toward worse matches (higher idx); down (dir<0) walks
      // back toward the best match at idx 0 — the dropdown paints best-nearest-
      // the-prompt, so the visual "up" is a higher index.
      const sel = msg.dir > 0
        ? Math.min(c.sel + 1, c.matches.length - 1)
        : Math.max(0, c.sel - 1);
      if (sel === c.sel) return [model, []];
      // Scroll the visible window so sel stays in view. When sel walks
      // OFF the top (sel exceeds the window's upper bound) advance scroll
      // so sel ends up at the top of the new window. Symmetrical the
      // other direction.
      let scroll = c.scroll || 0;
      if (sel < scroll) scroll = sel;
      else if (sel >= scroll + CMDLINE_VW) scroll = sel - CMDLINE_VW + 1;
      return [_withModal(model, { cmdline: { ...c, sel, scroll } }),
              [{ type: 'cmdline_preview', sel }]];
    }
    case 'cmdline_key': {
      const c = model.modal.cmdline;
      if (msg.seq === '\t') {
        // Tab accepts the SELECTED match into the buffer (refine further),
        // keeping any args already typed past the matched name. argComplete
        // entries already pack the full cmdline replacement into `display`
        // (e.g. "open /etc/hosts/"), so we swap the buffer wholesale —
        // the command-name splice formula doesn't apply when display IS
        // the entire command line.
        const chosen = c.matches[c.sel];
        if (!chosen) return [model, []];
        let text;
        if (chosen.argComplete) {
          text = chosen.display;
        } else {
          const { args } = _cmdlineSplit(c.text);
          text = chosen.display.toLowerCase() + (args.length ? ' ' + args.join(' ') : '');
        }
        return [_withModal(model, { cmdline: { ...c, text, sel: 0, scroll: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq === '\x7f') {
        return [_withModal(model, { cmdline: { ...c, text: c.text.slice(0, -1), sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        return [_withModal(model, { cmdline: { ...c, text: c.text + msg.seq, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      // T26 — paste support: bracketed-paste content arrives as
      // key='paste', seq=<full content>. Single-line modal — collapse
      // line breaks to single spaces.
      if (msg.key === 'paste' && typeof msg.seq === 'string') {
        const pasted = msg.seq.replace(/[\r\n]+/g, ' ');
        return [_withModal(model, { cmdline: { ...c, text: c.text + pasted, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      return [model, []];
    }
    case 'cmdline_submit': {
      if (!model.modes.cmdMode) return [model, []];
      const c = model.modal.cmdline;
      const chosen = c.matches[c.sel];
      // Enter on a "refinable" entry (hint / dir / docker container —
      // no terminal action) acts like Tab: rewrite the buffer with the
      // entry's display and stay in cmdline mode so the user can keep
      // refining. Without this, Enter would fire the entry's no-op
      // run() and silently close the cmdline — looks like a dead key.
      if (chosen && chosen.refine) {
        return [_withModal(model, { cmdline: { ...c, text: chosen.display, sel: 0, scroll: 0 } }),
                [{ type: 'cmdline_rebuild' }]];
      }
      const sel = c.sel;
      const { args } = _cmdlineSplit(c.text);
      const had = c.matches.length > 0;
      const next = {
        ..._withModes(model, { cmdMode: false }),
        modal: { ...model.modal, cmdline: { text: '', sel: 0, scroll: 0, matches: [] } },
      };
      // cmdline_run resolves the module-held closure at `sel` + runs it with
      // the parsed args; cmdline_clear drops the held registry afterward.
      return [next, had ? [{ type: 'cmdline_run', sel, args }, { type: 'cmdline_clear' }] : [{ type: 'cmdline_clear' }]];
    }
    case 'cmdline_cancel':
      if (!model.modes.cmdMode) return [model, []];
      // cmdline_revert_preview restores whatever the active preview's
      // teardown points at (theme on revert, etc.) BEFORE clear drops
      // the registry — Esc must restore, not commit.
      return [{
        ..._withModes(model, { cmdMode: false }),
        modal: { ...model.modal, cmdline: { text: '', sel: 0, scroll: 0, matches: [] } },
      }, [{ type: 'cmdline_revert_preview' }, { type: 'cmdline_clear' }]];
    // --- terminal mode enter/exit. The PTY restart (on a dead session)
    // stays an effect in dispatch.activateTerminal; only the flag write
    // is the Msg here. Exit also drops a 'full' auto-zoom back to
    // 'normal' (pure) and asks for a full repaint so the chrome
    // reclaims the cells the PTY painted (the diff cache can't see those).
    case 'terminal_enter':
      if (model.modes.terminalMode) return [model, []];
      return [_withModes(model, { terminalMode: true }), []];
    case 'terminal_exit':
      // viewMode is owned by the layout Component — emit a cross-layer
      // dispatch_msg so layout decides whether to drop a 'full' auto-
      // zoom back to 'normal'. Guard on the flag so the per-frame
      // setImmediate from renderTerminalOverlay on a dead PTY
      // (layout.js#renderTerminalOverlay) doesn't allocate a fresh model
      // snapshot + re-emit view_drop_full_to_normal each frame once
      // terminalMode is already off.
      if (!model.modes.terminalMode) return [model, []];
      return [_withModes(model, { terminalMode: false }),
              [{ type: 'msg', msg: route.wrap('layout', { type: 'view_drop_full_to_normal' }) }]];
    // --- terminal focus events (DEC 1004). Pauses/resumes the refresh
    // loop via model.focused; the focus-regain catch-up scheduleRender
    // stays in input.js (an effect decision the caller owns).
    case 'focus_event': {
      const focused = !!msg.focused;
      if (focused === model.focused) return [model, []];
      return [{ ...model, focused }, []];
    }
    // --- command menu. Items (action strings, no closures) are built
    // inline from the model on open; nav skips null separators;
    // activate emits a menu_action Cmd routing the chosen verb back
    // through dispatch.handleAction.
    // --- Running overlay (Phase 4.2). Cursor/scroll live in
    // model.modal.jobs; the items list is read live from
    // feature/jobs.list() at render time. Clamping is the handler's
    // responsibility — the reducer takes the count + vh in the Msg.
    case 'jobs_open':
      if (model.modes.jobsMode) return [model, []];
      return [{
        ..._withModes(model, { jobsMode: true }),
        modal: { ...model.modal, jobs: { cursor: 0, scroll: 0 } },
      }, []];
    case 'jobs_close':
      if (!model.modes.jobsMode) return [model, []];
      return [_withModes(model, { jobsMode: false }), []];
    case 'jobs_nav': {
      const j = model.modal.jobs;
      const count = msg.count | 0;
      const vh = Math.max(1, msg.vh | 0);
      if (count <= 0) return [model, []];
      let next = j.cursor;
      if (msg.to === 'top')           next = 0;
      else if (msg.to === 'bottom')    next = count - 1;
      else if (msg.to === 'pageup')    next = j.cursor - vh;
      else if (msg.to === 'pagedown')  next = j.cursor + vh;
      else                              next = j.cursor + ((msg.dir | 0) || 0);
      next = Math.max(0, Math.min(count - 1, next));
      let scroll = j.scroll | 0;
      if (next < scroll)            scroll = next;
      else if (next >= scroll + vh) scroll = next - vh + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, count - vh)));
      if (next === j.cursor && scroll === j.scroll) return [model, []];
      return [_withModal(model, { jobs: { cursor: next, scroll } }), []];
    }
    case 'jobs_activate': {
      // Single-Msg cascade — handler resolves the (out-of-TEA)
      // feature/jobs entry by cursor and threads it via msg.job; the
      // reducer emits the Cmd list from msg.job + msg.now. Reducer is
      // pure (R2 — pre-fix this arm read feature/jobs.list() inline,
      // violating the renderer-only-reader contract for out-of-TEA
      // stores per PRINCIPLES §12). msg.now is the dispatch-time
      // timestamp for the background/tmux age display.
      if (!model.modes.jobsMode) return [model, []];
      const job = msg.job || null;
      const closedModel = _withModes(model, { jobsMode: false });
      if (!job) return [closedModel, []];

      const { kind, owner = {} } = job;
      const cmds = [];
      const targetGroup = owner.groupName
        || (owner.ptyId ? _parsePtyIdGroup(model, owner.ptyId) : null);
      if (targetGroup && targetGroup !== model.currentGroup) {
        cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: targetGroup } });
      }
      const viewerTarget = route.resolveTarget('viewer') || 'detail';
      const groupName = targetGroup || model.currentGroup;

      // POST-CASCADE model view: when the cross-group set_current_group
      // Cmd above is queued, it'll apply BEFORE tab_switch reduces. So
      // anything we thread that the tab_switch reducer reads needs to
      // reflect the POST-cascade currentGroup, not the captured model
      // ref. Build a synthetic post-cascade model for resolveTabKey
      // and thread groupName (already resolved to the post-cascade
      // value at line 761) for currentGroup. Round-5 finding —
      // Phase-3d shipped this with the captured model.currentGroup,
      // which broke cross-group jobs_activate scroll restoration.
      const postModel = (targetGroup && targetGroup !== model.currentGroup)
        ? { ...model, currentGroup: groupName }
        : model;

      if (kind === 'stream-routed' && owner.tabKey) {
        const slice = route.getInstanceSlice(viewerTarget)
          || { ephemeralTerminals: {}, contentTabs: {}, tab: 0 };
        const info = pt.flatTabInfo(slice, model, groupName);
        const idx = info.actionTabs.findIndex(([k]) => k === owner.tabKey);
        if (idx >= 0) {
          // v0.6.2 — action tabs start at idx 2 (Info=0, Transcript=1).
          const tabIdx = 2 + idx;
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: tabIdx,
            targetKey: pt.resolveTabKey(tabIdx, { ...slice, tab: tabIdx }, postModel),
            currentGroup: groupName,
          }) });
          cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
        }
      } else if (kind === 'stream-unrouted') {
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      } else if (kind === 'pty' && owner.ptyId) {
        const slice = route.getInstanceSlice(viewerTarget)
          || { ephemeralTerminals: {}, contentTabs: {}, tab: 0 };
        const info = pt.flatTabInfo(slice, model, groupName);
        let termIdx = -1;
        for (let i = 0; i < info.termTabs.length; i++) {
          if (`${groupName}_${info.termTabs[i][0]}` === owner.ptyId) { termIdx = i; break; }
        }
        if (termIdx >= 0) {
          // v0.6.2 — term tabs start at idx 2 + actionTabs.length.
          const tabIdx = 2 + info.actionTabs.length + termIdx;
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: tabIdx,
            targetKey: pt.resolveTabKey(tabIdx, { ...slice, tab: tabIdx }, postModel),
            currentGroup: groupName,
          }) });
          cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
          cmds.push({ type: 'msg', msg: { type: 'terminal_enter' } });
        }
      } else if (kind === 'background' || kind === 'tmux') {
        const now = msg.now | 0;
        const ageS = Math.max(0, Math.floor(((job.endedAt || now) - job.startedAt) / 1000));
        const lines = [
          `[dim]$ ${esc(job.label)}[/]`,
          '',
          `[dim]kind:[/]     ${kind}`,
          kind === 'background'
            ? `[dim]pid:[/]      ${job.pid == null ? '(unknown)' : job.pid}`
            : `[dim]window:[/]   ${esc(owner.tmuxWindowName || '')}`,
          `[dim]status:[/]   ${job.status}${job.exitCode == null ? '' : ` (exit ${job.exitCode})`}`,
          `[dim]age:[/]      ${ageS}s`,
          '',
          `[dim]cmd:[/]`,
          `  ${esc(owner.cmd || '(no cmd recorded)')}`,
        ];
        // v0.6.3 Phase D1 — thread root facts the viewer_set_content
        // arm needs (currentGroup, fromTabKey). msg.tab is not used
        // here so no `total` needed. Slice + model already in scope.
        const vSlice = route.getInstanceSlice(viewerTarget) || { tab: 0 };
        cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
          type: 'viewer_set_content', lines,
          currentGroup: model.currentGroup,
          fromTabKey: pt.resolveTabKey((vSlice.tab | 0), vSlice, model),
        }) });
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      }
      return [closedModel, cmds];
    }
    case 'menu_open':
      return [{
        ..._withModes(model, { menuOpen: true }),
        modal: { ...model.modal, menu: { items: menu.buildItems(route.getInstanceSlice('layout')), idx: 0 } },
      }, []];
    case 'menu_close':
      if (!model.modes.menuOpen) return [model, []];
      return [{
        ..._withModes(model, { menuOpen: false }),
        modal: { ...model.modal, menu: { items: [], idx: 0 } },
      }, []];
    case 'menu_nav': {
      const mm = model.modal.menu;
      const items = mm.items;
      let i = mm.idx + (msg.dir < 0 ? -1 : 1);
      if (msg.dir < 0) { while (i >= 0 && items[i] === null) i--; if (i < 0) return [model, []]; }
      else { while (i < items.length && items[i] === null) i++; if (i >= items.length) return [model, []]; }
      if (i === mm.idx) return [model, []];
      return [_withModal(model, { menu: { ...mm, idx: i } }), []];
    }
    case 'menu_activate': {
      if (!model.modes.menuOpen) return [model, []];
      const mm = model.modal.menu;
      const item = mm.items[mm.idx];
      const next = {
        ..._withModes(model, { menuOpen: false }),
        modal: { ...model.modal, menu: { items: [], idx: 0 } },
      };
      if (!item) return [next, []];
      return [next, [{ type: 'menu_action', action: item[1] }]];
    }
    // --- `/`-filter mode. The caller (dispatch) resolves the panel +
    // filterable gate + committed seed text, since the filterable check
    // is plugin-API (can't live in the reducer). The transforms are
    // pure model writes (no plugin API, no Cmd).
    case 'filter_enter': {
      const next = {
        ..._withModes(model, { filterMode: true }),
        modal: { ...model.modal, filter: { text: msg.text || '', panel: msg.panel } },
      };
      // v0.6.3 Round-2 — clear multiSel on filter-session entry.
      // Selections made before entering filter mode reference items
      // the filter may hide; carrying them across the commit surfaces
      // as ghost selections when the filter is later cleared.
      // Parallel to groups.switchTab's multiSel-clear on All↔Quick
      // toggle. multisel_clear is a no-op when the panel had no
      // selection, so the Cmd is free in the common case.
      const compName = route.componentForPanel(msg.panel);
      if (!compName) return [next, []];
      return [next, [{
        type: 'msg',
        msg: route.wrap(compName, { type: 'multisel_clear', panel: msg.panel }),
      }]];
    }
    case 'filter_key': {
      const f = model.modal.filter;
      let text = f.text;
      if (msg.seq === '\x7f') {
        if (!text) return [model, []];
        text = text.slice(0, -1);
      } else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32) {
        text = text + msg.seq;
      // T26 — paste support: bracketed-paste content arrives as
      // key='paste', seq=<full content>. Single-line modal — collapse
      // line breaks to single spaces.
      } else if (msg.key === 'paste' && typeof msg.seq === 'string') {
        text = text + msg.seq.replace(/[\r\n]+/g, ' ');
      } else {
        return [model, []];
      }
      const next = _withModal(model, { filter: { ...f, text } });
      // Re-home the cursor as the filter narrows; the panel's nav slice
      // is the writer.
      const compName = route.componentForPanel(f.panel);
      if (!compName) return [next, []];
      return [next, [{ type: 'msg', msg: route.wrap(compName, { type: 'set_cursor', panel: f.panel, index: 0 }) }]];
    }
    case 'filter_exit': {
      const f = model.modal.filter;
      const panel = f.panel;
      const text = f.text;
      const keep = !!msg.keep;
      const next = {
        ..._withModes(model, { filterMode: false }),
        modal: { ...model.modal, filter: { text: '', panel: '' } },
      };
      if (!panel) return [next, []];
      const compName = route.componentForPanel(panel);
      if (!compName) return [next, []];
      // Commit/clear the filter on the panel's nav slice; the owning
      // Component is the single writer.
      const filterMsg = (keep && text)
        ? { type: 'set_filter',   panel, text }
        : { type: 'clear_filter', panel };
      return [next, [
        { type: 'msg', msg: route.wrap(compName, filterMsg) },
        { type: 'msg', msg: route.wrap(compName, { type: 'set_cursor', panel, index: 0 }) },
        { type: 'msg', msg: route.wrap(compName, { type: 'set_scroll', panel, offset: 0 }) },
      ]];
    }
    case 'mode_clear':
      // Defensive: clear a single mode flag. Used by dispatch's wedge-guard
      // when a mode handler throws — without this, the failing modal traps
      // every subsequent key (Esc included) in the same throwing handler.
      // Routed through update so even the panic-recovery path stays single-
      // writer; falls back to no-op if the flag isn't a registered mode.
      if (!msg.flag || !(msg.flag in model.modes) || model.modes[msg.flag] === false) return [model, []];
      return [_withModes(model, { [msg.flag]: false }), []];
    case 'mode_set':
      // Companion to mode_clear: set a mode flag to true via Msg. Used by
      // the viewer Component's search-enter handler to flip
      // detailSearchMode without writing across layers (the search slice
      // is the viewer's; the mode flag is root chrome).
      if (!msg.flag || !(msg.flag in model.modes) || model.modes[msg.flag] === true) return [model, []];
      return [_withModes(model, { [msg.flag]: true }), []];
    case 'set_current_group': {
      // Cross-layer Msg emitted by the groups Component when its tree
      // cascade changes the active group. currentGroup is APP-WIDE
      // chrome (read by actions / docker / files / tabs / etc.) —
      // written through update so every reader sees the same source.
      const name = typeof msg.name === 'string' ? msg.name : '';
      if (name === model.currentGroup) return [model, []];
      return [{ ...model, currentGroup: name }, []];
    }
    // v0.6.3 Phase D3 — boot-time root writes routed through Msgs.
    // loadConfig parses + dispatches set_config; initState dispatches
    // set_register. Pre-D3 these were direct `m.config = ...` /
    // `m.register = ...` writes in app/state.js (BLESSED outside-
    // writers per docs/v0.5-layering.md §5). Now the reducer is the
    // sole writer to root model.
    case 'set_config': {
      const next = {
        ...model,
        config: msg.config,
        projectDir: (msg.config && msg.config.project_dir) || '.',
        configPath: msg.configPath || model.configPath,
      };
      // v0.6.3 Round-2 — fan set_config out to config-status, the only
      // Component that snapshots config (files / projectDir) onto its
      // slice for reducer-pure reads. Mirrors the reset_group_context
      // fan-out a few arms below. Pre-fix the wrapped arm in
      // config-status.update existed but was unreachable in production
      // (only tests dispatched it directly via wrap('config-status', ...));
      // production worked by accident because init() reads getModel().
      // Sole listener today, hence per-component dispatch rather than
      // a BROADCAST_TYPES entry. Gates on the Component being
      // registered so tests that skip it don't trip "unknown Component".
      const cmds = [];
      const csOwner = route.componentForPanel('config-status');
      if (csOwner) {
        cmds.push({ type: 'msg', msg: route.wrap(csOwner, { type: 'set_config', config: msg.config }) });
      }
      return [next, cmds];
    }
    case 'set_register': {
      return [{ ...model, register: msg.register }, []];
    }
    case 'reset_group_context': {
      // Cross-layer Msg emitted by the groups Component on a group
      // switch — the ROOT chrome half of resetGroupContext (per-group
      // sel / filters / multiSel reset, mode flags off). The
      // viewer-slice half rides on viewer_reset_chrome → detail
      // Component.
      const next = _withModes(model, { terminalMode: false, listSelectMode: false });
      // actions/containers nav state lives on their own Component
      // slices; emit wrapped resets per panel only when the owning
      // Component is registered (tests that don't register
      // actions/docker shouldn't trigger "unknown Component" warnings).
      const cmds = [];
      for (const panel of ['actions', 'containers']) {
        const compName = route.componentForPanel(panel);
        if (!compName) continue;
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'set_cursor', panel, index: 0 }) });
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'multisel_clear', panel }) });
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'clear_filter', panel }) });
      }
      return [next, cmds];
    }
    case 'free_config': {
      // Free-config is always available; the verb forwards a wrapped
      // free_config_enter Msg into the layout Component.
      return [model, [{ type: 'msg', msg: route.wrap('layout', { type: 'free_config_enter' }) }]];
    }
    default:
      return [model, []];
  }
}

module.exports = { init, getModel, setModel, update, _ghostSuffix };
