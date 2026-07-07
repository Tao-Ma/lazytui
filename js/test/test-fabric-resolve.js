/**
 * Input resolution & readiness (decision 5) — the precedence fallback chain
 * inject > wire > default > (required ? error : omit), with precise reasons.
 * Run: node js/test/test-fabric-resolve.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { resolveInputs } = require('../fabric/resolve');

const INPUTS = {
  start_lsn: { type: 'pg.lsn', required: true },
  end_lsn:   { type: 'pg.lsn', required: true },
  timeline:  { type: 'pg.tli', required: false, default: 1 },
};
const WIRES = [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }];

// portValue that reports controldata.redo_lsn = <lsn> and nothing else.
function pv(lsn) {
  return (comp, port) => (comp === 'controldata' && port === 'redo_lsn') ? lsn : undefined;
}

describe('[fabric-resolve] precedence', () => {
  it('inject beats wire and default', () => {
    const r = resolveInputs('xlogminer', INPUTS, {
      injects: { 'xlogminer.start_lsn': { value: 'INJ' } },
      wires: WIRES,
      portValue: pv('WIRE'),
    });
    eq(r.values.start_lsn, 'INJ');
    eq(r.sources.start_lsn, 'inject');
  });

  it('wire resolves when the upstream has a value', () => {
    const r = resolveInputs('xlogminer', INPUTS, {
      injects: { 'xlogminer.end_lsn': { value: 'E' } },   // satisfy the other required
      wires: WIRES,
      portValue: pv('0/1A2B3C0'),
    });
    eq(r.values.start_lsn, '0/1A2B3C0');
    eq(r.sources.start_lsn, 'wire');
    eq(r.values.timeline, 1);
    eq(r.sources.timeline, 'default');
    assert(r.ready, 'all required resolved');
  });

  it('optional default applies; optional-without-source is omitted', () => {
    const r = resolveInputs('xlogminer', { timeline: { required: false, default: 7 }, note: { required: false } }, {});
    eq(r.values.timeline, 7);
    assert(!('note' in r.values), 'optional with no source is omitted, not missing');
    assert(r.ready);
  });
});

describe('[fabric-resolve] readiness errors', () => {
  it('unset required → "unset — wire it or send a value"', () => {
    const r = resolveInputs('xlogminer', INPUTS, { wires: WIRES, portValue: pv('L') });
    // start_lsn resolves via wire; end_lsn has no source
    assert(!r.ready);
    const m = r.missing.find(x => x.port === 'end_lsn');
    assert(m && /unset — wire it/.test(m.reason), m && m.reason);
  });

  it('wired-but-upstream-empty → names the upstream and "run … first"', () => {
    const r = resolveInputs('xlogminer', INPUTS, {
      injects: { 'xlogminer.end_lsn': { value: 'E' } },
      wires: WIRES,
      portValue: pv(undefined),   // controldata has produced nothing
    });
    assert(!r.ready);
    const m = r.missing.find(x => x.port === 'start_lsn');
    assert(m && /controldata\.redo_lsn has no value yet — run controldata first/.test(m.reason), m && m.reason);
  });

  it('a null upstream (fields no-match) falls through like undefined, not ready', () => {
    // P1.5 review — the `fields` parser projects null on no-match; resolve must
    // treat it as absent (`!= null`), agreeing with the inspector/wire-list.
    const r = resolveInputs('xlogminer', { start_lsn: { type: 'pg.lsn', required: true } }, {
      wires: WIRES, portValue: pv(null),
    });
    assert(!r.ready, 'null upstream is not a bound value');
    assert(r.missing.some(x => x.port === 'start_lsn'));
  });

  it('a falsy 0 / "" UPSTREAM value on a wire IS honored (real value, != null)', () => {
    for (const real of [0, '']) {
      const r = resolveInputs('xlogminer', { start_lsn: { type: 'pg.lsn', required: true } }, {
        wires: WIRES, portValue: () => real,
      });
      eq(r.values.start_lsn, real);
      eq(r.sources.start_lsn, 'wire');
    }
  });

  it('an undefined-valued inject does not shadow a working wire (L6)', () => {
    const r = resolveInputs('xlogminer', { start_lsn: { type: 'pg.lsn', required: true } }, {
      injects: { 'xlogminer.start_lsn': { value: undefined } },
      wires: WIRES,
      portValue: pv('0/WIRED'),
    });
    eq(r.values.start_lsn, '0/WIRED');
    eq(r.sources.start_lsn, 'wire');
  });

  it('a falsy "" inject IS honored (not treated as absent)', () => {
    const r = resolveInputs('xlogminer', { start_lsn: { required: false } }, {
      injects: { 'xlogminer.start_lsn': { value: '' } },
    });
    eq(r.values.start_lsn, '');
    eq(r.sources.start_lsn, 'inject');
  });

  it('wired-but-empty falls through to a default when present', () => {
    const r = resolveInputs('c', { x: { required: true, default: 'D' } }, {
      wires: [{ from: 'up.o', to: 'c.x' }],
      portValue: () => undefined,
    });
    eq(r.values.x, 'D');
    eq(r.sources.x, 'default');
    assert(r.ready);
  });
});

report();
