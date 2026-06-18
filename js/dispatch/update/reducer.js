/**
 * The reducer (`update`) + Cmd descriptors.
 *
 * The reducer `update(model, msg) → [newModel, cmds]` is the single writer
 * for the chrome / modal / config / framework layers; Component slices are
 * written by each Component's own `update`. Cross-layer ops route through
 * `apply_msg` / `dispatch_msg` Cmds (see docs/v0.5-layering.md).
 *
 * Lives in `dispatch/` (F3 — docs/reducer-cleanup-relocation.md): the reducer
 * reads `panel/route` + `model/store` (both DOWN from dispatch) and is invoked
 * by `dispatch.applyMsg` (intra-layer), so this is its natural home. It was in
 * `app/runtime.js` until the F3 arc, which trapped `app` in the layer SCC
 * (`dispatch→app`); moving it here lets `app` be a clean top layer. The
 * model object + accessors live in `model/store.js` (v0.6.5 §1);
 * `app/runtime.js` is now a thin back-compat shim re-exporting this module.
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
 *   - A pure function of (model, msg). The focus-routing arms
 *     (escape / list_select / nav_select / next_tab / prev_tab / filter_*) read
 *     no route topology: the handler stamps the resolved bundle
 *     (`route.bundle(id)` → {compName, panelType, target}, or `msg.target` for
 *     the viewer-tab arms) onto the Msg, and the arm reads `msg.route` (blessed-
 *     exception A elimination — docs/reducer-route-purity.md). The two former
 *     residual `route.componentForPanel(<constant>)` reads are gone too (#D9):
 *     `set_config` reads `msg.csOwner` and `reset_group_context` reads
 *     `msg.owners` (`{ panelType: ownerName }`), both resolved by the impure-
 *     shell dispatcher (`route.resetGroupOwners` is the single source of the
 *     reset panel list) and stamped on the Msg. `route.wrap` (a pure Msg ctor)
 *     is not a topology read. See docs/blessed-exceptions.md.
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
const kb = require('../../leaves/keybindings');
// esc() for the jobs_routed info-card lines (background/tmux).
const { esc } = require('../../leaves/ansi');
// Pure yank-register transforms (leaf) — push/promote/drop/clear taking
// `model`, so the reducer owns register mutations; OSC52 is an emit_osc52 Cmd.
const mreg = require('../../leaves/register');
// Panel routing leaf — `wrap` for routed Msgs, `componentForPanel` /
// `getFocus` for the cross-layer dispatches in `escape`, `filter_*`,
// `reset_group_context`, etc. Direct import (zero deps) — no cycle.
// Replaces the old lazy `require('../../panel/api')` peppered through this file.
const route = require('../../panel/route');
// Nav-entry shape reader — zero-dep leaf; the only consumer here is the
// `escape` arm's multiSel probe.
const mnav = require('../../leaves/nav');
// leaves/pane-tabs + leaves/search are leaves of the detail Component's
// update. The root reducer doesn't import them directly.

// The root-model store (the model object + init + getModel/setModel) lives in
// model/store.js (v0.6.5 §1) so panel/ and dispatch/ depend *down* on it. The
// three are re-exported below for back-compat (the app/runtime shim + tests) —
// new code should import them from model/store directly.
const { init, getModel, setModel } = require('../../model/store');
// Pending suffix of the autosuggest ghost (prompt_key Tab/Right accept). Pure
// leaf — shared with the prompt overlay render. Moved out of this file in F3.
const { ghostSuffix } = require('../../leaves/ghost');

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
// dispatch/control/cmdline.js, and overlay/cmdline.js all read the same values.
const { splitQuery: _cmdlineSplit, DROPDOWN_VIEWPORT: CMDLINE_VW } = require('../../leaves/cmdline-split');

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
// Frame-clock cadence (model.now / tick arc — docs/model-now-tick.md).
// 1s matches the human-visible age resolution of the jobs/diag overlays.
const CLOCK_MS = 1000;
// Arm the gated frame-clock loop if it isn't already running. Returns the
// [model, cmds] pair so an *_open arm can `return _armClock(opened)`. The
// `arm_clock` effect reads the wall clock in the impure shell (blessed
// exception C) and dispatches `clock_tick` carrying the fresh `now`; the
// clock_tick arm re-emits this Cmd while an age overlay stays open and lets
// it lapse (clockArmed→false) otherwise. Idempotent: a second open while
// armed adds no Cmd, so jobs+diag open together never double-arm.
function _armClock(model) {
  if (model.clockArmed) return [model, []];
  return [{ ...model, clockArmed: true }, [{ type: 'arm_clock', ms: CLOCK_MS }]];
}
function _withModal(model, patch) {
  return { ...model, modal: { ...model.modal, ...patch } };
}

// blessed-exception A elimination (docs/reducer-route-purity.md) — the
// focus-routing arms (escape / list_select / nav_select / filter_*) no longer
// resolve a pane address inline. The HANDLER stamps `route.bundle(id)` (the
// `{ compName, panelType, target }` triple) onto the Msg; the arm reads it.
// `route.bundle` replaces the old in-reducer `_navRoute` helper — same triple,
// resolved one layer up so the reducer reads no route topology.

// `]`/`[` cycle the focused-or-sticky viewer's tab list. resolveTarget
// picks the right viewer pane (focus / sticky / first-in-arrange); null
// result (no viewer registered) drops the Cmd.
//
// v0.6.4 Theme C — pure of Component-slice reads. The viewer tab info
// (curTab / total / resolved tab-key array) is threaded by the
// next_tab/prev_tab handler (`actions._viewerTabBundle`); the arm keeps
// only the pure cycle math. v0.6.5 blessed-A elimination — the routing
// read (`resolveTarget('viewer')`) also moved to the handler:
// `_viewerTabBundle` now stamps `msg.target`, so the arm reads no route.
function _cycleViewerTab(model, msg, dir) {
  const target = msg.target;
  if (!target) return [model, []];
  const total = msg.total | 0;
  if (total <= 1) return [model, []];
  const next = (((msg.curTab | 0) + (dir | 0)) % total + total) % total;
  const targetKey = (msg.tabKeys || [])[next] || null;
  return [model, [{ type: 'msg', msg: route.wrap(target, {
    type: 'tab_switch', idx: next,
    targetKey, currentGroup: msg.currentGroup || (model.currentGroup || ''),
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
      // v0.6.4 Theme C — `hadMultiSel` is threaded by the escape handler
      // (it read the focused nav's multiSel.size). v0.6.5 blessed-A
      // elimination — the routing triple is also threaded: the handler
      // stamps `msg.route = route.bundle(getFocus())` ({compName, panelType,
      // target}); null when focus owns no Component. The arm reads no route.
      const had = !!msg.hadMultiSel;
      const r = msg.route;
      // multisel_clear targets THIS pane's instance (r.target), keyed by its
      // panel-type (r.panelType — multi-panel Components index nav by type).
      const clearCmd = () => (r
        ? [{ type: 'msg', msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }) }]
        : []);
      if (model.modes.listSelectMode) {
        return [_withModes(model, { listSelectMode: false }), clearCmd()];
      } else if (had) {
        return [model, clearCmd()];
      }
      return [model, []];
    }
    case 'list_select': {
      // `mode:'toggle'` (v) flips list-select; turning it off drops the
      // operand selection. `mode:'on'` (*) forces it on (the caller then
      // fires selectAllVisible as an effect). The _isListPanel guard is
      // view derivation — the caller already applied it.
      if (msg.mode === 'on') return [_withModes(model, { listSelectMode: true }), []];
      const nextOn = !model.modes.listSelectMode;
      const next = _withModes(model, { listSelectMode: nextOn });
      if (!nextOn) {
        // Turning select mode OFF clears the operand selection. v0.6.5
        // blessed-A — the toggle handler stamps `msg.route` (focus bundle);
        // clear THIS pane's instance, keyed by its panel-type (see escape).
        const r = msg.route;
        if (r) return [next, [{ type: 'msg', msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }) }]];
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
    case 'next_tab':    return _cycleViewerTab(model, msg, +1);
    case 'prev_tab':    return _cycleViewerTab(model, msg, -1);
    case 'nav_select': {
      // R6 — single-Msg cascade for "user selects row N in panel P,"
      // formerly orchestrated by dispatch.navSelect's 2-3 imperative
      // dispatches (set_cursor → showSelectedInfo → conditional
      // groups_selected). Collapsing to one Msg + multi-Cmd return
      // makes the cascade visible in the reducer instead of in the
      // handler, satisfying the TEA discipline call-out in
      // feedback_tea_reducer_discipline.
      const { index } = msg;
      // v0.6.5 blessed-A — the navSelect handler stamps `msg.route =
      // route.bundle(panelType)` ({compName, panelType, target}); null when
      // the address owns no Component. Was three inline route reads here
      // (componentForPanel / paneTypeOf / hasInstance). r.panelType is the
      // canonical panel-type (set_cursor's nav.entryOf indexes multi-panel
      // Components by it); r.target routes to THIS pane's instance (a live
      // paneId) vs the kind's primary; both no-op under single-pane configs.
      const r = msg.route;
      if (!r) return [model, []];
      const kindForNav = r.panelType;
      const cmds = [
        { type: 'msg', msg: route.wrap(r.target, { type: 'set_cursor', panel: kindForNav, index }) },
        { type: 'show_selected_info' },
      ];
      if (kindForNav === 'groups') {
        // v0.6.3 Phase D1: thread the groups ctx so the reducer arm
        // stays pure of getModel(). viewerTarget + resetOwners ride in on msg
        // (stamped by the navSelect handler, impure shell) so neither the
        // reducer nor groups.update reads route topology / the ownership
        // registry for the cascade — #D10 / #D9.
        const groupsComp = require('../../panel/navigator/groups');
        const ctx = { ...groupsComp.groupsBundle(model), paneMenuMode: !!model.modes.paneMenuMode,
                      viewerTarget: msg.viewerTarget, resetOwners: msg.resetOwners };
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
        const tail = ghostSuffix(text, p.ghost);
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
      // Stamp `now` from the handler (msg.now) so the first frame shows a
      // fresh age, then arm the frame clock (gated on age overlays open).
      return _armClock({
        ..._withModes(model, { jobsMode: true }),
        modal: { ...model.modal, jobs: { cursor: 0, scroll: 0 } },
        now: msg.now || model.now,
      });
    case 'jobs_close':
      if (!model.modes.jobsMode) return [model, []];
      return [_withModes(model, { jobsMode: false }), []];
    // Frame-clock tick (docs/model-now-tick.md). Advance model.now from the
    // shell-stamped msg.now, then re-arm ONLY while an age overlay is still
    // open — otherwise drop clockArmed so the loop lapses (idle = no ticks).
    // A close needs no work: the next tick observes both modes false and
    // stops; a re-open before that tick fires sees clockArmed still true and
    // skips re-arming (the pending tick re-arms once it sees the mode back on).
    case 'clock_tick': {
      const advanced = { ...model, now: msg.now || model.now };
      if (advanced.modes.jobsMode || advanced.modes.diagLogMode) {
        return [advanced, [{ type: 'arm_clock', ms: CLOCK_MS }]];
      }
      return [{ ...advanced, clockArmed: false }, []];
    }
    case 'set_theme': {
      // Theme selection flows through update like any other state change.
      // model.theme is the canonical record; the `set_theme` Cmd syncs the
      // leaves/infra/themes palette cache (the impure-shell projection the pure
      // render leaves read). No-op identity-preserve when unchanged so a
      // redundant `:theme X` while already on X doesn't churn the model.
      if (msg.name === model.theme) return [model, []];
      return [{ ...model, theme: msg.name }, [{ type: 'set_theme', name: msg.name }]];
    }
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
    // --- Diagnostics window (leader e). Mirrors jobs_*: open/close flip
    // the mode + reset cursor; nav clamps against the handler-supplied
    // count (the diag-log buffer is out-of-TEA, read renderer-side, so
    // the count is threaded in like jobs). clear / save are effects.
    case 'diag_log_open':
      if (model.modes.diagLogMode) return [model, []];
      return _armClock({
        ..._withModes(model, { diagLogMode: true }),
        modal: { ...model.modal, diagLog: { cursor: 0, scroll: 0 } },
        now: msg.now || model.now,
      });
    case 'diag_log_close':
      if (!model.modes.diagLogMode) return [model, []];
      return [_withModes(model, { diagLogMode: false }), []];
    case 'diag_log_nav': {
      const d = model.modal.diagLog;
      const count = msg.count | 0;
      const vh = Math.max(1, msg.vh | 0);
      if (count <= 0) return [model, []];
      let next = d.cursor;
      if (msg.to === 'top')           next = 0;
      else if (msg.to === 'bottom')    next = count - 1;
      else if (msg.to === 'pageup')    next = d.cursor - vh;
      else if (msg.to === 'pagedown')  next = d.cursor + vh;
      else                              next = d.cursor + ((msg.dir | 0) || 0);
      next = Math.max(0, Math.min(count - 1, next));
      let scroll = d.scroll | 0;
      if (next < scroll)            scroll = next;
      else if (next >= scroll + vh) scroll = next - vh + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, count - vh)));
      if (next === d.cursor && scroll === d.scroll) return [model, []];
      return [_withModal(model, { diagLog: { cursor: next, scroll } }), []];
    }
    case 'diag_log_clear':
      // Buffer mutation is a side-effect → Cmd. Reset the cursor here.
      return [_withModal(model, { diagLog: { cursor: 0, scroll: 0 } }), [{ type: 'diag_clear' }]];
    case 'diag_log_save':
      return [model, [{ type: 'diag_save' }]];
    case 'jobs_activate': {
      // v0.6.4 Phase C — PURE orchestrator. The handler resolves the
      // (out-of-TEA) feature/jobs entry by cursor and threads it via
      // msg.job; msg.now is the dispatch-time timestamp for the
      // background/tmux age display. This arm only closes the overlay,
      // resolves the target group from the job payload (a model-only
      // read), and queues the cascade — it performs NO Component-slice
      // read.
      //
      // The tab-routing that USED to live here read the viewer slice
      // (flatTabInfo / resolveTabKey) and depended on the POST-switch
      // currentGroup, so it had to synthesize a post-cascade model — the
      // old "blessed" cross-slice reducer read. Phase C hands that off to
      // the dispatch-side `jobs_route` Cmd, which runs AFTER the queued
      // set_current_group commits and reads the committed group directly
      // (no synthetic model), then threads the resolved tab into the pure
      // `jobs_routed` tail below. "Not threadable within one Msg" was true;
      // a second Msg makes it threadable.
      if (!model.modes.jobsMode) return [model, []];
      const job = msg.job || null;
      const closedModel = _withModes(model, { jobsMode: false });
      if (!job) return [closedModel, []];

      const { owner = {} } = job;
      const cmds = [];
      const targetGroup = owner.groupName
        || (owner.ptyId ? _parsePtyIdGroup(model, owner.ptyId) : null);
      if (targetGroup && targetGroup !== model.currentGroup) {
        cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: targetGroup } });
      }
      // The routing read happens post-switch in the jobs_route effect; it
      // re-dispatches the pure jobs_routed Msg with the destination threaded.
      cmds.push({ type: 'jobs_route', job, now: msg.now });
      return [closedModel, cmds];
    }
    case 'jobs_routed': {
      // v0.6.4 Phase C — PURE tail of jobs_activate. The dispatch-side
      // `jobs_route` effect already read the post-switch viewer slice and
      // threaded the resolved destination (viewerTarget / groupName / tabIdx
      // / targetKey / fromTabKey). This arm reads NO Component slice — it
      // only emits the Cmd cascade (tab_switch + focus + terminal_enter /
      // info card) from the threaded payload. msg.now feeds the
      // background/tmux age display.
      const job = msg.job || null;
      if (!job) return [model, []];
      const { kind, owner = {} } = job;
      const viewerTarget = msg.viewerTarget || 'detail';
      const groupName = msg.groupName || model.currentGroup;
      const cmds = [];

      if (kind === 'stream-routed' && owner.tabKey) {
        // tabIdx is set only when the effect found the action tab.
        if (msg.tabIdx != null) {
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: msg.tabIdx,
            targetKey: msg.targetKey,
            currentGroup: groupName,
          }) });
          cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
        }
      } else if (kind === 'stream-unrouted') {
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      } else if (kind === 'pty' && owner.ptyId) {
        if (msg.tabIdx != null) {
          cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
            type: 'tab_switch', idx: msg.tabIdx,
            targetKey: msg.targetKey,
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
        // v0.6.3 Phase D1 — thread root facts the viewer_set_content arm
        // needs (currentGroup, fromTabKey). fromTabKey was read from the
        // viewer slice by the jobs_route effect; bg/tmux never switch group,
        // so model.currentGroup here equals the pre-switch value.
        cmds.push({ type: 'msg', msg: route.wrap(viewerTarget, {
          type: 'viewer_set_content', lines,
          currentGroup: model.currentGroup,
          fromTabKey: msg.fromTabKey,
        }) });
        cmds.push({ type: 'msg', msg: route.wrap('layout', { type: 'focus_set', focus: viewerTarget }) });
      }
      return [model, cmds];
    }
    case 'menu_open':
      // v0.6.4 Theme C — items are threaded by the menu_open handler
      // (built from the layout slice there); the arm no longer reads the
      // Component slice. `|| []` covers the degenerate / test path.
      // v0.6.4 Theme F Phase 3 — `msg.anchor` ({x,y} 1-based, or null/absent)
      // is stored so the menu render can open at a right-click's cursor; null
      // (the keyboard `x` verb) keeps the menu centered. `msg.title` overrides
      // the overlay title (right-click context menu → 'Actions'); null = 'Menu'.
      return [{
        ..._withModes(model, { menuOpen: true }),
        modal: { ...model.modal, menu: { items: msg.items || [], idx: 0, anchor: msg.anchor || null, title: msg.title || null } },
      }, []];
    case 'menu_close':
      if (!model.modes.menuOpen) return [model, []];
      return [{
        ..._withModes(model, { menuOpen: false }),
        modal: { ...model.modal, menu: { items: [], idx: 0, anchor: null, title: null } },
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
      // Absolute idx (a mouse click on a specific row) overrides the cursor;
      // keyboard Enter omits it and activates the highlighted row.
      const i = (typeof msg.idx === 'number') ? msg.idx : mm.idx;
      const item = mm.items[i];
      const next = {
        ..._withModes(model, { menuOpen: false }),
        modal: { ...model.modal, menu: { items: [], idx: 0, anchor: null, title: null } },
      };
      if (!item) return [next, []];
      // item[2] (arg) rides along for verbs that take one (copy_text); bare
      // command verbs leave it undefined.
      return [next, [{ type: 'menu_action', action: item[1], arg: item[2] }]];
    }
    // --- `/`-filter mode. The caller (dispatch) resolves the panel +
    // filterable gate + committed seed text, since the filterable check
    // is plugin-API (can't live in the reducer). The transforms are
    // pure model writes (no plugin API, no Cmd).
    case 'filter_enter': {
      // v0.6.5 blessed-A — the handler stamps `msg.route = route.bundle(
      // msg.panel)`. Store it on the filter modal so filter_key / filter_exit
      // reuse it without re-resolving (the filtered pane is fixed for the
      // whole session — filter mode locks input). Was an in-reducer
      // `_navRoute(msg.panel)` route read on every filter arm.
      const r = msg.route || null;
      const next = {
        ..._withModes(model, { filterMode: true }),
        modal: { ...model.modal, filter: { text: msg.text || '', panel: msg.panel, route: r } },
      };
      // v0.6.3 Round-2 — clear multiSel on filter-session entry.
      // Selections made before entering filter mode reference items
      // the filter may hide; carrying them across the commit surfaces
      // as ghost selections when the filter is later cleared.
      // Parallel to groups.switchTab's multiSel-clear on All↔Quick
      // toggle. multisel_clear is a no-op when the panel had no
      // selection, so the Cmd is free in the common case.
      if (!r) return [next, []];
      return [next, [{
        type: 'msg',
        msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }),
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
      // is the writer. v0.6.5 blessed-A — reuse the session route bundle
      // stored at filter_enter (f.route) rather than re-resolving here.
      const r = f.route;
      if (!r) return [next, []];
      return [next, [{ type: 'msg', msg: route.wrap(r.target, { type: 'set_cursor', panel: r.panelType, index: 0 }) }]];
    }
    case 'filter_exit': {
      const f = model.modal.filter;
      const text = f.text;
      const keep = !!msg.keep;
      const next = {
        ..._withModes(model, { filterMode: false }),
        modal: { ...model.modal, filter: { text: '', panel: '', route: null } },
      };
      // v0.6.5 blessed-A — reuse the session route bundle stored at
      // filter_enter (f.route); commit/clear the filter + re-home
      // cursor/scroll on THAT instance's nav slice (keyed by its panel-type).
      const r = f.route;
      // #D11 — the body-refresh that exiting filter triggers is the reducer's
      // decision (emit the show_selected_info Cmd), not a second imperative
      // dispatch in handleFilterKey. One gesture (Esc/Enter in filter) → one
      // Msg → reducer-decided cascade.
      if (!r) return [next, [{ type: 'show_selected_info' }]];
      const { target, panelType } = r;
      // Commit/clear the filter on the panel's nav slice; the owning
      // Component is the single writer.
      const filterMsg = (keep && text)
        ? { type: 'set_filter',   panel: panelType, text }
        : { type: 'clear_filter', panel: panelType };
      return [next, [
        { type: 'msg', msg: route.wrap(target, filterMsg) },
        { type: 'msg', msg: route.wrap(target, { type: 'set_cursor', panel: panelType, index: 0 }) },
        { type: 'msg', msg: route.wrap(target, { type: 'set_scroll', panel: panelType, offset: 0 }) },
        { type: 'show_selected_info' },
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
      // a BROADCAST_TYPES entry.
      // #D9 — the config-status owner is resolved by the dispatcher (impure
      // shell, app/state.loadConfig) and stamped on msg.csOwner, so the reducer
      // reads no ownership registry (extends the blessed-A handler-stamp pattern
      // to this arm). null owner (Component unregistered) drops the fan-out.
      return [next, msg.csOwner
        ? [{ type: 'msg', msg: route.wrap(msg.csOwner, { type: 'set_config', config: msg.config }) }]
        : []];
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
      // actions/containers nav state lives on their own Component slices.
      // #D9 — the panel→owner map is resolved by the dispatcher (impure shell)
      // and stamped on msg.owners (`{ <panelType>: <ownerComponentName> }`), so
      // the reducer reads no ownership registry (extends the blessed-A handler-
      // stamp pattern). The map's KEYS are WHICH panels reset (route.resetGroupOwners
      // is the single source of that list); null owner skips that panel (the old
      // `if (compName)` gate). Routing by Component NAME (not panel-type) so the
      // fanout resolves to the kind's primary instance (containers → docker).
      const cmds = [];
      for (const [panel, compName] of Object.entries(msg.owners || {})) {
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

// `init`/`getModel`/`setModel` re-exported for back-compat (the app/runtime
// shim + tests); new code imports them from model/store. `update` is the
// reducer this module owns. (`_ghostSuffix` moved to leaves/ghost.)
module.exports = { init, getModel, setModel, update };
