/**
 * While the TUI owns the screen, stderr and stdout ARE the screen: a
 * `console.error` from a render path (a pane whose render throws, a view
 * contribution, the compositor's flat-modal warning), a key handler or a timer
 * lands at the hardware cursor in the middle of a frame — after the `:` prompt,
 * over a border — and its `\n` on the last row scrolls the whole screen up. The
 * cell diff still believes the old rows are on screen, so nothing repairs it,
 * and a per-frame error scrolls one more line every frame.
 *
 * install() routes console.error / warn / log into the diagnostics log
 * (io/diag-log, the `leader e` window) for as long as the TUI holds the screen;
 * restore() puts them back (cleanup, before the process prints to the shell).
 * The deferred lane is used because a caller may be inside render (recording
 * synchronously would dispatch from inside the frame being drawn); the dispatch
 * finalizer drains it. Each distinct message is recorded once — a render error
 * repeats every frame.
 *
 * Only the TUI entry (app/tui.js) installs it: the CLI paths (--list, --exec,
 * --keymap …), the headless harness and the tests keep a real console.
 */
'use strict';

const util = require('util');

const _METHODS = { error: 'error', warn: 'warn', log: 'info' };
const _SEEN_CAP = 1000;

let _saved = null;
let _seen = new Set();

function _capture(level, args) {
  let message;
  try { message = util.format(...args); } catch (_) { message = String(args[0]); }
  if (_seen.has(message)) return;
  if (_seen.size >= _SEEN_CAP) _seen = new Set();
  _seen.add(message);
  // A bracketed `[source]` prefix becomes the code; the rest is the message.
  const m = /^\[([^\]\n]{1,40})\]\s*/.exec(message);
  const code = m ? m[1] : 'console';
  try { require('./diag-log').recordDeferred(level, code, m ? message.slice(m[0].length) : message); }
  catch (_) { /* diag-log unavailable — drop rather than write to the screen */ }
}

function install() {
  if (_saved) return;
  _saved = {};
  for (const [method, level] of Object.entries(_METHODS)) {
    _saved[method] = console[method];
    console[method] = (...args) => _capture(level, args);
  }
}

function restore() {
  if (!_saved) return;
  for (const method of Object.keys(_saved)) console[method] = _saved[method];
  _saved = null;
  _seen = new Set();
}

function installed() { return !!_saved; }

module.exports = { install, restore, installed };
