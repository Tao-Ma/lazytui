/**
 * Copy menu — lazygit-style. Press `y` to popup a menu of copy targets;
 * each plugin contributes options for its panel via `copyOptions(item, S)`.
 *
 * Contract:
 *   panelDef.copyOptions(item, S) → [ { label, content } ]
 *   `content` may be a string or a thunk `() => string` (for lazy/expensive
 *   computations like `docker inspect`).
 *
 * Zero dependencies (uses local modules).
 */
'use strict';

const { S, getSel } = require('./state');
const { stripMarkup, esc } = require('./ansi');
const { stdout } = require('./term');
const { getPanelDef, getItems } = require('./plugins/api');
const { renderOverlay } = require('./panel');

// Module-private mode state. S.copyMode (a flag) stays on S so the
// render conductor can detect "an overlay is active" for force-full-
// repaint logic; the buffers (options + selected index) are transient
// per-popup state and live here.
let _options = [];
let _idx = 0;

/**
 * Collect copy options from the focused panel's plugin plus a built-in
 * "detail panel content" option when detail has content.
 */
function collectOptions() {
  const options = [];
  const def = getPanelDef(S.focus);
  if (def && typeof def.copyOptions === 'function' && typeof def.getItems === 'function') {
    const items = getItems(S.focus, S);
    const item = items[getSel(S.focus)];
    if (item) {
      const provided = def.copyOptions(item, S) || [];
      for (const o of provided) {
        if (o && o.label && o.content !== undefined) options.push(o);
      }
    }
  }
  if (S.detailLines.length > 0) {
    options.push({
      label: 'Detail panel (plain text)',
      content: () => S.detailLines.map(stripMarkup).join('\n'),
    });
  }
  if (options.length > 0) {
    // Trailing cancel — gives a clear "do nothing" choice in addition to Esc
    options.push({ label: '— Cancel —', cancel: true });
  }
  return options;
}

/** Emit OSC52 clipboard escape sequence. */
function emitOSC52(text) {
  if (typeof text !== 'string' || !text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  stdout.write(`\x1b]52;c;${b64}\x07`);
}

/**
 * Resolve an option's content and copy. content may be a string or a thunk
 * returning a string OR a Promise<string> (for slow ops like docker inspect).
 * Async thunks don't block the event loop — copy happens when ready.
 */
function copyOption(opt) {
  if (!opt || opt.cancel) return;
  const content = opt.content;
  if (typeof content !== 'function') {
    if (content) emitOSC52(content);
    return;
  }
  // Promise.resolve handles both sync- and Promise-returning thunks
  Promise.resolve()
    .then(() => content())
    .then(text => { if (text) emitOSC52(text); })
    .catch(e => console.error('[copy] thunk error:', e && e.message));
}

/**
 * Press `y` entry point. Returns true if a popup was opened (caller
 * should render); returns false if direct-copied or no-op.
 */
function enterCopy() {
  const opts = collectOptions();
  if (!opts.length) return false;
  if (opts.length === 1) { copyOption(opts[0]); return false; }
  S.copyMode = true;
  _options = opts;
  _idx = 0;
  return true;
}

function exitCopy(commit) {
  if (commit && _options[_idx]) copyOption(_options[_idx]);
  S.copyMode = false;
  _options = [];
  _idx = 0;
}

function navCopy(delta) {
  if (!S.copyMode) return;
  const len = _options.length;
  if (!len) return;
  _idx = (_idx + delta + len) % len;
}

/**
 * Centered popup overlay listing the copy options. Rendered after the
 * main render so it appears on top.
 */
function renderCopyMenu() {
  if (!S.copyMode) return;
  const lines = _options.map((o, i) => {
    const label = esc(o.label);
    if (i === _idx) return `[reverse]  ${label}`;            // selected — plain text in reverse
    if (o.cancel) return `  [dim]${label}[/]`;                // dim when unselected
    return `  ${label}`;
  });
  renderOverlay({
    lines, title: 'Copy', maxWidth: 62,
    count: [_idx + 1, _options.length],
  });
}

module.exports = {
  collectOptions, enterCopy, exitCopy, navCopy, renderCopyMenu, emitOSC52,
};
