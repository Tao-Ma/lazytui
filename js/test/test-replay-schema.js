/**
 * B6 — WAL schema-versioning (js/io/session-log.js).
 *
 * The three header sites stamp `schemaVersion`; `load`/`loadMeta` read it back
 * and apply a no-hard-fail compat policy. Pre-B6 files (no field) load silently.
 *
 * Run: node js/test/test-replay-schema.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const slog = require('../io/session-log');

const tmp = (name) => path.join(os.tmpdir(), `lazytui-schema-${process.pid}-${name}.jsonl`);
const headerOf = (file) => {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim(); if (!s) continue;
    const o = JSON.parse(s); if (o.kind === 'header') return o;
  }
  return null;
};

describe('[B6] write sites stamp schemaVersion', () => {
  it('save() header carries schemaVersion === SCHEMA_VERSION', () => {
    slog.clear(); slog.enable(true);
    slog.recordMsg({ lane: 'root', msg: { type: 'clock_tick', now: 1 } });
    const f = tmp('save'); slog.save(f); slog.enable(false);
    const h = headerOf(f);
    eq(h.schemaVersion, slog.SCHEMA_VERSION, 'schema stamped');
    assert(typeof h.lazytui === 'string', 'app version still present');
    fs.unlinkSync(f);
  });
  it('streamTo() header carries schemaVersion', () => {
    slog.clear(); slog.enable(true);
    slog.recordMsg({ lane: 'root', msg: { type: 'clock_tick', now: 2 } });
    const f = tmp('stream'); slog.streamTo(f); slog.detachStream(); slog.enable(false);
    eq(headerOf(f).schemaVersion, slog.SCHEMA_VERSION);
    fs.unlinkSync(f);
  });
});

describe('[B6] loadMeta + compat policy', () => {
  it('loadMeta reads schema + verdict', () => {
    slog.clear(); slog.enable(true);
    slog.recordMsg({ lane: 'root', msg: { type: 'clock_tick', now: 3 } });
    const f = tmp('meta'); slog.save(f); slog.enable(false);
    const meta = slog.loadMeta(f);
    eq(meta.schemaVersion, slog.SCHEMA_VERSION);
    eq(meta.compat, 'ok');
    fs.unlinkSync(f);
  });
  it('a pre-B6 file (no schemaVersion) loads silently as unversioned', () => {
    const f = tmp('legacy');
    // Hand-write an old-format file: header WITHOUT schemaVersion + one entry.
    fs.writeFileSync(f, [
      JSON.stringify({ kind: 'header', lazytui: '0.6.6' }),
      JSON.stringify({ seq: 1, t: 1, kind: 'msg', lane: 'root', msg: { type: 'clock_tick', now: 9 } }),
    ].join('\n') + '\n');
    eq(slog.loadMeta(f).compat, 'unversioned');
    const entries = slog.load(f);   // must not throw / must load the entry
    eq(entries.length, 1, 'entry loaded best-effort');
    eq(entries[0].msg.type, 'clock_tick');
    fs.unlinkSync(f);
  });
  it('a NEWER-schema file is flagged newer (still loads, no hard-fail)', () => {
    const f = tmp('newer');
    fs.writeFileSync(f, [
      JSON.stringify({ kind: 'header', lazytui: '9.9.9', schemaVersion: slog.SCHEMA_VERSION + 1 }),
      JSON.stringify({ seq: 1, t: 1, kind: 'msg', lane: 'root', msg: { type: 'clock_tick', now: 9 } }),
    ].join('\n') + '\n');
    eq(slog.loadMeta(f).compat, 'newer');
    const entries = slog.load(f);   // warns via diag-log; still returns entries
    eq(entries.length, 1, 'newer file still loaded best-effort');
    fs.unlinkSync(f);
  });
});

report();
