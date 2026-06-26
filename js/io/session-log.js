/**
 * Session log — the replay recorder (v0.6.6 replay arc).
 *
 * A single ordered write-ahead log of everything needed to reconstruct a
 * session, in ONE file (JSONL — one entry per line). Three entry kinds:
 *
 *   - `msg`        — a Msg entering the dispatch loop (the model WAL).
 *                    `lane` ∈ root | comp | key. root/comp carry `msg`; key
 *                    carries `key` + `keySeq` (the raw escape sequence) and is
 *                    re-applied via dispatchKeyToFocused (which re-derives the
 *                    augmented Msg from the reconstructed model).
 *   - `term`       — an off-model terminal change (#D14 foreign-component
 *                    side-channel, never in the TEA model). `ev` ∈ spawn |
 *                    resize | out | exit; `out` carries the PTY output string
 *                    `d` (node-pty yields a decoded string; JSON escapes any
 *                    control bytes losslessly, so no base64 is needed).
 *   - `checkpoint` — a full resumable snapshot (Phase D): { model, slices, grids }.
 *
 * One monotonic `seq` stamps EVERY entry across all kinds, so the interleaved
 * single stream IS the global order (a `set_arrange` Msg that places a terminal
 * precedes that terminal's first `out`). Correctness comes from the WAL;
 * checkpoints are the seek/resume optimization.
 *
 * Default DISABLED — zero hot-path cost when off. `enable(true)` or the
 * `LAZYTUI_REPLAY_LOG` env var turns it on (the env var also attaches a JSONL
 * live-append stream). `save`/`load` use the same JSONL format the `--replay`
 * tool consumes.
 *
 * Layer: io leaf — it has NO upward requires and must not reach dispatch /
 * the replay flag. The dispatch loop guards its own record() calls; the
 * terminal feeds `term` entries via an injected hook (io/terminal stays a
 * leaf — see its header + docs/foreign-components.md).
 *
 * Unlike io/event-log (a bounded diagnostic ring), this keeps the FULL stream:
 * a ring would drop early Msgs and break the fold. Memory is bounded in
 * practice by save-to-stream + checkpoint compaction (Phase D/E).
 */
'use strict';

const fs = require('fs');
const { version } = require('../../package.json');

let _enabled = false;
let _seq = 0;
let _buf = [];
let _streamPath = null;

function _nextSeq() { return ++_seq; }

/**
 * Append one entry. Silent no-op (returns -1) when disabled. Returns the
 * assigned global `seq`. Writes a JSONL line to the attached stream, if any.
 */
function record(kind, fields) {
  if (!_enabled) return -1;
  const entry = { seq: _nextSeq(), t: Date.now(), kind, ...fields };
  _buf.push(entry);
  if (_streamPath) {
    try { fs.appendFileSync(_streamPath, JSON.stringify(entry) + '\n'); }
    catch (e) { _streamPath = null; }   // file vanished/full — drop, don't crash
  }
  return entry.seq;
}

// --- Convenience recorders (the call sites read clearly) -----------------

/** Record a Msg entering the loop. `payload` is `{lane,msg}` or `{lane:'key',key,keySeq}`. */
function recordMsg(payload) { return record('msg', payload); }

/** Record a terminal foreign-component change. */
function recordTerm(payload) { return record('term', payload); }

/** Record a full resumable checkpoint snapshot (Phase D). */
function recordCheckpoint(payload) { return record('checkpoint', payload); }

// --- Stream attach / env auto-attach -------------------------------------

function _openStream(filepath) {
  try {
    fs.appendFileSync(filepath, JSON.stringify({
      kind: 'header', lazytui: version, t: Date.now(), pid: process.pid,
    }) + '\n');
    _streamPath = filepath;
  } catch (e) {
    process.stderr.write(`session-log: cannot open ${filepath}: ${e.message}\n`);
    _streamPath = null;
  }
}

/** Attach a JSONL live-append stream (every subsequent record() also appends a
 *  line). Idempotent on the same path; a different path closes the previous. */
function attachStream(filepath) {
  if (_streamPath === filepath) return;
  detachStream();
  if (filepath) _openStream(filepath);
}

function detachStream() { _streamPath = null; }

// --- Persistence ----------------------------------------------------------

/** Write the full buffer to `filepath` as JSONL (header line + one entry per
 *  line) — the same format the live stream produces and `load` reads. */
function save(filepath) {
  const lines = [JSON.stringify({
    kind: 'header', lazytui: version, savedAt: Date.now(), count: _buf.length,
  })];
  for (const e of _buf) lines.push(JSON.stringify(e));
  fs.writeFileSync(filepath, lines.join('\n') + '\n');
  return filepath;
}

/** Load a JSONL session file into the buffer (replacing it). Skips the header
 *  line; restores `_seq` to the max seen so post-load appends stay monotonic.
 *  Returns the loaded entries (header excluded). */
function load(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const entries = [];
  let maxSeq = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }   // tolerate a torn last line
    if (!obj || obj.kind === 'header') continue;
    entries.push(obj);
    if (typeof obj.seq === 'number' && obj.seq > maxSeq) maxSeq = obj.seq;
  }
  _buf = entries;
  _seq = maxSeq;
  return entries;
}

// --- Lifecycle / inspection ----------------------------------------------

// --- Set-aware JSON codec -------------------------------------------------
//
// `checkpoint` entries embed Component slices, and nav slices hold Sets
// (`multiSel` on every navigator; `expanded` on groups) — the ONLY non-plain
// type in the replayable state (Map/Date elsewhere are module-local caches, not
// state). encodeJson maps Set → { __set__: [...] } recursively so a checkpoint
// serializes to plain JSON; decodeJson reverses it. The Msg/term entries carry
// no Sets, so they pass through both unchanged.
function encodeJson(v) {
  if (v instanceof Set) return { __set__: Array.from(v, encodeJson) };
  if (Array.isArray(v)) return v.map(encodeJson);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = encodeJson(v[k]);
    return o;
  }
  return v;
}
function decodeJson(v) {
  if (Array.isArray(v)) return v.map(decodeJson);
  if (v && typeof v === 'object') {
    if (Array.isArray(v.__set__)) return new Set(v.__set__.map(decodeJson));
    const o = {};
    for (const k of Object.keys(v)) o[k] = decodeJson(v[k]);
    return o;
  }
  return v;
}

function enable(yes = true) { _enabled = !!yes; }
function isEnabled()        { return _enabled; }
function clear()            { _buf = []; _seq = 0; }
function snapshot()         { return _buf.slice(); }
function size()             { return _buf.length; }

module.exports = {
  record, recordMsg, recordTerm, recordCheckpoint,
  enable, isEnabled, clear, snapshot, size,
  attachStream, detachStream, save, load,
  encodeJson, decodeJson,
};

// LAZYTUI_REPLAY_LOG: if set, enable + attach a live JSONL stream at module
// load (process start), so the recorded WAL is complete from the first Msg.
// Mirrors io/event-log's LAZYTUI_LOG auto-attach.
if (process.env.LAZYTUI_REPLAY_LOG) {
  _enabled = true;
  _openStream(process.env.LAZYTUI_REPLAY_LOG);
}
