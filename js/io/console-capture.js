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
 * synchronously would dispatch from inside the frame being drawn); it is
 * drained on the next turn of the event loop (after the frame, whatever lane
 * the next Msg takes — the diagnostics window's own ticks don't run the
 * dispatch finalizer). Each distinct message is recorded once — a render error
 * repeats every frame — and again after the log is cleared (the problem the
 * user cleared away may still be there).
 *
 * Only the TUI entry (app/tui.js) installs it — before the boot-time config
 * warnings (`keys:`, `keymap:`, `context-menu:`), which the first frame would
 * wipe from the terminal; a boot that exits on a fatal config error replays
 * them (restore({ replay: true })). The CLI paths (--list, --exec, --keymap …),
 * the headless harness and the tests keep a real console.
 */
'use strict';

const util = require('util');

const _METHODS = { error: 'error', warn: 'warn', log: 'info' };
const _SEEN_CAP = 1000;

let _saved = null;
let _held = [];           // what was captured since install, for restore({ replay })
let _seen = new Set();
let _seenClears = 0;      // diag-log clears() when _seen was last valid
let _flushQueued = false;

function _capture(level, args) {
  let diag;
  try { diag = require('./diag-log'); } catch (_) { return; }   // unavailable — drop rather than write to the screen
  let message;
  try { message = util.format(...args); } catch (_) { message = String(args[0]); }
  if (diag.clears() !== _seenClears) { _seen = new Set(); _seenClears = diag.clears(); }
  if (_seen.has(message)) return;
  if (_seen.size >= _SEEN_CAP) _seen = new Set();
  _seen.add(message);
  // A bracketed `[source]` prefix becomes the code; the rest is the message.
  const m = /^\[([^\]\n]{1,40})\]\s*/.exec(message);
  diag.recordDeferred(level, m ? m[1] : 'console', m ? message.slice(m[0].length) : message);
  if (_held.length < _SEEN_CAP) _held.push([level, message]);
  if (!_flushQueued) {
    _flushQueued = true;
    setImmediate(() => { _flushQueued = false; diag.flushDeferred(); });
  }
}

function install() {
  if (_saved) return;
  _saved = {};
  for (const [method, level] of Object.entries(_METHODS)) {
    _saved[method] = console[method];
    console[method] = (...args) => _capture(level, args);
  }
}

/** Put console back. `replay: true` also prints what was captured since
 *  install — for a boot that exits before it ever drew (a fatal config error):
 *  its warnings would otherwise be in a diagnostics log nobody sees. */
function restore({ replay = false } = {}) {
  if (!_saved) return;
  for (const method of Object.keys(_saved)) console[method] = _saved[method];
  _saved = null;
  const held = _held;
  _held = [];
  _seen = new Set();
  if (replay) for (const [level, message] of held) (level === 'info' ? console.log : console.error)(message);
}

function installed() { return !!_saved; }

module.exports = { install, restore, installed };
