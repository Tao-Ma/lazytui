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
  it('absent / empty / non-array → no components (no throw)', () => {
    eq(externalComponents(null), []);
    eq(externalComponents({}), []);
    eq(externalComponents({ components: [] }), []);
    eq(externalComponents({ components: 'nope' }), []);
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
    const api = require('../panel/api');
    api.registerComponent(require('../panel/layout'));   // enforced-first chrome
    registerExternal({ components: [FX_HELLO] }, api.registerComponent);
    const got = api.getComponent('ext-hello');
    assert(got && got.name === 'ext-hello', 'ext-hello resolvable from the registry');
    assert(got.panelTypes && got.panelTypes['ext-hello'], 'its panel type is registered');
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

report();
