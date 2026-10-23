/**
 * Hyphenated action names are legal fabric components (post-v0.6.30 fix).
 *
 * Pre-fix: fabric P1 (v0.6.8) added `isValidFabricName([A-Za-z_][A-Za-z0-9_]*)` on
 * the action name whenever the action declared `ports:`, because the action is
 * addressable as `name.port`. Hyphenated action names (`ddns-ping`,
 * `rotate-host-keys`) were legal everywhere else, so configs using them +
 * `args: '<hint>'` worked all through v0.6.8–v0.6.29. The args→ports P3
 * (v0.6.30) retired `args:`, so hyphenated-named actions that wanted an
 * interactive popup now had to rename — a UX regression.
 *
 * Fix: PORT names stay strict ([A-Za-z_][A-Za-z0-9_]*) because they bind as
 * POSIX env vars and must be `\w`-matchable in `{{name}}` holes. ACTION
 * (component) names relax to allow hyphens: `[A-Za-z_][A-Za-z0-9_-]*`. The
 * `.`-delimited `component.port` address scheme still splits unambiguously
 * (hyphen != dot).
 *
 * These tests pin the three touch points: (1) a new exported helper
 * `isValidFabricComponentName`, (2) parser-level acceptance of a hyphenated
 * action name alongside `ports.in`, (3) end-to-end resolution via the
 * action-runner so the fabric-field addr round-trips.
 *
 * Run: node js/test/test-hyphenated-action-ports.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const runner = require('../dispatch/runtime/action-runner');
const addr = require('../fabric/address');
const schema = require('../parser/schema');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

wireFabricHost();

const HYPHENATED_ACTION = {
  type: 'run',
  label: 'Ping DDNS',
  script: 'ping -c 1 "$host"',
  ports: { in: { host: { type: 'string', required: true, desc: 'hostname to ping' } } },
};

function boot() {
  sm.bootFresh({
    groups: { g: {
      name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
      actions: { 'ddns-ping': HYPHENATED_ACTION },
    } },
  });
}

describe('[hyphenated-action] fabric component names allow hyphens; port names stay strict', () => {
  it('exports a dedicated component-name validator (regression guard)', () => {
    assert(typeof addr.isValidFabricComponentName === 'function',
      'isValidFabricComponentName is exported alongside isValidFabricName');
  });

  it('component-name validator accepts hyphens; port-name validator rejects them', () => {
    assert(addr.isValidFabricComponentName('ddns-ping'), 'ddns-ping is a legal component');
    assert(addr.isValidFabricComponentName('rotate-host-keys'), 'rotate-host-keys is a legal component');
    assert(addr.isValidFabricComponentName('verify'), 'plain identifiers still legal');
    assert(!addr.isValidFabricComponentName('-leading'), 'leading hyphen rejected (must start with letter/underscore)');
    assert(!addr.isValidFabricComponentName('has.dot'), 'dots still rejected (address separator)');
    assert(!addr.isValidFabricComponentName(''), 'empty rejected');
    // Port names stay strict — they bind as POSIX env vars.
    assert(!addr.isValidFabricName('host-name'), 'port name with hyphen rejected (env-var constraint)');
    assert(addr.isValidFabricName('host_name'), 'port name with underscore ok');
  });

  it('parser accepts a hyphenated action name declaring ports.in (the main regression)', () => {
    const config = { groups: { g: { label: 'G', containers: [],
      actions: { 'ddns-ping': HYPHENATED_ACTION } } } };
    let threw = null;
    try { schema.validate(config, 'test'); } catch (e) { threw = e; }
    assert(threw == null, `parse should succeed, got: ${threw && threw.message}`);
  });

  it('parser still rejects a hyphenated PORT name (strict env-var rule preserved)', () => {
    const config = { groups: { g: { label: 'G', containers: [],
      actions: { 'ddns-ping': { type: 'run', script: 'echo', label: 'X',
        ports: { in: { 'host-name': { type: 'string' } } } } } } } };
    let threw = null;
    try { schema.validate(config, 'test'); } catch (e) { threw = e; }
    assert(threw != null, 'parse should reject hyphenated PORT name');
    assert(/port name must be an identifier/.test(threw && threw.message),
      `expected a port-name error, got: ${threw && threw.message}`);
  });

  it('parseFabricAddr round-trips a hyphenated component (`ddns-ping.host`)', () => {
    const parsed = addr.parseFabricAddr('ddns-ping.host');
    eq(parsed.component, 'ddns-ping');
    eq(parsed.port, 'host');
    eq(addr.formatFabricAddr('ddns-ping', 'host'), 'ddns-ping.host');
  });

  it('parseFabricAddr still rejects a hyphenated PORT segment', () => {
    let threw = null;
    try { addr.parseFabricAddr('ddns-ping.host-name'); } catch (e) { threw = e; }
    assert(threw != null, 'hyphenated port in address is rejected');
  });

  it('action-runner _promptMissing opens fabric-field with the hyphenated addr intact', () => {
    boot();
    const opened = runner._promptMissing('ddns-ping', HYPHENATED_ACTION,
      [{ port: 'host', reason: 'x' }]);
    assert(opened === true, 'modal opened');
    eq(getModel().modal.fabricField.addr, 'ddns-ping.host',
      'addr carries the hyphenated action name verbatim');
    assert(getModel().modal.fabricField.pendingAction.actionKey === 'ddns-ping',
      'pendingAction carries the hyphenated key for re-dispatch');
  });

  it('_resolvePortsForAction resolves an injected port on a hyphenated-named action', () => {
    boot();
    // Hand-inject the way the fabric-field submit arm would, scoped to the hyphenated addr.
    const m = getModel();
    m.fabric = m.fabric || {};
    m.fabric.injects = m.fabric.injects || {};
    m.fabric.injects.g = { 'ddns-ping.host': { value: 'example.com', at: 0 } };
    const r = runner._resolvePortsForAction('ddns-ping', HYPHENATED_ACTION, m);
    assert(r.ready, 'resolves ready with the injected value');
    eq(r.values, { host: 'example.com' }, 'values map keyed by port name as always');
  });
});

report();
