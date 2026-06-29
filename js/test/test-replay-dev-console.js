/**
 * B6 — `--dev` headless WAL console. Records a reconstructable WAL fixture, then
 * runs `node js/app/tui.js --dev <wal>` (+ flags) in a subprocess and asserts the
 * dump. Mirrors test-replay-cli.js. Run: node js/test/test-replay-dev-console.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, assert, eq, report } = require('./test-runner');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = process.env.SCRATCH_DIR || '/tmp';
const cfgPath = path.join(TMP, `dev-cfg-${process.pid}.json`);
const walPath = path.join(TMP, `dev-wal-${process.pid}.jsonl`);

const _grp = (n) => ({ name: n, label: n, containers: [], actions: { a1: { key: 'a1', label: 'A1', type: 'run', script: 'echo', tab: false } }, children: [], parent: null, depth: 0, quick: false });
fs.writeFileSync(cfgPath, JSON.stringify({ project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {}, groups: { g1: _grp('g1') } }));

const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { fn(); } finally { process.stdout.write = o; } };

// --- record a reconstructable WAL fixture (config + boot + 2 clock_ticks) ---
const replayCli = require('../app/replay-cli');
const sessionLog = require('../io/session-log');
const state = require('../app/state');
const route = require('../panel/route');
const { setModel } = require('../model/store');
const runtime = require('../app/runtime');
const loop = require('../dispatch/runtime/loop');

route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();
sessionLog.enable(true); sessionLog.clear();
cap(() => {
  state.loadConfig(cfgPath);
  state.initState();
  loop.applyMsg({ type: 'clock_tick', now: 1000 });
  loop.applyMsg({ type: 'clock_tick', now: 2000 });
});
sessionLog.save(walPath);
sessionLog.enable(false);

const dev = (args) => {
  try { return { rc: 0, out: execFileSync('node', [path.join(REPO, 'js/app/tui.js'), '--dev', walPath, ...args], { cwd: REPO, encoding: 'utf8', timeout: 30000 }) }; }
  catch (e) { return { rc: e.status || 1, out: (e.stdout || '') + (e.stderr || '') }; }
};

describe('[B6] --dev dump', () => {
  it('prints a schema header line + entry lines', () => {
    const { rc, out } = dev([]);
    eq(rc, 0, 'exit 0');
    assert(/^# lazytui .* schema v1 .* entries \d+/m.test(out), `header line present:\n${out.slice(0, 200)}`);
    assert(/clock_tick/.test(out), 'clock_tick entries shown');
  });
  it('--filter type=clock_tick shows only the clock_tick Msgs', () => {
    const { out } = dev(['--filter', 'type=clock_tick']);
    const rows = out.split('\n').filter(l => l && !l.startsWith('#'));
    assert(rows.length === 2, `exactly 2 clock_tick rows, got ${rows.length}`);
    assert(rows.every(r => /clock_tick/.test(r)), 'all rows are clock_tick');
  });
  it('--filter kind=msg excludes non-msg entries', () => {
    const { out } = dev(['--filter', 'kind=msg']);
    const rows = out.split('\n').filter(l => l && !l.startsWith('#'));
    assert(rows.length > 0 && rows.every(r => / msg /.test(r) || /\bmsg\b/.test(r)), 'only msg rows');
  });
  it('--diff shows the per-Msg model change (model.now)', () => {
    const { out } = dev(['--filter', 'type=clock_tick', '--diff']);
    assert(/model\.now/.test(out), `diff row for model.now present:\n${out}`);
    assert(/1000 -> 2000|-> 2000/.test(out), 'the 1000→2000 transition shown');
  });
  it('--json emits JSONL that round-trips', () => {
    const { out } = dev(['--filter', 'type=clock_tick', '--json']);
    const lines = out.split('\n').filter(Boolean);
    eq(lines.length, 2, 'two JSON lines');
    const objs = lines.map(l => JSON.parse(l));
    assert(objs.every(o => typeof o.seq === 'number' && o.kind === 'msg'), 'valid entry objects');
  });
  it('--seq-range bounds the dump', () => {
    const all = dev([]).out.split('\n').filter(l => l && !l.startsWith('#'));
    const firstSeq = parseInt(all[0].trim().split(/\s+/)[0], 10);
    const { out } = dev(['--seq-range', `${firstSeq}..${firstSeq}`]);
    const rows = out.split('\n').filter(l => l && !l.startsWith('#'));
    eq(rows.length, 1, 'exactly the one in-range entry');
  });
  it('an unreadable file exits non-zero', () => {
    const { rc } = (() => { try { execFileSync('node', [path.join(REPO, 'js/app/tui.js'), '--dev', '/no/such/file.jsonl'], { cwd: REPO, encoding: 'utf8' }); return { rc: 0 }; } catch (e) { return { rc: e.status || 1 }; } })();
    assert(rc !== 0, 'non-zero on missing file');
  });
});

try { fs.unlinkSync(cfgPath); fs.unlinkSync(walPath); } catch {}
report();
