/**
 * B6 — `--dev` WAL console (headless). Inspect a recorded session-log: a
 * greppable, line-oriented dump of its entries (+ optional per-Msg model diff),
 * mirroring `--record-print` (headless, composable, testable). Reads the WAL as
 * data via `session-log.load`/`loadMeta`; `--diff` reconstructs (reusing the
 * `leaves/replay/model-diff` leaf the scrubber uses). Not an in-app console.
 *
 *   node js/app/tui.js --dev <wal> [--filter lane=root,kind=msg,type=clock_tick,path=modal]
 *                                  [--seq-range a..b] [--diff] [--json]
 */
'use strict';

const sessionLog = require('../io/session-log');

function _err(m) { process.stderr.write(`dev-console: ${m}\n`); }

// `--filter` = comma-AND of k=v predicates. lane/kind/type filter ENTRIES;
// path filters per-Msg diff rows (requires --diff).
function _parseFilter(expr) {
  const p = { lane: null, kind: null, type: null, path: null };
  if (expr) for (const part of String(expr).split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) { const k = part.slice(0, eq).trim(); const v = part.slice(eq + 1).trim(); if (k in p) p[k] = v; }
  }
  return p;
}
function _parseRange(expr, maxSeq) {
  if (!expr) return null;
  const m = String(expr).split('..');
  const a = parseInt(m[0], 10);
  const b = m.length > 1 ? parseInt(m[1], 10) : a;
  return { a: Number.isFinite(a) ? a : 0, b: Number.isFinite(b) ? b : maxSeq };
}

function _msgType(e) {
  const m = e.msg;
  if (!m) return e.key !== undefined ? 'key' : '';
  return m.type || (m.msg && m.msg.type) || '';
}
function _short(v) {
  if (v == null || typeof v !== 'object') return String(v);
  const s = JSON.stringify(v);
  return s.length > 28 ? s.slice(0, 27) + '…' : s;
}
function _summary(e) {
  if (e.kind === 'msg') {
    if (e.lane === 'key') return `key   ${JSON.stringify(e.key)} keySeq=${e.keySeq}`;
    const m = e.msg || {};
    const extra = Object.keys(m).filter(k => k !== 'type' && k !== 'kind' && k !== 'msg')
      .slice(0, 3).map(k => `${k}=${_short(m[k])}`).join(' ');
    return `${String(e.lane).padEnd(4)}  ${_msgType(e)}${extra ? ' ' + extra : ''}`;
  }
  if (e.kind === 'term') {
    const d = e.d != null ? `${Buffer.byteLength(String(e.d))}B`
      : e.code != null ? `code=${e.code}` : e.cols != null ? `${e.cols}x${e.rows}` : '';
    return `${String(e.ev || '').padEnd(4)}  id=${e.id} ${d}`;
  }
  if (e.kind === 'checkpoint') {
    const grids = e.grids ? Object.keys(e.grids) : [];
    return `-     state=${Buffer.byteLength(JSON.stringify(e.state || {}))}B grids=[${grids.join(',')}]`;
  }
  return '';
}

// Per-Msg model diff for every entry, computed in ONE rolling fold (idx-1 vs
// idx). Returns { idx: changes[] }. Requires the runtime (reconstruction).
function _computeDiffs(entries, pathFilter) {
  const replayCli = require('./replay-cli');
  replayCli._installRuntime();
  const replay = require('../dispatch/runtime/replay');
  const { diffState } = require('../leaves/replay/model-diff');
  const out = {};
  if (!entries.length) return out;
  replay.replayTo(entries, entries[0].seq, { useCheckpoints: true });
  let prev = replay.snapshotState();
  for (let i = 1; i < entries.length; i++) {
    replay.foldMsgs(entries, i - 1, i);
    const cur = replay.snapshotState();
    if (entries[i].kind === 'msg') {
      const { changes } = diffState(prev, cur, { max: 20, pathFilter });
      if (changes.length) out[i] = changes;
    }
    prev = cur;
  }
  return out;
}

function runDevConsole(file, opts = {}) {
  let entries, meta;
  try { meta = sessionLog.loadMeta(file); entries = sessionLog.load(file); }
  catch (e) { _err(`cannot read ${file}: ${e.message}`); return 1; }

  const preds = _parseFilter(opts.filter);
  const maxSeq = entries.length ? entries[entries.length - 1].seq : 0;
  const range = _parseRange(opts.seqRange, maxSeq);
  const keep = (e) =>
    (!range || (e.seq >= range.a && e.seq <= range.b)) &&
    (!preds.lane || e.lane === preds.lane) &&
    (!preds.kind || e.kind === preds.kind) &&
    (!preds.type || _msgType(e) === preds.type);

  const out = (s) => process.stdout.write(s + '\n');

  if (opts.json) {
    for (const e of entries) if (keep(e)) out(JSON.stringify(e));
    return 0;
  }

  const cps = entries.reduce((n, e) => n + (e.kind === 'checkpoint' ? 1 : 0), 0);
  const t0 = entries.length ? entries[0].t : 0;
  const t1 = entries.length ? entries[entries.length - 1].t : 0;
  const schema = meta.schemaVersion != null ? `v${meta.schemaVersion}` : 'v? (unversioned)';
  out(`# lazytui ${meta.lazytui || '?'}  schema ${schema}  entries ${entries.length}  checkpoints ${cps}  span ${t0}..${t1}`);
  if (meta.compat === 'newer') _err('WAL schema is NEWER than this build — dump may be incomplete');

  const diffs = opts.diff ? _computeDiffs(entries, preds.path) : null;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!keep(e)) continue;
    out(`${String(e.seq).padStart(5)}  ${String(e.kind).padEnd(5)} ${_summary(e)}`);
    if (diffs && diffs[i]) {
      for (const c of diffs[i]) {
        const mark = c.kind === 'add' ? '+' : c.kind === 'remove' ? '-' : '~';
        const val = c.kind === 'add' ? c.after : c.kind === 'remove' ? c.before : `${c.before} -> ${c.after}`;
        out(`        ${mark} ${c.path}  ${val}`);
      }
    }
  }
  return 0;
}

module.exports = { runDevConsole };
