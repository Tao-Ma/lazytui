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
 * Producers today: boot config warnings (app/state.js), and every runtime
 * error funneled through dispatch/runtime/effects.js `_recordError` — these are
 * effect/boot-path, so they record() synchronously. The two RENDER/READ-path
 * producers (the strict-miss tripwire in panel/route.js, the plugin
 * purity/timing guard in panel/plugin-guard.js) use the DEFERRED lane instead
 * (recordDeferred → flushDeferred); see that lane's note below for why.
 * Other call sites adopt warn()/error() opportunistically.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CAP = 200;

let _cap = DEFAULT_CAP;
let _buf = [];

// Mirrorable-store contract (v0.6.6 FIX-1, docs/v0.6.6.md §8.1): a single
// change-notify seam the store-mirror Sub injects its cb into, so the buffer
// mirrors itself into model.diagLog without importing the dispatch loop. This
// is the store that had NO notification before FIX-1 (render just sampled it
// each frame) — it now actively drives diag_synced. Low-frequency throughout
// (warnings/errors), so it fires on EVERY mutation.
let _onChange = null;
function setOnChange(cb) { _onChange = cb || null; }
function _notify() { if (_onChange) _onChange(); }

function _push(level, code, message) {
  _buf.push({
    t: Date.now(),
    level: level === 'error' ? 'error' : 'warn',
    code: String(code == null ? '' : code),
    message: String(message == null ? '' : message),
  });
  if (_buf.length > _cap) _buf.shift();
}

/** Append a diagnostic. `level` normalizes to 'warn' unless 'error'. */
function record(level, code, message) { _push(level, code, message); _notify(); }

function warn(code, message)  { record('warn', code, message); }
function error(code, message) { record('error', code, message); }

// Deferred lane (v0.6.6 §9 follow-up — render-path purity). A render/read-path
// detection must NOT mutate the buffer synchronously: a write here fires
// _notify → the store-mirror's `diag_synced` dispatch, i.e. a re-entrant
// applyMsg from INSIDE render, feeding model.diagLog (the very frame being
// drawn). Those producers recordDeferred() into this queue instead — no
// _notify, no dispatch, and no Date.now() (the timestamp is stamped at flush),
// so the read path stays a pure function of the model. The dispatch finalizer
// (dispatch/runtime/finalize) drains it once per outermost dispatch via
// flushDeferred(), landing the warn through the normal diag_synced flow from a
// dispatch-side context. Dedup stays at the call site, so the queue can't flood.
let _pending = [];

/** Queue a diagnostic detected on a render/read path. No notify, no Date.now();
 *  drained by flushDeferred() from the dispatch finalizer. Module-local — the
 *  only deferred producer today warns; an `errorDeferred` would wrap this the
 *  same way (warn/error symmetry) if a render-path error ever needs deferring. */
function recordDeferred(level, code, message) {
  _pending.push({ level: level === 'error' ? 'error' : 'warn', code, message });
}
function warnDeferred(code, message) { recordDeferred('warn', code, message); }

/** Drain the deferred queue into the buffer and fire ONE change-notify for the
 *  whole batch (→ one diag_synced dispatch regardless of how many detections
 *  coalesced). No-op when empty (the steady state), so it is cheap to call every
 *  dispatch. `t` is stamped here (dispatch-side), in detection order. */
function flushDeferred() {
  if (_pending.length === 0) return;
  const batch = _pending;
  _pending = [];
  for (const e of batch) _push(e.level, e.code, e.message);
  _notify();
}

/** Newest-first copy for display. */
function snapshot() { return _buf.slice().reverse(); }

function size() { return _buf.length; }

/** { warn, error, total }. Consumed by the test suite today; shaped for a
 *  future footer badge (no footer indicator wires it in yet). */
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

function clear() { _buf = []; _pending = []; _notify(); }

function setCap(n) {
  _cap = Math.max(1, n | 0);
  while (_buf.length > _cap) _buf.shift();
  _notify();
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
  yankText, DEFAULT_CAP, setOnChange,
  warnDeferred, flushDeferred,
};
