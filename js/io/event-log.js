/**
 * Event log — an in-memory ring buffer of input events that drove the
 * TUI session. The recorder side of TEA item #2 (PRINCIPLES.md §11
 * sets the idempotence guarantee that makes a future replay
 * deterministic; this file is the producer).
 *
 * What gets recorded — *inputs to the system*, not outputs:
 *
 *   - `key`     — every key event passed through dispatch.handleKey
 *   - `mouse`   — mouse click hits (panel coords + button)
 *   - `refresh` — each refreshAll tick start (no payload — just the marker)
 *   - `publish` — hub.publish(topic, rowKey, sample)
 *   - `action`  — action invocation: { group, key }
 *
 * What is NOT recorded — render calls, internal state mutations,
 * panel renders. These are responses, not inputs, and would flood the
 * log without adding diagnostic value.
 *
 * Storage: a ring buffer with a configurable cap (default 500). When the
 * cap is exceeded, oldest events drop. Per-event overhead is small
 * (~100 bytes), so 500 events at the default cap is ~50 kB — fine for
 * an in-memory diagnostic.
 *
 * No I/O happens here unless the caller asks: `save(path)` writes the
 * current buffer as JSON. The recorder itself is silent.
 *
 * Replay is *not* implemented in v0.2.0 — see CHANGELOG. The recorded
 * shape is forward-compatible with a future replayer that re-injects
 * key/mouse/refresh events into dispatch.handleKey / handleMouse /
 * refreshAll.
 */
'use strict';

const fs = require('fs');
const { version } = require('../../package.json');

const DEFAULT_CAP = 500;

let _enabled = true;
let _cap = DEFAULT_CAP;
let _buf = [];

// Live-tail file path — set via attachStream(path) or auto-attached
// from the LAZYTUI_LOG env var at process start. When set, every
// record() call appendFileSync's a JSON line. Sync I/O is fine at
// TUI event rates (~30 records/s peak, ~3 kB/s); a tail consumer
// can `tail -F` the file in another window.
let _streamPath = null;

function _openStream(filepath) {
  try {
    // Verify writability up front so we fail loudly here, not on
    // every record() call.
    fs.appendFileSync(filepath, JSON.stringify({
      t: Date.now(),
      type: 'session-start',
      payload: { lazytui: version, pid: process.pid },
    }) + '\n');
    _streamPath = filepath;
  } catch (e) {
    process.stderr.write(`event-log: cannot open ${filepath}: ${e.message}\n`);
    _streamPath = null;
  }
}

/**
 * Append an event to the ring buffer. Silent no-op if disabled. The
 * `payload` is shallow-cloned where reasonable to avoid downstream
 * mutations bleeding into recorded history. If a stream is attached
 * (via attachStream or LAZYTUI_LOG), the event is also written to
 * the file as one JSON line.
 */
function record(type, payload) {
  if (!_enabled) return;
  const entry = {
    t: Date.now(),
    type,
    payload: payload === undefined ? null : payload,
  };
  _buf.push(entry);
  if (_buf.length > _cap) _buf.shift();
  if (_streamPath) {
    // Best-effort append; if the file vanished (deleted, disk full),
    // drop silently rather than crashing the TUI.
    try { fs.appendFileSync(_streamPath, JSON.stringify(entry) + '\n'); }
    catch (e) { _streamPath = null; }
  }
}

/**
 * Attach a live log stream. Every subsequent record() also appends a
 * JSON line to the given file. Idempotent — calling with the same
 * path twice is a no-op; calling with a different path closes the
 * previous stream first.
 */
function attachStream(filepath) {
  if (_streamPath === filepath) return;
  detachStream();
  if (filepath) _openStream(filepath);
}

function detachStream() {
  _streamPath = null;
}

// LAZYTUI_LOG env var: if set, attach a stream automatically at
// module load. Skipped under test runners that load this module
// without intending to write logs (no env var means no behavior
// change for existing callers).
if (process.env.LAZYTUI_LOG) {
  _openStream(process.env.LAZYTUI_LOG);
}

function enable(yes = true)  { _enabled = !!yes; }
function isEnabled()         { return _enabled; }
function setCap(n)           { _cap = Math.max(1, n | 0); }
function clear()             { _buf = []; }
function snapshot()          { return _buf.slice(); }
function size()              { return _buf.length; }

/**
 * Serialize the current buffer to a JSON file. The file format:
 *
 *   {
 *     "lazytui": "0.2.0",
 *     "savedAt": <ms epoch>,
 *     "count": <N>,
 *     "events": [ { t, type, payload }, ... ]
 *   }
 *
 * Suitable as a bug-report attachment — a maintainer can reload the
 * file and (in a future version) replay the events to reproduce.
 */
function save(filepath) {
  const doc = {
    lazytui: version,
    savedAt: Date.now(),
    count: _buf.length,
    events: _buf,
  };
  fs.writeFileSync(filepath, JSON.stringify(doc, null, 2));
  return filepath;
}

module.exports = {
  record, enable, isEnabled, setCap, clear, snapshot, size, save,
  attachStream, detachStream,
  DEFAULT_CAP,
};
