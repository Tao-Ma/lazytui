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
 *     returns a NEW model object on state change (post-Phase-4 pure-TEA
 *     conversion). Reducer-leaves (leaves/design / leaves/register /
 *     leaves/search / leaves/tabs / leaves/nav) are pure return-new
 *     transforms; leaves/menu is a pure builder that returns a fresh
 *     items list. Freeze-test coverage in `js/test/test-immutable-*.js`.
 *   - The reducer performs no I/O; effects are Cmd DESCRIPTORS the
 *     effects layer (effects.runEffects, called from dispatch.applyMsg)
 *     interprets.
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
// Pure yank-register transforms (leaf) — push/promote/drop/clear taking
// `model`, so the reducer owns register mutations; OSC52 is an emit_osc52 Cmd.
const mreg = require('../leaves/register');
// Panel routing leaf — `wrap` for routed Msgs, `componentForPanel` /
// `getFocus` for the cross-layer dispatches in `escape`, `filter_*`,
// `reset_group_context`, etc. Direct import (zero deps) — no cycle.
// Replaces the old lazy `require('../panel/api')` peppered through this file.
const route = require('../leaves/route');
// leaves/tabs + leaves/search are leaves of the detail Component's update.
// The root reducer doesn't import them directly.

/**
 * The root model.
 *
 * Single owned object; `update` is its single writer. Component slices
 * (detail / groups / docker / files / config-status) live in
 * panel/api.js's componentSlices map — not here — and are written
 * only by their own `update`.
 *
 * Field map (post-v0.5):
 *   - modes{}                        — 13 modal flags (single registry; see modes.js)
 *   - currentGroup                   — current group (chrome)
 *   - modal{ filter, menu, confirm, prompt, copy, registerPopup, cmdline }
 *                                    — modal sub-model editing buffers
 *   - config / projectDir / configPath — parsed config + paths
 *   - lastRunAction / focused / prefixNode / prefixSeq — misc
 *   - register                       — yank register
 *
 * Phase 1 (docs/v0.5-layout-component.md) migrated focus, viewMode,
 * design state, designEnabled, layoutDirty, model.layout (arrange),
 * and panelHeights/panelBounds onto the layout Component's slice.
 * Phase 4 (a + b + c) migrated all per-panel chrome (cursor / scroll /
 * multiSel / filter) onto each Navigator's `slice.nav[panelType]`;
 * `model.ui` retired entirely.
 */
function init() {
  const m = {
    // The 13 modal-state flags. Maintained centrally in js/modes.js (registry +
    // resetModes()); update branches and modeChain consult that single list.
    modes: {
      confirmMode: false, promptMode: false, designTitleEditMode: false,
      designMode: false, menuOpen: false, filterMode: false, copyMode: false,
      detailSearchMode: false, registerPopupMode: false, prefixMode: false,
      cmdMode: false, terminalMode: false, listSelectMode: false,
    },
    currentGroup: '',
    // Phase 4a moved cursor/scroll/multiSel onto each Navigator's nav
    // slice; Phase 4c folded the committed filter text in too. The root
    // `ui` field retired — every per-panel chrome lives on
    // `slice.nav[panelType] = { cursor, scroll, multiSel, filter }`.
    // Transient per-mode editing buffers (the modal sub-models). The
    // reducer owns them; each modal handler is an update branch.
    // `filter` = the live `/`-filter draft (text + which panel is being
    // filtered), distinct from the COMMITTED per-panel filter text that
    // lives on each Navigator's `slice.nav[panel].filter` (Phase 4c).
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
      cmdline: { text: '', sel: 0, matches: [] },
      // Design-mode state lives on the layout Component's slice
      // (Phase 1f) — `getComponentSlice('layout').design`.
    },
    // Framework-level state: parsed config, paths, leader-mode buffers,
    // misc flags. The layout struct + design state + viewMode + focus
    // are on the layout Component's slice (Phase 1; see
    // docs/v0.5-layout-component.md).
    config: null,
    projectDir: '.',
    configPath: '',
    lastRunAction: '',
    focused: true,
    prefixNode: null,
    prefixSeq: [],
    register: null,                  // yank register {history, cap} (register.js)
  };
  // All Phase 1 property shims (model.focus / layoutDirty / panelHeights /
  // panelBounds / modal.design / designEnabled / model.layout) have been
  // swept — callers read/write the layout Component's slice directly via
  // getComponentSlice('layout').<field>.
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

/**
 * Split the cmdline buffer at the first whitespace into the fuzzy-match
 * query and the positional args. Mirrors cmdline.splitQuery (kept there as
 * the canonical, plugin-facing copy + reused by runCommandString/tests);
 * duplicated here because cmdline.js requires runtime (importing it back
 * would cycle) and the parse is a trivial, stable regex.
 */
function _cmdlineSplit(text) {
  const m = text.match(/^(\S*)\s+(.*)$/);
  if (!m) return { query: text, args: [] };
  const rest = m[2].trim();
  return { query: m[1], args: rest ? rest.split(/\s+/) : [] };
}

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
 * Phase 4 (pure-TEA): every branch returns a NEW model object; no
 * in-place writes. The `_withModes` / `_withModal` helpers above keep
 * the spread chains readable. Identity-preserve on no-ops (skip alloc).
 */
function update(model, msg) {
  switch (msg.type) {
    // view_expand / view_shrink / view_set moved to layout's update (Phase 1b).
    // focus_set moved to layout's update (Phase 1c).
    // Call sites dispatch through `panel/api.dispatchMsg` — the layout
    // Component handles these via fan-out.
    // viewer_scroll / stream_start / viewer_append / viewer_set_content /
    // viewer_set_tab / viewer_reset_chrome / viewer_search_* /
    // viewer_add_ephemeral_terminal / viewer_remove_ephemeral_terminal /
    // viewer_add_content_tab / viewer_update_content_tab_lines /
    // viewer_remove_content_tab — all moved to detail.update (Phase B).
    // nav_select retired in Phase 4b — callers use `dispatch.navSelect`
    // directly, which wraps a `set_cursor` Msg to the owning Component
    // and runs the body refresh + groups cascade inline.
    case 'escape': {
      // Esc exits list-select mode (clearing the focused panel's
      // selection), else clears any lingering multi-selection; otherwise
      // a no-op. Phase 4a: the multiSel clear is dispatched into the
      // focused Navigator's update (each panel owns its own Set).
      const focus = route.getFocus();
      const compName = route.componentForPanel(focus);
      const navEntry = compName ? (route.getSlice(compName) || {}).nav : null;
      const had = navEntry && navEntry[focus] && navEntry[focus].multiSel.size > 0;
      if (model.modes.listSelectMode) {
        const next = _withModes(model, { listSelectMode: false });
        if (compName) return [next, [{ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: focus }) }]];
        return [next, []];
      } else if (had) {
        return [model, [{ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: focus }) }]];
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
        if (compName) return [next, [{ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'multisel_clear', panel: focus }) }]];
      }
      return [next, []];
    }
    // (toggle_groups_tab moved to groups.update — Phase C.)
    // (detail-`/`-search Msgs moved to detail.update — Phase B.)
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
      if (nextNode.children) return [{ ...model, prefixNode: nextNode, prefixSeq: seq }, []];  // descend
      // leaf — exit prefix mode and emit the binding
      return [{ ..._withModes(model, { prefixMode: false }), prefixNode: null, prefixSeq: [] },
              [{ type: 'run_binding', run: nextNode.run }]];
    }
    // (toggle_group moved to groups.update — Phase C.)
    // --- Cmd-only verbs: no model change, the reducer just routes the
    // Msg to a Cmd the effects layer runs. Centralizing the Msg→Cmd
    // mapping here is what lets handleAction's arms collapse into update.
    case 'refresh':     return [model, [{ type: 'refresh' }]];
    case 'show_help':   return [model, [{ type: 'show_help' }]];
    case 'next_tab':    return [model, [{ type: 'dispatch_msg', msg: route.wrap('detail', { type: 'tab_cycle', dir: +1 }) }]];
    case 'prev_tab':    return [model, [{ type: 'dispatch_msg', msg: route.wrap('detail', { type: 'tab_cycle', dir: -1 }) }]];
    // --- confirm modal (folded into update). The caller stages a message +
    // a Cmd DESCRIPTOR (the deferred effect as data); `y` re-emits that Cmd,
    // `n`/Esc clears. No closure in the model.
    case 'confirm_enter':
      return [{
        ..._withModes(model, { confirmMode: true }),
        modal: { ...model.modal, confirm: { message: msg.message || 'Are you sure?', cmd: msg.cmd || null } },
      }, []];
    case 'confirm_accept': {
      // T16 — mirror the confirm_reject guard. The accept arm fires
      // the staged Cmd descriptor as a side effect; if a stale
      // double-fire ever landed here with the mode already cleared,
      // a leftover model.modal.confirm.cmd would re-execute against
      // unstaged state. No current path produces such a double-fire,
      // but symmetry with the cancel arm makes the contract robust.
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
      else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        text += msg.seq;
      }
      if (text === p.text) return [model, []];
      return [_withModal(model, { prompt: { ...p, text } }), []];
    }
    case 'prompt_submit': {
      // T16 — mirror prompt_cancel guard; same shape as confirm_accept.
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
      // T16 — guard mirrors the cancel-arm pattern. Same defensive
      // shape as confirm_accept / prompt_submit.
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
      else                          idx = rp.idx + (msg.dir || 0);
      const clamped = _clampRegisterPopup({ idx, scroll: rp.scroll }, n, msg.vh);
      // Value-equal clamps preserve the original ref (callers can still
      // distinguish "nothing changed" from "no-op").
      if (clamped.idx === rp.idx && clamped.scroll === rp.scroll) return [model, []];
      return [_withModal(model, { registerPopup: clamped }), []];
    }
    case 'register_popup_drop': {
      // T16 — gate on the mode flag too. The history-length check
      // below is the value-no-op guard; the flag guard catches a
      // stale double-fire after the popup already closed.
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
      // T16 — mirror cancel-arm guard.
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
        modal: { ...model.modal, cmdline: { text: '', sel: 0, matches: [] } },
      }, [{ type: 'cmdline_rebuild' }]];
    case 'cmdline_set_matches': {
      const c = model.modal.cmdline;
      const matches = msg.matches || [];
      const sel = c.sel > matches.length - 1 ? Math.max(0, matches.length - 1) : c.sel;
      return [_withModal(model, { cmdline: { ...c, matches, sel } }), []];
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
      return [_withModal(model, { cmdline: { ...c, sel } }), []];
    }
    case 'cmdline_key': {
      const c = model.modal.cmdline;
      if (msg.seq === '\t') {
        // Tab accepts the top match into the buffer (refine further), keeping
        // any args already typed past the matched name.
        const top = c.matches[0];
        if (!top) return [model, []];
        const { args } = _cmdlineSplit(c.text);
        const text = top.display.toLowerCase() + (args.length ? ' ' + args.join(' ') : '');
        return [_withModal(model, { cmdline: { ...c, text, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq === '\x7f') {
        return [_withModal(model, { cmdline: { ...c, text: c.text.slice(0, -1), sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        return [_withModal(model, { cmdline: { ...c, text: c.text + msg.seq, sel: 0 } }), [{ type: 'cmdline_rebuild' }]];
      }
      return [model, []];
    }
    case 'cmdline_submit': {
      // T16 — mirror cmdline_cancel guard; symmetric with submit/
      // cancel arms across the other modals.
      if (!model.modes.cmdMode) return [model, []];
      const c = model.modal.cmdline;
      const sel = c.sel;
      const { args } = _cmdlineSplit(c.text);
      const had = c.matches.length > 0;
      const next = {
        ..._withModes(model, { cmdMode: false }),
        modal: { ...model.modal, cmdline: { text: '', sel: 0, matches: [] } },
      };
      // cmdline_run resolves the module-held closure at `sel` + runs it with
      // the parsed args; cmdline_clear drops the held registry afterward.
      return [next, had ? [{ type: 'cmdline_run', sel, args }, { type: 'cmdline_clear' }] : [{ type: 'cmdline_clear' }]];
    }
    case 'cmdline_cancel':
      if (!model.modes.cmdMode) return [model, []];
      return [{
        ..._withModes(model, { cmdMode: false }),
        modal: { ...model.modal, cmdline: { text: '', sel: 0, matches: [] } },
      }, [{ type: 'cmdline_clear' }]];
    // --- design-mode Msgs (post-Phase-6 single-writer cleanup). Every
    // design_* case retired from the reducer; layout.update owns the slice
    // writes now (it calls mdesign.* leaves directly so the writes happen
    // inside layout.update's call stack). Mode-flag flips (designMode /
    // designTitleEditMode) ride back via apply_msg mode_set / mode_clear
    // Cmds the reducer applies. Call sites in dispatch.js, input.js,
    // design.js wrap directly: `dispatchMsg(wrap('layout', { type: 'design_*'}))`.
    // --- terminal mode enter/exit (folded into update). The PTY restart (on
    // a dead session) stays an effect in dispatch.activateTerminal; only the
    // flag write is the Msg. Exit also drops a 'full' auto-zoom back to
    // 'normal' (pure) and asks for a full repaint so the chrome reclaims the
    // cells the PTY painted (the diff cache can't see those).
    case 'terminal_enter':
      return [_withModes(model, { terminalMode: true }), []];
    case 'terminal_exit':
      // viewMode is owned by the layout Component (Phase 1b) — emit a
      // cross-layer dispatch_msg so layout decides whether to drop a
      // 'full' auto-zoom back to 'normal'.
      return [_withModes(model, { terminalMode: false }),
              [{ type: 'dispatch_msg', msg: route.wrap('layout', { type: 'view_drop_full_to_normal' }) }]];
    // multisel_toggle / multisel_select_all retired in Phase 4b — call
    // sites (dispatch.toggleMultiSelOnFocused, selectAllVisible) wrap
    // those Msgs directly to the owning Component now.
    // --- terminal focus events (DEC 1004), folded into update. Pauses/resumes
    // the refresh loop via model.focused; the focus-regain catch-up
    // scheduleRender stays in input.js (an effect decision the caller owns).
    case 'focus_event': {
      const focused = !!msg.focused;
      if (focused === model.focused) return [model, []];
      return [{ ...model, focused }, []];
    }
    // (select_* visual-mode Msgs moved to detail.update — Phase B; the
    //  WRITE side lives with the slice, while select.js's ansi/column reads
    //  stay there as pure helpers.)
    // (viewer_set_content / viewer_set_tab moved to detail.update — Phase B.
    //  state.setDetail / api.setActiveTab still dispatch the same Msgs; they
    //  now route to detail.update via the dispatchMsg fan-out.)
    // set_layout retired (single-writer follow-up): :save-layout and
    // :restore-layout now wrap a `set_arrange` Msg directly to layout —
    // its own update is the single writer for `arrange` and `dirty`.
    // --- command menu (folded into update). Items (action strings, no
    // closures) are built inline from the model on open; nav skips null
    // separators; activate emits a menu_action Cmd routing the chosen verb
    // back through dispatch.handleAction.
    case 'menu_open':
      return [{
        ..._withModes(model, { menuOpen: true }),
        modal: { ...model.modal, menu: { items: menu.buildItems(route.getSlice('layout')), idx: 0 } },
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
      // T16 — mirror menu_close guard.
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
    // --- `/`-filter mode (folded into update). The caller (dispatch)
    // resolves the panel + filterable gate + committed seed text, since the
    // filterable check is plugin-API (can't live in the reducer). The
    // transforms are pure model writes (no plugin API, no Cmd).
    case 'filter_enter':
      return [{
        ..._withModes(model, { filterMode: true }),
        modal: { ...model.modal, filter: { text: msg.text || '', panel: msg.panel } },
      }, []];
    case 'filter_key': {
      const f = model.modal.filter;
      let text = f.text;
      if (msg.seq === '\x7f') {
        if (!text) return [model, []];
        text = text.slice(0, -1);
      } else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32) {
        text = text + msg.seq;
      } else {
        return [model, []];
      }
      const next = _withModal(model, { filter: { ...f, text } });
      // Phase 4a — re-home the cursor as the filter narrows; the panel's
      // nav slice is the writer now.
      const compName = route.componentForPanel(f.panel);
      if (!compName) return [next, []];
      return [next, [{ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'set_cursor', panel: f.panel, index: 0 }) }]];
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
      // Phase 4c — commit/clear the filter on the panel's nav slice; the
      // owning Component is the single writer.
      const filterMsg = (keep && text)
        ? { type: 'set_filter',   panel, text }
        : { type: 'clear_filter', panel };
      return [next, [
        { type: 'dispatch_msg', msg: route.wrap(compName, filterMsg) },
        { type: 'dispatch_msg', msg: route.wrap(compName, { type: 'set_cursor', panel, index: 0 }) },
        { type: 'dispatch_msg', msg: route.wrap(compName, { type: 'set_scroll', panel, offset: 0 }) },
      ]];
    }
    // panel_reset retired in Phase 4b — the resetPanelChrome effect
    // (files Component) now writes the cursor/scroll directly via
    // wrapped Msgs and clears the root-level filter entry itself.
    case 'set_last_run_action': {
      // Routes actions.js's `model.lastRunAction = actionKey` write through
      // update so the actions-panel `>`-marker has a single writer (the
      // reducer). `''` clears (e.g. on group change — the cascade in the
      // groups Component handles this via reset_group_context).
      const lastRunAction = typeof msg.action === 'string' ? msg.action : '';
      if (lastRunAction === model.lastRunAction) return [model, []];
      return [{ ...model, lastRunAction }, []];
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
      // Companion to mode_clear: set a mode flag to true via Msg. Used by the
      // viewer Component's search-enter handler to flip detailSearchMode
      // without writing across layers (the search slice is the viewer's;
      // the mode flag is root chrome). Phase A pattern.
      if (!msg.flag || !(msg.flag in model.modes) || model.modes[msg.flag] === true) return [model, []];
      return [_withModes(model, { [msg.flag]: true }), []];
    case 'set_current_group': {
      // Cross-layer Msg emitted by the groups Component when its tree cascade
      // changes the active group. currentGroup is APP-WIDE chrome (read by
      // actions / docker / files / tabs / etc.) — written through update so
      // every reader sees the same source of truth (Phase C).
      const name = typeof msg.name === 'string' ? msg.name : '';
      if (name === model.currentGroup) return [model, []];
      return [{ ...model, currentGroup: name }, []];
    }
    case 'reset_group_context': {
      // Cross-layer Msg emitted by the groups Component on a group switch —
      // the ROOT chrome half of the old resetGroupContext (per-group sel /
      // filters / multiSel reset, mode flags off, lastRunAction clear). The
      // viewer-slice half rides on viewer_reset_chrome → detail Component
      // (Phase A/B).
      const next = {
        ..._withModes(model, { terminalMode: false, listSelectMode: false }),
        lastRunAction: '',
      };
      // Phase 4a — actions/containers nav state lives on their own
      // Component slices; emit wrapped resets per panel only when the
      // owning Component is registered (tests that don't register
      // actions/docker shouldn't trigger "unknown Component" warnings).
      // Phase 4c — filter text moved onto the same nav slices.
      const cmds = [];
      for (const panel of ['actions', 'containers']) {
        const compName = route.componentForPanel(panel);
        if (!compName) continue;
        cmds.push({ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'set_cursor', panel, index: 0 }) });
        cmds.push({ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'multisel_clear', panel }) });
        cmds.push({ type: 'dispatch_msg', msg: route.wrap(compName, { type: 'clear_filter', panel }) });
      }
      return [next, cmds];
    }
    // set_panel_cursor retired in Phase 4b — groups Component now wraps
    // `set_cursor` to its own slice directly (see _cascadeCmds).
    // (viewer_reset_chrome + viewer_add_ephemeral_terminal /
    //  viewer_remove_ephemeral_terminal / viewer_add_content_tab /
    //  viewer_update_content_tab_lines / viewer_remove_content_tab moved to
    //  detail.update — Phase B. The dispatchers route via dispatchMsg now;
    //  the cross-layer Msgs they emit come back via apply_msg.)
    case 'quit':        return [model, [{ type: 'quit' }]];
    case 'design': {
      // Gated on the --design flag; emit the Cmd only when design is
      // enabled, otherwise no effect. Cross-layer slice read via the
      // route leaf (the same store panel/api uses) — no lazy require.
      const layoutSlice = route.getSlice('layout');
      const enabled = layoutSlice && layoutSlice.design.enabled;
      return [model, enabled ? [{ type: 'start_design' }] : []];
    }
    default:
      return [model, []];
  }
}

module.exports = { init, getModel, setModel, update, _ghostSuffix };
