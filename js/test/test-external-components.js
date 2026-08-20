/**
 * External (consumer-authored) Component registration — the config `components:`
 * hook. Covers the shared load/register seam (app/external-components.js) used
 * by both the live boot and all three replay entry points, the parser's
 * path-resolution + validation, and the WAL-peek that gives replay parity.
 *
 * Run: node js/test/test-external-components.js
 */
'use strict';

const path = require('path');
const { describe, it, assert, eq, report } = require('./test-runner');
const { externalComponents, configFromLog, registerExternal } = require('../app/external-components');
const { parse } = require('../parser');
const api = require('../panel/api');

const FIXTURES = path.join(__dirname, 'fixtures');
const FX_HELLO = path.join(FIXTURES, 'ext-hello.js');
const FX_TWO = path.join(FIXTURES, 'ext-two.js');

describe('[external-components] externalComponents() — resolve + require', () => {
  it('requires each declared module and returns the Component(s)', () => {
    const comps = externalComponents({ components: [FX_HELLO] });
    eq(comps.length, 1);
    eq(comps[0].name, 'ext-hello');
  });
  it('flattens a module that exports an array of Components', () => {
    const comps = externalComponents({ components: [FX_TWO] });
    eq(comps.map(c => c.name), ['ext-alpha', 'ext-beta']);
  });
  it('preserves declaration order across entries', () => {
    const comps = externalComponents({ components: [FX_TWO, FX_HELLO] });
    eq(comps.map(c => c.name), ['ext-alpha', 'ext-beta', 'ext-hello']);
  });
  it('absent / empty components → no components (no throw)', () => {
    eq(externalComponents(null), []);
    eq(externalComponents({}), []);
    eq(externalComponents({ components: [] }), []);
  });
  it('fails loud on a present-but-non-list components (the .json-bypass guard)', () => {
    let threw = false;
    try { externalComponents({ components: 'nope' }); } catch (_) { threw = true; }
    assert(threw, 'a non-array components: must throw, not silently drop');
  });
  it('fails loud on a module that loads but is not a valid Component', () => {
    const os = require('os'); const fs = require('fs');
    const bad = path.join(os.tmpdir(), `ext-bad-shape-${process.pid}.js`);
    fs.writeFileSync(bad, 'module.exports = { init: () => ({}) };'); // no name/update
    let msg = null;
    try { externalComponents({ components: [bad] }); } catch (e) { msg = e.message; }
    fs.unlinkSync(bad);
    assert(msg !== null, 'a malformed Component must fail loud, not be silently skipped');
    assert(/did not export a valid Component/.test(msg), `clear message: ${msg}`);
  });
  it('fails loud on an unloadable path, naming the offending entry', () => {
    let msg = null;
    try { externalComponents({ components: ['./does-not-exist-xyz.js'] }); }
    catch (e) { msg = e.message; }
    assert(msg !== null, 'expected a throw');
    assert(/cannot load/.test(msg), `message names the failure: ${msg}`);
    assert(/does-not-exist-xyz/.test(msg), `message names the entry: ${msg}`);
  });
  it('fails loud on a non-string entry', () => {
    let threw = false;
    try { externalComponents({ components: [123] }); } catch (_) { threw = true; }
    assert(threw, 'expected a throw on a non-string entry');
  });
});

describe('[external-components] registerExternal() — the shared boot/replay seam', () => {
  it('forwards each resolved Component to registerComponent, in order', () => {
    const seen = [];
    registerExternal({ components: [FX_TWO, FX_HELLO] }, c => seen.push(c.name));
    eq(seen, ['ext-alpha', 'ext-beta', 'ext-hello']);
  });
  it('a null/empty config registers nothing', () => {
    const seen = [];
    registerExternal(null, c => seen.push(c));
    registerExternal({}, c => seen.push(c));
    eq(seen.length, 0);
  });
  it('lands a real Component in the registry (layout-first, like the live boot)', () => {
    api.registerComponent(require('../panel/layout'));   // enforced-first chrome
    registerExternal({ components: [FX_HELLO] }, api.registerComponent);
    const got = api.getComponent('ext-hello');
    assert(got && got.name === 'ext-hello', 'ext-hello resolvable from the registry');
    assert(got.panelTypes && got.panelTypes['ext-hello'], 'its panel type is registered');
  });
});

describe('[external-components] collision/override — no accidental shadowing', () => {
  const mk = (name, type, extra) => ({ name, init: () => ({}), update: (m, s) => s, panelTypes: { [type]: { render: () => name, ...(extra || {}) } } });
  it('a panelType a built-in/other Component already owns THROWS (not silent override)', () => {
    api.registerComponent(mk('own-a', 'collide-x'));
    let threw = false;
    try { api.registerComponent(mk('own-b', 'collide-x')); } catch (_) { threw = true; }
    assert(threw, 'colliding panelType without override must throw — no silent shadowing');
  });
  it('override: true is the explicit opt-in to replace the owner', () => {
    let ok = true;
    try { api.registerComponent(mk('own-c', 'collide-x', { override: true })); } catch (_) { ok = false; }
    assert(ok, 'override:true must succeed');
    eq(require('../panel/route').componentForPanel('collide-x'), 'own-c');
  });
});

describe('[external-components] configFromLog() — replay-parity WAL peek', () => {
  it('returns the config carried by the first set_config Msg', () => {
    const log = [
      { seq: 1, kind: 'checkpoint' },
      { seq: 2, kind: 'msg', lane: 'key', key: 'j' },
      { seq: 3, kind: 'msg', msg: { type: 'set_config', config: { components: [FX_HELLO], project_dir: '/p' } } },
      { seq: 4, kind: 'msg', msg: { type: 'set_arrange' } },
    ];
    const cfg = configFromLog(log);
    eq(cfg.components, [FX_HELLO]);
  });
  it('null when there is no set_config entry / not an array', () => {
    eq(configFromLog([]), null);
    eq(configFromLog([{ kind: 'msg', msg: { type: 'set_arrange' } }]), null);
    eq(configFromLog(null), null);
  });
  it('round-trips into registerExternal (the exact replay-site call)', () => {
    const log = [{ kind: 'msg', msg: { type: 'set_config', config: { components: [FX_HELLO] } } }];
    const seen = [];
    registerExternal(configFromLog(log), c => seen.push(c.name));
    eq(seen, ['ext-hello']);
  });
});

describe('[external-components] parser — path resolution + validation', () => {
  it('resolves `.`-relative paths to absolute against project_dir; keeps bare names', () => {
    const cfg = parse(path.join(FIXTURES, 'ext-components.yml'));
    eq(cfg.components.length, 2);
    assert(path.isAbsolute(cfg.components[0]), 'relative entry resolved to absolute');
    assert(cfg.components[0].endsWith(path.join('fixtures', 'ext-hello.js')), `points at the fixture: ${cfg.components[0]}`);
    eq(cfg.components[1], 'some-bare-pkg');
  });
  it('a config with no components: yields an empty list', () => {
    const cfg = parse(path.join(FIXTURES, 'minimal_cmd.yml'));
    eq(cfg.components, []);
  });
  it('rejects a non-list components: value', () => {
    let threw = false;
    try { parse(path.join(FIXTURES, 'invalid_components.yml')); } catch (_) { threw = true; }
    assert(threw, 'expected a schema error for a scalar components:');
  });
});

// End-to-end: a PLACED external pane renders live, and reconstructs faithfully
// under replay in a SEPARATE process (external registration only via the WAL
// peek) — the two paths the unit tests above only cover in pieces.
describe('[external-components] end-to-end — placed pane renders + replays', () => {
  const R = path.join(__dirname, '..');
  const { parse } = require('../parser');
  const { getModel } = require('../app/runtime');
  const { loadConfig, initState } = require('../app/state');
  const replayCli = require('../app/replay-cli');
  const { render } = require('../render/paint');
  const CFG = path.join(FIXTURES, 'ext-placed.yml');

  const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '');
  const capture = (fn) => {
    const chunks = []; const orig = process.stdout.write;
    process.stdout.write = s => { chunks.push(String(s)); return true; };
    try { fn(); } finally { process.stdout.write = orig; }
    return strip(chunks.join(''));
  };

  it('a placed `type: ext-hello` pane renders in the live frame', () => {
    const cfg = parse(CFG);
    getModel().config = cfg;
    getModel().projectDir = cfg.project_dir;
    replayCli._installRuntime();                          // wires runtime + built-ins
    require('../app/external-components').registerExternal(cfg, api.registerComponent);
    initState();
    const frame = capture(() => render(getModel()));
    assert(frame.includes('EXTPANEL'), 'the external panel type rendered its marker');
  });

  it('reconstructs the external pane under --record-print (replay parity, fresh process)', () => {
    const os = require('os'); const fs = require('fs');
    const { spawnSync } = require('child_process');
    const wal = path.join(os.tmpdir(), `ext-parity-${process.pid}.jsonl`);
    try { fs.unlinkSync(wal); } catch (_) { /* fresh */ }

    // Record a session that places the external pane (set_config carries
    // `components:`; set_arrange places the pane).
    const sessionLog = require('../io/session-log');
    sessionLog.enable(true);
    sessionLog.setCheckpointCadence(sessionLog.DEFAULT_CHECKPOINT_CADENCE);
    sessionLog.attachStream(wal);
    loadConfig(CFG);
    require('../app/external-components').registerExternal(getModel().config, api.registerComponent);
    initState();
    sessionLog.enable(false);

    // Reconstruct in a SEPARATE process — the external component is registered
    // ONLY by the replay harness peeking the WAL's config.
    const out = spawnSync(process.execPath, [path.join(R, 'app', 'tui.js'), '--record-print', wal], { encoding: 'utf8' });
    try { fs.unlinkSync(wal); } catch (_) { /* best-effort */ }
    assert(/EXTPANEL/.test(out.stdout || ''), `replayed frame contains the external panel — stderr: ${out.stderr}`);
  });
});

// The run() library seam — how a compiled/embedded app boots (docs/packaging.md).
describe('[external-components] run() seam — library boot from an embedded config', () => {
  it('tui exports run() and does NOT auto-boot main() when required as a library', () => {
    // require.main !== module here → the CLI auto-run is guarded off. If the
    // guard regressed, requiring would run main() (no config → error/exit).
    const tui = require('../app/tui');
    assert(typeof tui.run === 'function', 'run() is the public library entry');
  });
  it('loadConfigObject seeds the model from a config OBJECT (no file read)', () => {
    const { loadConfigObject } = require('../app/state');
    const { getModel } = require('../app/runtime');
    const cfg = parse(path.join(FIXTURES, 'ext-components.yml'));  // resolved shape
    loadConfigObject(cfg, null);
    const m = getModel().config;
    assert(m && m.project_dir === cfg.project_dir, 'the config object landed in the model');
  });
});

report();
