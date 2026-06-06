/**
 * Register smoke test — push/cap/evict/drop/promote/dedupe.
 *
 * Run: node js/test/test-register.js
 */
'use strict';

// Suppress OSC52 emits during the test run — register's push/promote
// calls term.stdout.write with a `\x1b]52;c;...\x07` payload. Wrap
// write to filter only that sequence; ordinary test output still flows.
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const reg = require('./_helpers/register');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');


function reset(cap) {
  reg.init({ cap });
  reg.clear();
}

describe('[1] init', () => {
  it('default cap is 100', () => {
    reg.init();
    eq(getModel().register.cap, 100, 'default cap');
    eq(getModel().register.history.length, 0, 'history empty');
  });
  it('positive int cap honored; invalid falls back to default', () => {
    reg.init({ cap: 7 });
    eq(getModel().register.cap, 7, 'honors 7');
    reg.init({ cap: 0 });
    eq(getModel().register.cap, 100, '0 invalid → default');
    reg.init({ cap: -3 });
    eq(getModel().register.cap, 100, 'negative invalid → default');
    reg.init({ cap: 1.5 });
    eq(getModel().register.cap, 100, 'non-integer invalid → default');
  });
});

describe('[2] push + top + at + historyLen', () => {
  it('push prepends; top is most-recent', () => {
    reset(10);
    reg.push('a');
    reg.push('b');
    reg.push('c');
    eq(reg.top(), 'c', 'top = c');
    eq(reg.at(0), 'c', 'at(0) = c');
    eq(reg.at(1), 'b', 'at(1) = b');
    eq(reg.at(2), 'a', 'at(2) = a');
    eq(reg.historyLen(), 3, 'len 3');
  });
  it('empty/non-string push is no-op', () => {
    reset(10);
    reg.push('');
    reg.push(null);
    reg.push(undefined);
    reg.push(42);
    eq(reg.historyLen(), 0, 'no entries pushed');
  });
});

describe('[3] dedup on top', () => {
  it('pushing same value as top is no-op (history unchanged)', () => {
    reset(10);
    reg.push('x');
    reg.push('x');
    reg.push('x');
    eq(reg.historyLen(), 1, 'single entry');
    eq(reg.top(), 'x', 'top still x');
  });
  it('pushing same value as a non-top entry still prepends', () => {
    reset(10);
    reg.push('a');
    reg.push('b');
    reg.push('a');
    eq(reg.historyLen(), 3, 'three entries — non-top dup is fine');
    eq(reg.at(0), 'a');
    eq(reg.at(1), 'b');
    eq(reg.at(2), 'a');
  });
});

describe('[4] cap eviction', () => {
  it('oldest entry evicted past cap', () => {
    reset(3);
    reg.push('a');
    reg.push('b');
    reg.push('c');
    reg.push('d');
    eq(reg.historyLen(), 3, 'capped at 3');
    eq(reg.at(0), 'd');
    eq(reg.at(1), 'c');
    eq(reg.at(2), 'b');
    assert(!getModel().register.history.includes('a'), 'a evicted');
  });
});

describe('[5] drop', () => {
  it('drop removes entry at index; out-of-range returns false', () => {
    reset(10);
    reg.push('a');
    reg.push('b');
    reg.push('c');
    eq(reg.drop(1), true, 'drop middle');
    eq(reg.historyLen(), 2);
    eq(reg.at(0), 'c');
    eq(reg.at(1), 'a');
    eq(reg.drop(5), false, 'oob');
    eq(reg.drop(-1), false, 'negative');
  });
});

describe('[6] promote', () => {
  it('promote moves entry to front; index 0 is no-op', () => {
    reset(10);
    reg.push('a');
    reg.push('b');
    reg.push('c');
    eq(reg.promote(2), true, 'promote a from tail');
    eq(reg.top(), 'a', 'a now top');
    eq(reg.at(1), 'c');
    eq(reg.at(2), 'b');
    eq(reg.promote(0), false, 'index 0 is no-op');
    eq(reg.promote(99), false, 'oob');
  });
});

report();
