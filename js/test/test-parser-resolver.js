/**
 * Resolver — variable + helper expansion. JS port of tests/test_resolver.py.
 *
 *   node js/test/test-parser-resolver.js
 */
'use strict';

const { passthroughCmd, resolveScript } = require('../parser/resolver');
const { ResolutionError } = require('../parser/errors');
const { describe, it, assert, eq, report } = require('./test-runner');

function expectThrow(re, fn) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, 'expected throw');
  if (threw) assert(re.test(threw.message), `error message: ${threw.message}`);
  return threw;
}

describe('passthroughCmd', () => {
  it('verbatim, no vars/helpers tracked', () => {
    const r = passthroughCmd('docker compose up -d');
    eq(r.script, 'docker compose up -d');
    eq(r.varsUsed, {});
    eq(r.helpersUsed, []);
  });
});

describe('variable resolution', () => {
  it('$VAR substitutes', () => {
    const { script, varsUsed } = resolveScript('ssh -i $KEY_FILE root@localhost',
      { KEY_FILE: 'client/id_ed25519' }, {}, 'test');
    eq(script, 'ssh -i client/id_ed25519 root@localhost');
    eq(varsUsed, { KEY_FILE: 'client/id_ed25519' });
  });
  it('${VAR} braced substitutes', () => {
    const { script, varsUsed } = resolveScript('echo ${KEY_FILE}', { KEY_FILE: 'foo' }, {}, 'test');
    eq(script, 'echo foo');
    eq(varsUsed, { KEY_FILE: 'foo' });
  });
  it('multiple vars', () => {
    const { script, varsUsed } = resolveScript('ssh -i $KEY -p $PORT host',
      { KEY: 'k', PORT: '22' }, {}, 'test');
    eq(script, 'ssh -i k -p 22 host');
    eq(varsUsed, { KEY: 'k', PORT: '22' });
  });
  it('unknown $FOO left alone', () => {
    const { script, varsUsed } = resolveScript('echo $HOME $MY_VAR',
      { MY_VAR: 'x' }, {}, 'test');
    eq(script, 'echo $HOME x');
    eq(varsUsed, { MY_VAR: 'x' });
  });
  it("shell builtins ($?, $1, $@) untouched", () => {
    const { script, varsUsed } = resolveScript('echo $? $1 "$@"', {}, {}, 'test');
    eq(script, 'echo $? $1 "$@"');
    eq(varsUsed, {});
  });
  it('vars_used only tracks used keys', () => {
    const { varsUsed } = resolveScript('echo $A', { A: '1', B: '2', C: '3' }, {}, 'test');
    eq(varsUsed, { A: '1' });
  });
});

describe('helper resolution', () => {
  it('@use expands', () => {
    const { script, helpersUsed } = resolveScript('@use greet\necho done\n',
      {}, { greet: 'echo hello\n' }, 'test');
    assert(script.includes('echo hello'), 'helper body inlined');
    assert(script.includes('echo done'), 'tail preserved');
    eq(helpersUsed, ['greet']);
  });
  it('undefined helper → ResolutionError', () => {
    const e = expectThrow(/undefined helper 'nope'/, () =>
      resolveScript('@use nope\n', {}, {}, 'test'));
    assert(e instanceof ResolutionError, 'is ResolutionError');
  });
  it('vars inside helper body resolved after expansion', () => {
    const { script, varsUsed, helpersUsed } = resolveScript('@use setup\n',
      { FILE: 'x.txt' }, { setup: 'cat $FILE\n' }, 'test');
    assert(script.includes('cat x.txt'), 'var inside helper substituted');
    eq(varsUsed, { FILE: 'x.txt' });
    eq(helpersUsed, ['setup']);
  });
  it('multiple @use', () => {
    const { script, helpersUsed } = resolveScript('@use a\n@use b\n',
      {}, { a: 'echo A\n', b: 'echo B\n' }, 'test');
    assert(script.includes('echo A') && script.includes('echo B'));
    eq(helpersUsed, ['a', 'b']);
  });
  it('helpers_used tracks only used', () => {
    const { helpersUsed } = resolveScript('@use x\n',
      {}, { x: 'echo\n', y: 'echo\n' }, 'test');
    eq(helpersUsed, ['x']);
  });
  it('@use must be whole-line (mid-line is preserved)', () => {
    const { script, helpersUsed } = resolveScript('echo @use foo\n',
      {}, { foo: 'REPLACED\n' }, 'test');
    assert(script.includes('echo @use foo'), 'literal preserved');
    eq(helpersUsed, []);
  });
  it('no vars / no helpers → identity', () => {
    const { script, varsUsed, helpersUsed } = resolveScript('echo plain\n', {}, {}, 'test');
    eq(script, 'echo plain\n');
    eq(varsUsed, {}); eq(helpersUsed, []);
  });
  it('@use preserves indentation', () => {
    const { script } = resolveScript('if true; then\n    @use body\nfi\n',
      {}, { body: 'echo ok\n' }, 'test');
    assert(script.includes('    echo ok'), 'helper body indented to @use');
  });
  it('error includes context', () => {
    expectThrow(/action 'init'/, () =>
      resolveScript('@use missing\n', {}, {}, "action 'init'"));
  });
});

report();
