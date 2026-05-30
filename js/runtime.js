/**
 * Root model + reducer (`update`) + Cmd descriptors.
 *
 * The root model lives here, owned by the runtime. The reducer
 * `update(model, msg) → [model, cmds]` is the single writer for the
 * chrome / modal / config / framework layers; Component slices are
 * written by each Component's own `update`. Cross-layer ops route
 * through `apply_msg` / `dispatch_msg` Cmds (see docs/v0.5-layering.md).
 *
 * Contract:
 *   - Readers use `getModel()` (no global imports).
 *   - All writes to root-model fields flow through `update`. Reducer-
 *     leaves (model-design / model-register / model-menu / model-search /
 *     model-tabs) mutate the slice/model arg in place — intentional;
 *     full immutability was evaluated and skipped (see v0.5-layering.md
 *     §"Skipped").
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
const kb = require('./keybindings');
// Pure command-menu item builder (leaf), so menu_open can build inline.
const menu = require('./model-menu');
// Pure design-mode layout transforms (leaf) — reorder/move/resize/undo, all
// taking `model`, so the reducer owns the design state machine inline.
const mdesign = require('./model-design');
// Pure yank-register transforms (leaf) — push/promote/drop/clear taking
// `model`, so the reducer owns register mutations; OSC52 is an emit_osc52 Cmd.
const mreg = require('./model-register');
// model-tabs + model-search are leaves of the detail Component's update.
// The root reducer doesn't import them directly.

/**
 * The root model.
 *
 * Single owned object; `update` is its single writer. Component slices
 * (detail / groups / docker / files / config-status) live in
 * plugins/api.js's componentSlices map — not here — and are written
 * only by their own `update`.
 *
 * Field map:
 *   - modes{}                        — 13 modal flags (single registry; see modes.js)
 *   - currentGroup                   — current group (chrome)
 *   - ui{ sel, scroll, filters, multiSel } — per-panel chrome (panelType→value)
 *   - modal{ filter, menu, confirm, prompt, copy, registerPopup, cmdline }
 *                                    — modal sub-model editing buffers
 *   - config / projectDir / configPath — parsed config + paths
 *   - lastRunAction / focused / prefixNode / prefixSeq — misc
 *   - register                       — yank register
 *
 * Phase 1 (docs/v0.5-layout-component.md) migrated focus, viewMode,
 * design state, designEnabled, layoutDirty, model.layout (arrange),
 * and panelHeights/panelBounds into the layout Component's slice.
 * Readers use `getComponentSlice('layout').<field>`.
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
    ui: { sel: {}, scroll: {}, filters: {}, multiSel: {} },
    // The viewer slice (detail Component) and groups slice live in
    // plugins/api.js's componentSlices map, accessed via getComponentSlice.
    // Transient per-mode editing buffers (the modal sub-models). The reducer
    // owns them; each modal handler is an update branch. `filter` = the live
    // `/`-filter draft (text + which panel is being filtered), distinct from
    // the COMMITTED per-panel filters in ui.filters.
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

const _model = init();

function getModel() { return _model; }

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
 * reads the terminal size — view-derived, not reducer state). Pure mutation
 * of the {idx, scroll} buffer; mirrors register-popup.js's old _clamp().
 */
function _clampRegisterPopup(rp, n, vh) {
  if (n === 0) { rp.idx = 0; rp.scroll = 0; return; }
  if (rp.idx < 0) rp.idx = 0;
  if (rp.idx >= n) rp.idx = n - 1;
  if (rp.idx < rp.scroll) rp.scroll = rp.idx;
  if (rp.idx >= rp.scroll + vh) rp.scroll = rp.idx - vh + 1;
  if (rp.scroll < 0) rp.scroll = 0;
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
 * Implementation note: there is one shared `_model`, so this mutates and
 * returns it rather than cloning. The signature is the contract callers
 * code against; switching to an immutable copy later wouldn't touch them
 * (skipped by design — see v0.5-layering.md §"Skipped").
 */
function update(model, msg) {
  switch (msg.type) {
    // view_expand / view_shrink / view_set moved to layout's update (Phase 1b).
    // focus_set moved to layout's update (Phase 1c).
    // Call sites dispatch through `plugins/api.dispatchMsg` — the layout
    // Component handles these via fan-out.
    // viewer_scroll / stream_start / viewer_append / viewer_set_content /
    // viewer_set_tab / viewer_reset_chrome / viewer_search_* /
    // viewer_add_ephemeral_terminal / viewer_remove_ephemeral_terminal /
    // viewer_add_content_tab / viewer_update_content_tab_lines /
    // viewer_remove_content_tab — all moved to detail.update (Phase B).
    case 'nav_select':
      // The caller clamped `index` against the panel's item count
      // (getItems is plugin-API/derivation logic — view-side). Storing a
      // plain list panel's selection is a pure model write. The groups
      // panel cascades (currentGroup + per-group context reset) — run by
      // the groups Component as a follow-up to dispatch_msg.
      // Either way the detail body refreshes for the new row.
      // Uniform write across panels (Phase C): just store the index. For
      // 'groups', additionally dispatch_msg → groups Component, which owns
      // the cascade (currentGroup + per-group root-chrome reset + viewer
      // reset) and emits the appropriate Cmds.
      model.ui.sel[msg.panel] = msg.index;
      if (msg.panel === 'groups') {
        return [model, [
          { type: 'show_selected_info' },
          { type: 'dispatch_msg', msg: require('./plugins/api').wrap('groups', { type: 'groups_selected', index: msg.index }) },
        ]];
      }
      return [model, [{ type: 'show_selected_info' }]];
    case 'escape': {
      // Esc exits list-select mode (clearing the focused panel's
      // selection), else clears any lingering multi-selection; otherwise
      // a no-op. Clearing a multi-selection is `delete model.ui.multiSel
      // [panel]` — a pure model write, so it lives here (no Cmd).
      const focus = require('./plugins/api').getComponentSlice('layout').focus;
      if (model.modes.listSelectMode) {
        model.modes.listSelectMode = false;
        delete model.ui.multiSel[focus];
      } else if ((model.ui.multiSel[focus] && model.ui.multiSel[focus].size) > 0) {
        delete model.ui.multiSel[focus];
      }
      return [model, []];
    }
    case 'list_select': {
      // `mode:'toggle'` (v) flips list-select; turning it off drops the
      // operand selection. `mode:'on'` (*) forces it on (the caller then
      // fires selectAllVisible as an effect). The _isListPanel guard is
      // view derivation — the caller already applied it.
      const focus = require('./plugins/api').getComponentSlice('layout').focus;
      if (msg.mode === 'on') {
        model.modes.listSelectMode = true;
      } else {
        model.modes.listSelectMode = !model.modes.listSelectMode;
        if (!model.modes.listSelectMode) delete model.ui.multiSel[focus];
      }
      return [model, []];
    }
    // (toggle_groups_tab moved to groups.update — Phase C.)
    // (detail-`/`-search Msgs moved to detail.update — Phase B.)
    case 'enter_prefix':
      // Leader pressed — arm prefix mode at the binding-tree root. All of
      // prefixMode/prefixNode/prefixSeq are model-resident, so this is a
      // pure model write (the first modal mode folded into update).
      model.modes.prefixMode = true;
      model.prefixNode = kb.rootNode();
      model.prefixSeq = [];
      return [model, []];
    case 'prefix_key': {
      // Walk the leader tree. Esc / a second leader press cancels. An
      // unbound token silently drops out. A subtree descends (stay armed);
      // a leaf exits + emits a run_binding Cmd carrying the thunk (a Cmd is
      // a thunk the effects layer runs — TEA-shaped). kb.resolve is a pure
      // read of the leaf registry, so the whole branch stays a model write.
      const cancel = () => { model.modes.prefixMode = false; model.prefixNode = null; model.prefixSeq = []; };
      if (msg.key === 'escape' || msg.seq === ' ' || msg.key === ' ') { cancel(); return [model, []]; }
      const tok = kb.tokenForEvent(msg.key, msg.seq);
      const next = kb.resolve(model.prefixNode, tok);
      if (!next) { cancel(); return [model, []]; }
      model.prefixSeq = model.prefixSeq.concat(tok);
      if (next.children) { model.prefixNode = next; return [model, []]; }  // descend
      cancel();
      return [model, [{ type: 'run_binding', run: next.run }]];
    }
    // (toggle_group moved to groups.update — Phase C.)
    // --- Cmd-only verbs: no model change, the reducer just routes the
    // Msg to a Cmd the effects layer runs. Centralizing the Msg→Cmd
    // mapping here is what lets handleAction's arms collapse into update.
    case 'refresh':     return [model, [{ type: 'refresh' }]];
    case 'show_help':   return [model, [{ type: 'show_help' }]];
    case 'next_tab':    return [model, [{ type: 'run_tab', dir: +1 }]];
    case 'prev_tab':    return [model, [{ type: 'run_tab', dir: -1 }]];
    // --- confirm modal (folded into update). The caller stages a message +
    // a Cmd DESCRIPTOR (the deferred effect as data); `y` re-emits that Cmd,
    // `n`/Esc clears. No closure in the model.
    case 'confirm_enter':
      model.modes.confirmMode = true;
      model.modal.confirm = { message: msg.message || 'Are you sure?', cmd: msg.cmd || null };
      return [model, []];
    case 'confirm_accept': {
      const cmd = model.modal.confirm.cmd;
      model.modes.confirmMode = false;
      model.modal.confirm = { message: '', cmd: null };
      return [model, cmd ? [cmd] : []];
    }
    case 'confirm_reject':
      model.modes.confirmMode = false;
      model.modal.confirm = { message: '', cmd: null };
      return [model, []];
    // --- args prompt (folded into update). Same Cmd-descriptor pattern as
    // confirm: the caller stages a base do_run Cmd; submit parses args from
    // the typed text and merges them in before emitting. The ghost is seeded
    // by the caller (reading the yank register, which the reducer can't).
    case 'prompt_enter':
      model.modes.promptMode = true;
      model.modal.prompt = {
        label: msg.label || 'Input', spec: msg.spec || '',
        text: typeof msg.text === 'string' ? msg.text : '',
        ghost: msg.ghost || '', cmd: msg.cmd || null,
      };
      return [model, []];
    case 'prompt_key': {
      const p = model.modal.prompt;
      if (msg.seq === '\x09' || msg.key === 'right') {       // accept ghost suffix
        const tail = _ghostSuffix(p.text, p.ghost);
        if (tail) p.text += tail;
      } else if (msg.seq === '\x7f') { p.text = p.text.slice(0, -1); }  // backspace
      else if (msg.seq === '\x15') { p.text = ''; }                     // Ctrl+U
      else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        p.text += msg.seq;
      }
      return [model, []];
    }
    case 'prompt_submit': {
      const p = model.modal.prompt;
      const text = p.text;
      const cmd = p.cmd;
      model.modes.promptMode = false;
      model.modal.prompt = { label: '', spec: '', text: '', ghost: '', cmd: null };
      const args = text.trim() ? text.trim().split(/\s+/) : [];
      return [model, cmd ? [{ ...cmd, args }] : []];
    }
    case 'prompt_cancel':
      model.modes.promptMode = false;
      model.modal.prompt = { label: '', spec: '', text: '', ghost: '', cmd: null };
      return [model, []];
    // --- copy menu (folded into update; the content thunks stay module-held,
    // resolved by the copy_commit Cmd — decision-A copy-split).
    case 'copy_enter':
      model.modes.copyMode = true;
      model.modal.copy = { options: msg.options || [], idx: 0 };
      return [model, []];
    case 'copy_nav': {
      const c = model.modal.copy;
      if (!c.options.length) return [model, []];
      c.idx = (c.idx + msg.dir + c.options.length) % c.options.length;
      return [model, []];
    }
    case 'copy_select': {
      const idx = model.modal.copy.idx;
      model.modes.copyMode = false;
      model.modal.copy = { options: [], idx: 0 };
      return [model, [{ type: 'copy_commit', idx }]];
    }
    case 'copy_cancel':
      model.modes.copyMode = false;
      model.modal.copy = { options: [], idx: 0 };
      return [model, [{ type: 'copy_commit', idx: -1 }]];  // -1 = clear, no copy
    // --- register-history popup (`"`, folded into update). The reducer owns
    // the cursor/scroll (model.modal.registerPopup) + the mode flag AND the
    // history mutation (via the model-register leaf); OSC52 is the only effect,
    // emitted as an emit_osc52 Cmd. `vh` (viewport height) is caller-resolved
    // since it reads the terminal size.
    case 'register_popup_enter':
      model.modes.registerPopupMode = true;
      model.modal.registerPopup = { idx: 0, scroll: 0 };
      return [model, []];
    case 'register_popup_nav': {
      const rp = model.modal.registerPopup;
      const n = model.register.history.length;
      if (msg.to === 'top') rp.idx = 0;
      else if (msg.to === 'bottom') rp.idx = n - 1;
      else rp.idx += (msg.dir || 0);
      _clampRegisterPopup(rp, n, msg.vh);
      return [model, []];
    }
    case 'register_popup_drop': {
      const rp = model.modal.registerPopup;
      if (model.register.history.length === 0) return [model, []];
      // Drop in-place via the leaf, then clamp the cursor against the ACTUAL
      // new length (idx stays on the row the next-older entry slides into).
      mreg.drop(model, rp.idx);
      _clampRegisterPopup(rp, model.register.history.length, msg.vh);
      if (model.register.history.length === 0) model.modes.registerPopupMode = false;
      // force_full_repaint reclaims the row the shrunk overlay no longer covers
      // (the main diff can't see the overlay geometry).
      return [model, [{ type: 'force_full_repaint' }]];
    }
    case 'register_popup_commit': {
      const idx = model.modal.registerPopup.idx;
      const n = model.register.history.length;
      model.modes.registerPopupMode = false;
      model.modal.registerPopup = { idx: 0, scroll: 0 };
      if (n === 0) return [model, []];
      // idx>0 promotes the entry to top; idx===0 re-emits the current top so
      // opening the popup just to copy it still refreshes the OS clipboard.
      const v = idx > 0 ? mreg.promote(model, idx) : (model.register.history[0] || '');
      return [model, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    // --- yank-register push (folded into update). select.commit + any other
    // app yank emits this; the leaf does the dedup/cap, OSC52 rides out as a
    // Cmd. register.js keeps direct wrappers over the leaf for the test API.
    case 'register_push': {
      const v = mreg.push(model, msg.text);
      return [model, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    case 'register_popup_cancel':
      model.modes.registerPopupMode = false;
      model.modal.registerPopup = { idx: 0, scroll: 0 };
      return [model, []];
    // --- `:` cmdline (folded into update). The reducer owns text + sel + the
    // render-safe match list (model.modal.cmdline); the run closures stay
    // module-held in cmdline.js. Any text change emits a cmdline_rebuild Cmd
    // — the effects layer rebuilds the registry from the plugin facade (which
    // the pure reducer can't touch) and re-applies cmdline_set_matches with
    // the render-safe projection. That Cmd→Msg writeback keeps the reducer
    // the single writer of model state while the effect supplies the data.
    case 'cmdline_enter':
      model.modes.cmdMode = true;
      model.modal.cmdline = { text: '', sel: 0, matches: [] };
      return [model, [{ type: 'cmdline_rebuild' }]];
    case 'cmdline_set_matches': {
      const c = model.modal.cmdline;
      c.matches = msg.matches || [];
      if (c.sel > c.matches.length - 1) c.sel = Math.max(0, c.matches.length - 1);
      return [model, []];
    }
    case 'cmdline_nav': {
      const c = model.modal.cmdline;
      // up (dir>0) walks toward worse matches (higher idx); down (dir<0) walks
      // back toward the best match at idx 0 — the dropdown paints best-nearest-
      // the-prompt, so the visual "up" is a higher index.
      if (msg.dir > 0) c.sel = Math.min(c.sel + 1, c.matches.length - 1);
      else             c.sel = Math.max(0, c.sel - 1);
      return [model, []];
    }
    case 'cmdline_key': {
      const c = model.modal.cmdline;
      if (msg.seq === '\t') {
        // Tab accepts the top match into the buffer (refine further), keeping
        // any args already typed past the matched name.
        const top = c.matches[0];
        if (!top) return [model, []];
        const { args } = _cmdlineSplit(c.text);
        c.text = top.display.toLowerCase() + (args.length ? ' ' + args.join(' ') : '');
        c.sel = 0;
        return [model, [{ type: 'cmdline_rebuild' }]];
      }
      if (msg.seq === '\x7f') { c.text = c.text.slice(0, -1); c.sel = 0; return [model, [{ type: 'cmdline_rebuild' }]]; }
      if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32 && msg.seq.charCodeAt(0) < 127) {
        c.text += msg.seq; c.sel = 0;
        return [model, [{ type: 'cmdline_rebuild' }]];
      }
      return [model, []];
    }
    case 'cmdline_submit': {
      const c = model.modal.cmdline;
      const sel = c.sel;
      const { args } = _cmdlineSplit(c.text);
      const had = c.matches.length > 0;
      model.modes.cmdMode = false;
      model.modal.cmdline = { text: '', sel: 0, matches: [] };
      // cmdline_run resolves the module-held closure at `sel` + runs it with
      // the parsed args; cmdline_clear drops the held registry afterward.
      return [model, had ? [{ type: 'cmdline_run', sel, args }, { type: 'cmdline_clear' }] : [{ type: 'cmdline_clear' }]];
    }
    case 'cmdline_cancel':
      model.modes.cmdMode = false;
      model.modal.cmdline = { text: '', sel: 0, matches: [] };
      return [model, [{ type: 'cmdline_clear' }]];
    // --- design mode keyboard + title edit (folded into update). All the
    // layout mutations are pure transforms in the model-design leaf taking
    // `model`; the reducer just routes each key to one. The mouse drag/resize
    // path still lives in design.js (reads the model) until a later commit.
    case 'design_enter': {
      // Reset the working state on entry but preserve `enabled` (the
      // boot-time --design CLI flag).
      model.modes.designMode = true;
      const slice = require('./plugins/api').getComponentSlice('layout');
      if (slice) {
        const enabled = slice.design && slice.design.enabled;
        slice.design = { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } };
      }
      return [model, []];
    }
    case 'design_nav':          mdesign.navSelect(model, msg.dir);          return [model, []];
    case 'design_reorder':      mdesign.reorderWithin(model, msg.dir);  mdesign.clampSelected(model); return [model, []];
    case 'design_move_col':     mdesign.moveColumn(model, msg.col);     mdesign.clampSelected(model); return [model, []];
    case 'design_resize':       mdesign.resizeWidthOrDetail(model, msg.delta); return [model, []];
    case 'design_panel_height': mdesign.resizeFocusedPanelHeight(model, msg.delta); return [model, []];
    case 'design_undo':         mdesign.undo(model); mdesign.clampSelected(model); return [model, []];
    case 'design_redo':         mdesign.redo(model); mdesign.clampSelected(model); return [model, []];
    case 'design_exit':
      // Exit keeps the mutated layout (save is the separate :save-layout verb)
      // and clears the editor state. show_selected_info refreshes detail for
      // the now-active panel (the old onDone callback, now a Cmd).
      model.modes.designMode = false;
      model.modes.designTitleEditMode = false;
      {
        const slice = require('./plugins/api').getComponentSlice('layout');
        if (slice) {
          const enabled = slice.design && slice.design.enabled;
          slice.design = { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } };
        }
      }
      return [model, [{ type: 'show_selected_info' }]];
    case 'design_title_enter':
      mdesign.titleEnter(model);
      model.modes.designTitleEditMode = true;
      return [model, []];
    case 'design_title_key': {
      const slice = require('./plugins/api').getComponentSlice('layout');
      const te = slice && slice.design && slice.design.titleEdit;
      if (!te) return [model, []];
      if (msg.key === 'backspace' || msg.seq === '\x7f' || msg.seq === '\b') { te.text = te.text.slice(0, -1); return [model, []]; }
      if (msg.seq && msg.seq.length === 1 && msg.seq >= ' ' && msg.seq < '\x7f') { te.text += msg.seq; return [model, []]; }
      return [model, []];
    }
    case 'design_title_submit': {
      const slice = require('./plugins/api').getComponentSlice('layout');
      const text = slice && slice.design ? slice.design.titleEdit.text : '';
      mdesign.setSelectedTitle(model, text);
      model.modes.designTitleEditMode = false;
      if (slice && slice.design) slice.design.titleEdit = { active: false, text: '' };
      return [model, []];
    }
    case 'design_title_cancel': {
      model.modes.designTitleEditMode = false;
      const slice = require('./plugins/api').getComponentSlice('layout');
      if (slice && slice.design) slice.design.titleEdit = { active: false, text: '' };
      return [model, []];
    }
    // --- design mode mouse drag/resize (folded into update). The gesture
    // state machine runs in the model-design leaf against model.modal.design
    // .drag; `cols` (terminal width) is caller-resolved (input.js) since it's
    // the one terminal read the reducer can't do. No Cmds — the input pump's
    // trailing render paints the live drag/resize.
    case 'design_mouse_press':   mdesign.mousePress(model, msg.mx, msg.my, msg.cols);  return [model, []];
    case 'design_mouse_motion':  mdesign.mouseMotion(model, msg.mx, msg.my, msg.cols); return [model, []];
    case 'design_mouse_release': mdesign.mouseRelease(model);                          return [model, []];
    // --- terminal mode enter/exit (folded into update). The PTY restart (on
    // a dead session) stays an effect in dispatch.activateTerminal; only the
    // flag write is the Msg. Exit also drops a 'full' auto-zoom back to
    // 'normal' (pure) and asks for a full repaint so the chrome reclaims the
    // cells the PTY painted (the diff cache can't see those).
    case 'terminal_enter':
      model.modes.terminalMode = true;
      return [model, []];
    case 'terminal_exit': {
      // viewMode is owned by the layout Component (Phase 1b) — emit a
      // cross-layer dispatch_msg so layout decides whether to drop a
      // 'full' auto-zoom back to 'normal'. The conditional + the
      // repaint Cmd both live in layout's update.
      model.modes.terminalMode = false;
      return [model, [{ type: 'dispatch_msg', msg: require('./plugins/api').wrap('layout', { type: 'view_drop_full_to_normal' }) }]];
    }
    // --- multi-selection writes (folded into update). The caller resolves the
    // operand IDs from the plugin facade (idOf/getItems — effects) and passes
    // them in; the reducer owns the model.ui.multiSel[panel] Set. Mirrors the
    // state.js toggleMultiSel semantics (drop the panel key when the set empties
    // so multiSelCount/render treat "no selection" uniformly).
    case 'multisel_toggle': {
      const ms = model.ui.multiSel;
      if (!ms[msg.panel]) ms[msg.panel] = new Set();
      const set = ms[msg.panel];
      if (set.has(msg.id)) set.delete(msg.id);
      else set.add(msg.id);
      if (set.size === 0) delete ms[msg.panel];
      return [model, []];
    }
    case 'multisel_select_all': {
      const ms = model.ui.multiSel;
      if (!ms[msg.panel]) ms[msg.panel] = new Set();
      const set = ms[msg.panel];
      for (const id of msg.ids) set.add(id);
      if (set.size === 0) delete ms[msg.panel];
      return [model, []];
    }
    // --- terminal focus events (DEC 1004), folded into update. Pauses/resumes
    // the refresh loop via model.focused; the focus-regain catch-up
    // scheduleRender stays in input.js (an effect decision the caller owns).
    case 'focus_event':
      model.focused = !!msg.focused;
      return [model, []];
    // (select_* visual-mode Msgs moved to detail.update — Phase B; the
    //  WRITE side lives with the slice, while select.js's ansi/column reads
    //  stay there as pure helpers.)
    // (viewer_set_content / viewer_set_tab moved to detail.update — Phase B.
    //  state.setDetail / api.setActiveTab still dispatch the same Msgs; they
    //  now route to detail.update via the dispatchMsg fan-out.)
    case 'set_layout': {
      // :save-layout clears the dirty flag; :restore-layout replaces the
      // arrange struct (rebuilt from config by the caller) and clears dirty.
      // Both write into the layout Component's slice (Phase 1d/1g).
      const layoutSlice = require('./plugins/api').getComponentSlice('layout');
      if (layoutSlice) {
        if (msg.layout !== undefined) layoutSlice.arrange = msg.layout;
        if (msg.dirty  !== undefined) layoutSlice.dirty   = !!msg.dirty;
      }
      return [model, []];
    }
    // --- command menu (folded into update). Items (action strings, no
    // closures) are built inline from the model on open; nav skips null
    // separators; activate emits a menu_action Cmd routing the chosen verb
    // back through dispatch.handleAction.
    case 'menu_open': {
      const mm = model.modal.menu;
      mm.items = menu.buildItems(model);
      mm.idx = 0;
      model.modes.menuOpen = true;
      return [model, []];
    }
    case 'menu_close': {
      const mm = model.modal.menu;
      model.modes.menuOpen = false;
      mm.items = []; mm.idx = 0;
      return [model, []];
    }
    case 'menu_nav': {
      const mm = model.modal.menu;
      const items = mm.items;
      let i = mm.idx + (msg.dir < 0 ? -1 : 1);
      if (msg.dir < 0) { while (i >= 0 && items[i] === null) i--; if (i < 0) return [model, []]; }
      else { while (i < items.length && items[i] === null) i++; if (i >= items.length) return [model, []]; }
      mm.idx = i;
      return [model, []];
    }
    case 'menu_activate': {
      const mm = model.modal.menu;
      const item = mm.items[mm.idx];
      model.modes.menuOpen = false;
      mm.items = []; mm.idx = 0;
      if (!item) return [model, []];
      return [model, [{ type: 'menu_action', action: item[1] }]];
    }
    // --- `/`-filter mode (folded into update). The caller (dispatch)
    // resolves the panel + filterable gate + committed seed text, since the
    // filterable check is plugin-API (can't live in the reducer). The
    // transforms are pure model writes (no plugin API, no Cmd).
    case 'filter_enter':
      model.modes.filterMode = true;
      model.modal.filter.text = msg.text || '';
      model.modal.filter.panel = msg.panel;
      return [model, []];
    case 'filter_key': {
      const f = model.modal.filter;
      if (msg.seq === '\x7f') {
        if (!f.text) return [model, []];
        f.text = f.text.slice(0, -1);
      } else if (msg.seq && msg.seq.length === 1 && msg.seq.charCodeAt(0) >= 32) {
        f.text += msg.seq;
      } else {
        return [model, []];
      }
      model.ui.sel[f.panel] = 0;  // re-home the cursor as the filter narrows
      return [model, []];
    }
    case 'filter_exit': {
      const f = model.modal.filter;
      const panel = f.panel;
      if (msg.keep && f.text) model.ui.filters[panel] = f.text;
      else                    delete model.ui.filters[panel];
      model.modes.filterMode = false;
      f.text = ''; f.panel = '';
      if (panel) { model.ui.sel[panel] = 0; model.ui.scroll[panel] = 0; }
      return [model, []];
    }
    case 'panel_reset': {
      // Re-home a panel's framework chrome (cursor/scroll/filter). The files
      // Component emits this (via the resetPanelChrome effect) on directory
      // navigation — it owns its slice but not model.ui, so the reset routes
      // through update to keep the reducer the single writer.
      const p = msg.panel;
      if (p) {
        model.ui.sel[p] = 0;
        model.ui.scroll[p] = 0;
        delete model.ui.filters[p];
      }
      return [model, []];
    }
    case 'set_last_run_action':
      // Routes actions.js's `model.lastRunAction = actionKey` write through
      // update so the actions-panel `>`-marker has a single writer (the
      // reducer). `''` clears (e.g. on group change — the cascade in the
      // groups Component handles this via reset_group_context).
      model.lastRunAction = typeof msg.action === 'string' ? msg.action : '';
      return [model, []];
    case 'mode_clear':
      // Defensive: clear a single mode flag. Used by dispatch's wedge-guard
      // when a mode handler throws — without this, the failing modal traps
      // every subsequent key (Esc included) in the same throwing handler.
      // Routed through update so even the panic-recovery path stays single-
      // writer; falls back to no-op if the flag isn't a registered mode.
      if (msg.flag && msg.flag in model.modes) model.modes[msg.flag] = false;
      return [model, []];
    case 'mode_set':
      // Companion to mode_clear: set a mode flag to true via Msg. Used by the
      // viewer Component's search-enter handler to flip detailSearchMode
      // without writing across layers (the search slice is the viewer's;
      // the mode flag is root chrome). Phase A pattern.
      if (msg.flag && msg.flag in model.modes) model.modes[msg.flag] = true;
      return [model, []];
    case 'set_current_group':
      // Cross-layer Msg emitted by the groups Component when its tree cascade
      // changes the active group. currentGroup is APP-WIDE chrome (read by
      // actions / docker / files / tabs / etc.) — written through update so
      // every reader sees the same source of truth (Phase C).
      model.currentGroup = typeof msg.name === 'string' ? msg.name : '';
      return [model, []];
    case 'reset_group_context':
      // Cross-layer Msg emitted by the groups Component on a group switch —
      // the ROOT chrome half of the old resetGroupContext (per-group sel /
      // filters / multiSel reset, mode flags off, lastRunAction clear). The
      // viewer-slice half rides on viewer_reset_chrome → detail Component
      // (Phase A/B).
      model.ui.sel.actions = 0;
      model.ui.sel.containers = 0;
      model.lastRunAction = '';
      delete model.ui.filters.actions;
      delete model.ui.filters.containers;
      delete model.ui.multiSel.actions;
      delete model.ui.multiSel.containers;
      model.modes.terminalMode = false;
      model.modes.listSelectMode = false;
      return [model, []];
    case 'set_panel_cursor':
      // Plain panel-cursor write (no nav_select cascade). Used by the groups
      // Component to adjust ui.sel.groups after a tree-shape change without
      // re-triggering the nav_select → groups_selected cycle.
      if (msg.panel) model.ui.sel[msg.panel] = msg.index | 0;
      return [model, []];
    // (viewer_reset_chrome + viewer_add_ephemeral_terminal /
    //  viewer_remove_ephemeral_terminal / viewer_add_content_tab /
    //  viewer_update_content_tab_lines / viewer_remove_content_tab moved to
    //  detail.update — Phase B. The dispatchers route via dispatchMsg now;
    //  the cross-layer Msgs they emit come back via apply_msg.)
    case 'quit':        return [model, [{ type: 'quit' }]];
    case 'design': {
      // Gated on the --design flag; emit the Cmd only when design is
      // enabled, otherwise no effect.
      const layoutSlice = require('./plugins/api').getComponentSlice('layout');
      const enabled = layoutSlice && layoutSlice.design.enabled;
      return [model, enabled ? [{ type: 'start_design' }] : []];
    }
    default:
      return [model, []];
  }
}

module.exports = { init, getModel, update, _ghostSuffix };
