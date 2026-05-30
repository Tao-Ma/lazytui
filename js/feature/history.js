/**
 * Operation history — every action that runs through the shared executor
 * (stream.js for type:run + plugin i/t shortcuts; actions.js for
 * spawn/background lifecycles). In-shell typing inside terminal tabs is
 * intentionally NOT tracked.
 *
 * Each entry: { id, ts, label, cmd, startedAt, endedAt, exitCode, output }
 *
 * Storage is the event hub on topic `actions.lifecycle` (single-stream,
 * rowKey '_') with window=HISTORY_MAX. Entries are mutable: published
 * once at start(), then appended-to / closed via the returned handle.
 * The hub stores the reference, so the history panel always reads live
 * state on render.
 *
 * Output is capped per entry (lines + bytes) so a noisy `docker logs -f`
 * can't blow up memory.
 */
'use strict';

const hub = require('./hub');

const TOPIC = 'actions.lifecycle';
const HISTORY_MAX = 100;
const OUTPUT_LINES_MAX = 200;
const OUTPUT_BYTES_MAX = 4 * 1024;

let _nextId = 1;
let _initialized = false;

function ensureInit() {
  if (_initialized) return;
  // Panel-lifetime subscription — the history panel always exists, so the
  // window stays open for the life of the process. Window matches the
  // ring cap; hub trims oldest on overflow.
  hub.subscribe(TOPIC, { window: HISTORY_MAX });
  hub.defineTopic(TOPIC, {
    rowKey: 'stream',
    columns: {
      label:    { type: 'string' },
      cmd:      { type: 'string' },
      startedAt:{ type: 'number' },
      endedAt:  { type: 'number' },
      exitCode: { type: 'string' },
    },
  });
  _initialized = true;
}

/**
 * Begin recording a new operation. Returns a handle; caller appends
 * output via .append(line) and finishes via .end(exitCode) / .kill().
 *
 * @param {string} label - short identifier shown in the history panel
 * @param {string} cmd   - resolved shell command (or '' for non-shell ops)
 * @param {object} [opts]
 * @param {boolean} [opts.detached] - true for spawn/background (no output capture, exit unknown)
 */
function start(label, cmd, opts = {}) {
  ensureInit();
  const now = Date.now();
  const entry = {
    id: _nextId++,
    ts: now,
    label: label || '(unnamed)',
    cmd: cmd || '',
    startedAt: now,
    endedAt: null,
    exitCode: opts.detached ? 'detached' : null,
    output: [],
    _outputBytes: 0,
    _detached: !!opts.detached,
  };

  // Detached entries close immediately — we never see their exit.
  if (opts.detached) entry.endedAt = now;

  hub.publish(TOPIC, '_', entry);

  return {
    entry,
    append(line) { appendOutput(entry, line); },
    end(exitCode) { endEntry(entry, exitCode); },
    kill() { endEntry(entry, 'killed'); },
  };
}

function appendOutput(entry, line) {
  if (entry._detached) return;
  if (entry.output.length >= OUTPUT_LINES_MAX) return;
  if (entry._outputBytes >= OUTPUT_BYTES_MAX) {
    if (entry.output[entry.output.length - 1] !== '… (output truncated)') {
      entry.output.push('… (output truncated)');
    }
    return;
  }
  entry.output.push(line);
  entry._outputBytes += line.length + 1;
}

function endEntry(entry, exitCode) {
  if (entry.endedAt !== null && entry.exitCode !== null) return;
  entry.endedAt = Date.now();
  entry.exitCode = exitCode;
}

/**
 * Newest-first list of entries. Hub stores oldest-first (push order); the
 * panel and original API both expect newest-first, so reverse on read.
 */
function all() {
  ensureInit();
  const samples = hub.history(TOPIC, '_', HISTORY_MAX);
  // slice() because hub returns its own copy already, but reverse is
  // in-place — keep it explicit so future hub changes don't bite us.
  return samples.slice().reverse();
}

module.exports = { start, all };
