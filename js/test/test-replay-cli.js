/**
 * v0.6.6 replay arc — Phase E: file persistence + the --replay CLI.
 *
 * Records a full headless boot + a few ops to a WAL FILE, then reconstructs it
 *   (1) in-process via app/replay-cli.runReplay after resetting all state, and
 *   (2) in a genuinely fresh subprocess: `node js/app/tui.js --replay <file>`.
 * Both must reproduce the recorded screen (content presence) — proving the
 * single-file JSONL format round-trips and the harness boots from bare.
 *
 * Run: node js/test/test-replay-cli.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { describe, it, assert, eq, report } = require('./test-runner');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = process.env.SCRATCH_DIR || '/tmp';
const cfgPath = path.join(TMP, `replay-cli-cfg-${process.pid}.json`);
const walPath = path.join(TMP, `replay-cli-wal-${process.pid}.jsonl`);

const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
const CONFIG = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group One'), g2: _grp('g2', 'Group Two') },
};

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('');
}

// --- 1) Record a full headless boot + ops to a WAL file -------------------
fs.writeFileSync(cfgPath, JSON.stringify(CONFIG));

const replayCli = require('../app/replay-cli');
const sessionLog = require('../io/session-log');
const state = require('../app/state');
const route = require('../panel/route');
const { getModel, setModel } = require('../model/store');
const runtime = require('../app/runtime');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');

// Fresh state, then the SAME runtime scaffolding the CLI uses.
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();

sessionLog.enable(true);
sessionLog.clear();
capture(() => {
  state.loadConfig(cfgPath);   // → set_config (recorded as the first entry)
  state.initState();           // → boot Msgs (set_theme/arrange/term_resized/...)
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
});
sessionLog.save(walPath);
sessionLog.enable(false);
const recordedEntries = sessionLog.size();

// --- 2) Reconstruct in-process from the FILE (reset → runReplay) ----------
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
const inProcOut = capture(() => replayCli.runReplay(walPath));

// --- 3) Reconstruct in a fresh subprocess ---------------------------------
let subprocOut = '';
let subprocOk = true;
try {
  subprocOut = execFileSync('node', [path.join(REPO, 'js/app/tui.js'), '--replay', walPath],
    { cwd: REPO, encoding: 'utf8', timeout: 30000 });
} catch (e) {
  subprocOk = false;
  subprocOut = `EXEC FAILED: ${e.message}\n${e.stdout || ''}\n${e.stderr || ''}`;
}

// --- assertions ---
describe('[1] the WAL file persists a full boot', () => {
  it('recorded a non-trivial entry stream', () => assert(recordedEntries > 5, `entries: ${recordedEntries}`));
  it('the file is valid JSONL with a header + entries', () => {
    const lines = fs.readFileSync(walPath, 'utf8').trim().split('\n');
    assert(lines.length > 5, `lines: ${lines.length}`);
    eq(JSON.parse(lines[0]).kind, 'header', 'first line is the header');
    eq(JSON.parse(lines[1]).kind, 'msg', 'second line is a Msg entry');
  });
});

describe('[2] --replay reconstructs the screen in-process', () => {
  it('the reconstructed frame shows the configured group', () => {
    assert(/Group One/.test(inProcOut), `frame: ${JSON.stringify(inProcOut.slice(0, 200))}`);
  });
});

describe('[3] --replay reconstructs the screen in a fresh subprocess', () => {
  it('the subprocess exits 0', () => assert(subprocOk, subprocOut.slice(0, 400)));
  it('its reconstructed frame shows the configured group', () => {
    assert(/Group One/.test(subprocOut), `subproc frame: ${JSON.stringify(subprocOut.slice(0, 200))}`);
  });
});

// cleanup
try { fs.unlinkSync(cfgPath); } catch {}
try { fs.unlinkSync(walPath); } catch {}

report();
