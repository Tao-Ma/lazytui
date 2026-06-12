/**
 * Diagnostics log — an in-memory ring buffer of WARNINGS and ERRORS
 * surfaced during a session, for the `leader e` diagnostics window
 * (overlay/diag-log.js).
 *
 * Distinct from event-log.js on purpose. event-log is the replay
 * firehose (every key / mouse / refresh / publish / action), so a
 * warning recorded there is evicted within seconds under normal input.
 * This buffer holds ONLY diagnostics, with its own cap, so a config
 * warning or a thrown effect stays visible long enough for the user to
 * open the window and read it.
 *
 * Entry shape: { t, level, code, message }
 *   - t       — ms epoch (Date.now() at record time)
 *   - level   — 'warn' | 'error' (anything else normalizes to 'warn')
 *   - code    — short machine tag ('pane-collapse', 'config', 'throw' …)
 *   - message — human-readable one-liner
 *
 * Storage: newest at the END of `_buf` (push); `snapshot()` returns a
 * newest-FIRST copy for display. Cap defaults to 200; oldest drop.
 *
 * Producers today: boot config warnings (app/state.js), the
 * same-kind-collapse guard (panel/route.js getInstanceSlice), and every
 * runtime error funneled through dispatch/effects.js `_recordError`.
 * Other call sites adopt warn()/error() opportunistically.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CAP = 200;

let _cap = DEFAULT_CAP;
let _buf = [];

/** Append a diagnostic. `level` normalizes to 'warn' unless 'error'. */
function record(level, code, message) {
  const lvl = level === 'error' ? 'error' : 'warn';
  _buf.push({
    t: Date.now(),
    level: lvl,
    code: String(code == null ? '' : code),
    message: String(message == null ? '' : message),
  });
  if (_buf.length > _cap) _buf.shift();
}

function warn(code, message)  { record('warn', code, message); }
function error(code, message) { record('error', code, message); }

/** Newest-first copy for display. */
function snapshot() { return _buf.slice().reverse(); }

function size() { return _buf.length; }

/** { warn, error, total } — for a footer indicator or a test. */
function counts() {
  let w = 0, e = 0;
  for (const x of _buf) (x.level === 'error' ? e++ : w++);
  return { warn: w, error: e, total: _buf.length };
}

/** One-line text for yanking an entry to the register / clipboard
 *  (the diagnostics window's `y` key). Stable, paste-friendly shape:
 *  `[level] code: message`. */
function yankText(ev) {
  if (!ev) return '';
  return `[${ev.level}] ${ev.code}: ${ev.message}`;
}

function clear() { _buf = []; }

function setCap(n) {
  _cap = Math.max(1, n | 0);
  while (_buf.length > _cap) _buf.shift();
}

/**
 * Write the current buffer to a JSON file for a bug report. With no
 * argument, writes `lazytui-diagnostics.json` in the process cwd
 * (overwrite). Returns the path written.
 */
function save(filepath) {
  const fp = filepath || path.join(process.cwd(), 'lazytui-diagnostics.json');
  fs.writeFileSync(fp, JSON.stringify({
    savedAt: Date.now(),
    count: _buf.length,
    diagnostics: _buf,
  }, null, 2));
  return fp;
}

module.exports = {
  record, warn, error, snapshot, size, counts, clear, setCap, save,
  yankText, DEFAULT_CAP,
};
