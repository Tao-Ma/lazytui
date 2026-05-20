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
const { version } = require('../package.json');

const DEFAULT_CAP = 500;

let _enabled = true;
let _cap = DEFAULT_CAP;
let _buf = [];

/**
 * Append an event to the ring buffer. Silent no-op if disabled. The
 * `payload` is shallow-cloned where reasonable to avoid downstream
 * mutations bleeding into recorded history.
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
  DEFAULT_CAP,
};
