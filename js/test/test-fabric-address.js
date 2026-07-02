/**
 * Fabric address parsing — `component.port` (decision 4).
 * Run: node js/test/test-fabric-address.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { isValidFabricName, parseFabricAddr, formatFabricAddr } = require('../fabric/address');

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

describe('[fabric] isValidFabricName', () => {
  it('accepts identifiers', () => {
    for (const s of ['foo', 'foo_1', '_x', 'redo_lsn', 'C']) assert(isValidFabricName(s), s);
  });
  it('rejects non-identifiers', () => {
    for (const s of ['1x', 'a.b', 'a-b', 'a b', '', 'a!b']) assert(!isValidFabricName(s), s);
  });
  it('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}]) assert(!isValidFabricName(v), String(v));
  });
});

describe('[fabric] parseFabricAddr', () => {
  it('parses component.port', () => {
    const a = parseFabricAddr('controldata.redo_lsn');
    eq(a.component, 'controldata');
    eq(a.port, 'redo_lsn');
  });
  it('rejects a bare name (no dot)', () => {
    assert(throws(() => parseFabricAddr('nodot')), 'no dot must throw');
  });
  it('rejects cross-group (>1 dot) with a forward message', () => {
    let msg = '';
    try { parseFabricAddr('pg.controldata.redo_lsn'); } catch (e) { msg = e.message; }
    assert(/cross-group/.test(msg), `expected cross-group hint, got: ${msg}`);
  });
  it('rejects non-identifier parts', () => {
    assert(throws(() => parseFabricAddr('1bad.port')), 'leading digit');
    assert(throws(() => parseFabricAddr('comp.with-hyphen')), 'hyphen');
    assert(throws(() => parseFabricAddr('comp.with space')), 'space');
  });
  it('rejects empty / non-string', () => {
    assert(throws(() => parseFabricAddr('')), 'empty');
    assert(throws(() => parseFabricAddr(null)), 'null');
  });
});

describe('[fabric] formatFabricAddr', () => {
  it('round-trips with parse', () => {
    const s = formatFabricAddr('xlogminer', 'start_lsn');
    eq(s, 'xlogminer.start_lsn');
    const a = parseFabricAddr(s);
    eq(a.component, 'xlogminer');
    eq(a.port, 'start_lsn');
  });
});

report();
