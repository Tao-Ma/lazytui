/**
 * Fabric declarative parse / project / extract (decision 3).
 * Run: node js/test/test-fabric-parse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { compileParse, projectFrom, compileExtract, parseKv, splitLines } = require('../fabric/parse');

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// A pg_controldata-shaped fixture: ugly keys, a `:` inside a value.
const CONTROLDATA = [
  "pg_control version number:            1300",
  "Latest checkpoint's REDO location:    0/1A2B3C0",
  "Time of latest checkpoint:            Wed 01 Jul 2026 12:03:04",
  "blank line follows",
  "",
].join('\n');

describe('[fabric] parse: kv', () => {
  const parse = compileParse({ kv: { sep: ':' } });
  const rec = parse(CONTROLDATA);
  it('trims key and value', () => {
    eq(rec["Latest checkpoint's REDO location"], '0/1A2B3C0');
  });
  it('splits on the FIRST sep only (sep inside value survives)', () => {
    eq(rec['Time of latest checkpoint'], 'Wed 01 Jul 2026 12:03:04');
  });
  it('skips lines without the sep', () => {
    assert(!('blank line follows' in rec), 'no-sep line should be skipped');
  });
  it('defaults sep to ":"', () => {
    const r = compileParse({ kv: {} })('a: 1\nb: 2');
    eq(r.a, '1'); eq(r.b, '2');
  });
});

describe('[fabric] parse: json', () => {
  it('parses valid JSON', () => {
    const r = compileParse({ json: true })('{"lsn":"0/1A2B3C0","n":3}');
    eq(r.lsn, '0/1A2B3C0'); eq(r.n, 3);
  });
  it('returns null on invalid JSON (no crash)', () => {
    eq(compileParse({ json: true })('not json'), null);
  });
});

describe('[fabric] parse: lines', () => {
  it('splits and drops a single trailing empty line', () => {
    const r = compileParse({ lines: true })('a\nb\nc\n');
    eq(r.length, 3); eq(r[0], 'a'); eq(r[2], 'c');
  });
});

describe('[fabric] parse: fields (regex table, P1.5)', () => {
  const parse = compileParse({ fields: {
    redo_lsn: { regex: "REDO location:\\s*(\\S+)" },
    tli:      { regex: "TimeLineID:\\s*(\\d+)" },   // not present in the fixture
  } });
  const rec = parse(CONTROLDATA);
  it('extracts each field via its own regex into one record', () => {
    eq(rec.redo_lsn, '0/1A2B3C0');
  });
  it('a field whose regex does not match is null (→ check-half ✗ no-match)', () => {
    eq(rec.tli, null);
    assert('tli' in rec, 'the field is present as null, not omitted');
  });
  it('a bad field regex throws at compile (load-time error)', () => {
    assert(throws(() => compileParse({ fields: { x: { regex: '(' } } })), 'unbalanced regex');
    assert(throws(() => compileParse({ fields: { x: { notaregex: true } } })), 'missing regex');
  });
});

describe('[fabric] compileParse errors', () => {
  it('throws on unknown kind', () => {
    assert(throws(() => compileParse({ toml: true })), 'unknown kind');
    assert(throws(() => compileParse(null)), 'non-mapping');
  });
});

describe('[fabric] projectFrom', () => {
  const rec = { a: '1', b: '2' };
  it('selects a key', () => eq(projectFrom(rec, 'a'), '1'));
  it('missing key → undefined', () => eq(projectFrom(rec, 'z'), undefined));
  it('null record → undefined', () => eq(projectFrom(null, 'a'), undefined));
  it('null key → whole record (e.g. lines array)', () => {
    const arr = ['x', 'y'];
    eq(projectFrom(arr, null), arr);
  });
});

describe('[fabric] compileExtract', () => {
  it('captures group 1 by default', () => {
    const ex = compileExtract({ regex: 'REDO location:\\s*(\\S+)' });
    eq(ex(CONTROLDATA), '0/1A2B3C0');
  });
  it('honors an explicit group', () => {
    const ex = compileExtract({ regex: '(\\d+)/(\\w+)', group: 2 });
    eq(ex('0/1A2B3C0'), '1A2B3C0');
  });
  it('no match → null', () => {
    eq(compileExtract({ regex: 'nope(\\d+)' })('abc'), null);
  });
  it('throws on malformed spec', () => {
    assert(throws(() => compileExtract({})), 'missing regex');
  });
});

report();
