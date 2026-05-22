/**
 * Parser error hierarchy. JS port of tests/test_errors.py.
 *
 * Pins the same `message`, `context`, and `line` composition the
 * Python ParseError used to provide.
 *
 *   node js/test/test-parser-errors.js
 */
'use strict';

const { ParseError, SchemaError, ResolutionError } = require('../parser/errors');
const { describe, it, assert, eq, report } = require('./test-runner');

describe('ParseError — message composition', () => {
  it('plain message', () => { eq(new ParseError('bad input').message, 'bad input'); });
  it('with context',  () => { eq(new ParseError('missing field', { context: "group 'core'" }).message, "group 'core': missing field"); });
  it('with line',     () => { eq(new ParseError('bad type', { line: 42 }).message, 'line 42: bad type'); });
  it('with context and line', () => {
    eq(new ParseError('oops', { context: "action 'up'", line: 10 }).message, "line 10: action 'up': oops");
  });
});

describe('ParseError — attributes', () => {
  it('context + line attrs',     () => {
    const e = new ParseError('msg', { context: 'ctx', line: 7 });
    eq(e.context, 'ctx'); eq(e.line, 7);
  });
  it('no context / line → null', () => {
    const e = new ParseError('plain');
    eq(e.context, null); eq(e.line, null);
  });
});

describe('subclass identity', () => {
  it('SchemaError extends ParseError', () => {
    const e = new SchemaError('bad schema');
    assert(e instanceof ParseError, 'instanceof ParseError');
    assert(e instanceof SchemaError, 'instanceof SchemaError');
  });
  it('ResolutionError extends ParseError', () => {
    const e = new ResolutionError('undefined var');
    assert(e instanceof ParseError, 'instanceof ParseError');
    assert(e instanceof ResolutionError, 'instanceof ResolutionError');
  });
});

describe('subclass message composition', () => {
  it('SchemaError with context',      () => {
    assert(new SchemaError('wrong type', { context: "group 'vpn', action 'up'" })
      .message.includes("group 'vpn', action 'up'"));
  });
  it('ResolutionError with context',  () => {
    assert(new ResolutionError("no helper 'foo'", { context: "action 'init'" })
      .message.includes("action 'init'"));
  });
});

report();
