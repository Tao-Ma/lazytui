/**
 * Copy menu — lazygit-style. Press `y` to popup a menu of copy targets;
 * each plugin contributes options for its panel via `copyOptions(item)`.
 *
 * Contract:
 *   panelDef.copyOptions(item) → [ { label, content } ]
 *   `content` may be a string or a thunk `() => string` (for lazy/expensive
 *   computations like `docker inspect`).
 *
 * State split: nav/idx/open live in the reducer (runtime.update:
 * copy_enter/nav/select/cancel; model.modal.copy holds the render-only
 * {label, cancel} options + idx). The option CONTENT are plugin-provided
 * thunks (closures) — they can't be model data, so the full options stay
 * module-held here and a copy_commit Cmd invokes the selected one by index.
 */
'use strict';

const { getSel } = require('../panel/nav-state');
const { getModel } = require('../model/store');
const { stripMarkup, esc } = require('../io/ansi');
const {getPanelDef, getItems, getInstanceSlice, getFocus } = require('../panel/api');
const route = require('../panel/route');
const { renderOverlay } = require('../leaves/draw');

// Module-held options (label + content thunk + cancel). The reducer mirrors
// only the render-safe {label, cancel} + idx in model.modal.copy; the thunks
// stay here and are resolved by copy_commit (the effect).
let _options = [];

/**
 * Collect copy options from the focused panel's plugin plus a built-in
 * "detail panel content" option when detail has content. Stashes them
 * module-side and returns them (the caller decides 0/1/many).
 */
function collectOptions() {
  const options = [];
  const focus = getFocus();
  const def = getPanelDef(focus);
  if (def && typeof def.copyOptions === 'function' && typeof def.getItems === 'function') {
    const items = getItems(focus);
    const item = items[getSel(focus)];
    if (item) {
      // v0.6.4 Theme A Phase 5 Arc 2 — thread the focused paneId so files'
      // copyOptions resolves THIS pane's container/source. Arity-ignored
      // by single-panel defs.
      const provided = def.copyOptions(item, focus) || [];
      for (const o of provided) {
        if (o && o.label && o.content !== undefined) options.push(o);
      }
    }
  }
  // v0.6.3 T1.4 — paneId-aware lookup (post-Phase B1).
  // P3 (viewer-lines selector) — displayed lines derive via pane-tabs.
  const detailSlice = getInstanceSlice(route.resolveTarget('viewer') || 'detail');
  const _m = getModel();
  const detailLines = detailSlice
    ? require('../leaves/pane-tabs').viewerLines(detailSlice, _m, _m.currentGroup) : [];
  if (detailLines.length > 0) {
    options.push({
      label: 'Detail panel (plain text)',
      content: () => detailLines.map(stripMarkup).join('\n'),
    });
  }
  if (options.length > 0) {
    // Trailing cancel — gives a clear "do nothing" choice in addition to Esc
    options.push({ label: '— Cancel —', cancel: true });
  }
  _options = options;
  return options;
}

// emitOSC52 moved to io/term.js as the single home for terminal
// escape sequences.
const { emitOSC52 } = require('../io/term');

/**
 * Resolve an option's content and copy. content may be a string or a thunk
 * returning a string OR a Promise<string> (slow ops like docker inspect).
 */
function copyOption(opt) {
  if (!opt || opt.cancel) return;
  const content = opt.content;
  if (typeof content !== 'function') {
    if (content) emitOSC52(content);
    return;
  }
  Promise.resolve()
    .then(() => content())
    .then(text => { if (text) emitOSC52(text); })
    .catch(e => console.error('[copy] thunk error:', e && e.message));
}

/** Copy the module-held option at `idx` (the copy_commit Cmd). */
function copySelect(idx) {
  if (idx >= 0 && idx < _options.length) copyOption(_options[idx]);
}

/** Drop the module-held options (after commit/cancel). */
function clearOptions() { _options = []; }

/**
 * Centered popup overlay listing the copy options — reads the render-safe
 * options + idx the reducer mirrors into model.modal.copy.
 */
function renderCopyMenu() {
  if (!getModel().modes.copyMode) return;
  const { options, idx } = getModel().modal.copy;
  const lines = options.map((o, i) => {
    const label = esc(o.label);
    if (i === idx) return `[reverse]  ${label}`;     // selected — reverse
    if (o.cancel) return `  [dim]${label}[/]`;        // dim when unselected
    return `  ${label}`;
  });
  renderOverlay({
    lines, title: 'Copy', maxWidth: 62,
    count: [idx + 1, options.length],
  });
}

module.exports = {
  collectOptions, copyOption, copySelect, clearOptions, renderCopyMenu, emitOSC52,
};
