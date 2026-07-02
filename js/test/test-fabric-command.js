/**
 * Command templates — no-shell argv compile/fill (docs/ports-and-wires.md,
 * "Command model"). Proves bind-parameter safety: values are placed as literal
 * argv elements, never re-parsed.
 * Run: node js/test/test-fabric-command.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { compileCommand, tokenize, commandHoles, fillCommand } = require('../fabric/command');

function throws(fn) { try { fn(); return false; } catch { return true; } }

describe('[fabric-command] compileCommand', () => {
  it('passes a list form through', () => {
    eq(compileCommand(['xlogminer', '--start', '{{start_lsn}}']).join('|'),
       'xlogminer|--start|{{start_lsn}}');
  });
  it('tokenizes a string form', () => {
    eq(compileCommand('xlogminer --start {{start_lsn}}').length, 3);
  });
  it('rejects a non-list/string', () => {
    assert(throws(() => compileCommand(42)));
  });
});

describe('[fabric-command] tokenize', () => {
  it('groups a double-quoted span into one element', () => {
    const t = tokenize('mytool --msg "hello world"');
    eq(t.length, 3); eq(t[2], 'hello world');
  });
  it('concatenates quoted + unquoted (--flag="a b")', () => {
    eq(tokenize('--flag="a b"')[0], '--flag=a b');
  });
  it('keeps {{holes}} intact and handles single quotes', () => {
    const t = tokenize("t '{{a}}' {{b}}");
    eq(t[1], '{{a}}'); eq(t[2], '{{b}}');
  });
});

describe('[fabric-command] commandHoles', () => {
  it('collects unique referenced holes', () => {
    const holes = commandHoles(['x', '--start', '{{start_lsn}}', '--flag={{start_lsn}}', '{{end_lsn}}']);
    eq(holes.sort().join(','), 'end_lsn,start_lsn');
  });
});

describe('[fabric-command] fillCommand', () => {
  const tmpl = ['xlogminer', '--start', '{{start_lsn}}', '--end', '{{end_lsn}}'];
  it('fills whole-element holes', () => {
    const argv = fillCommand(tmpl, { start_lsn: '0/1A2B3C0', end_lsn: '0/2000000' });
    eq(argv.join(' '), 'xlogminer --start 0/1A2B3C0 --end 0/2000000');
  });
  it('fills an embedded hole by concatenation', () => {
    eq(fillCommand(['--flag={{x}}'], { x: 'v' })[0], '--flag=v');
    eq(fillCommand(['{{dir}}/{{file}}'], { dir: 'logs', file: 'wal.42' })[0], 'logs/wal.42');
  });
  it('splices a list-valued whole-element hole into N args', () => {
    const argv = fillCommand(['tool', '{{files}}'], { files: ['a', 'b', 'c'] });
    eq(argv.join(' '), 'tool a b c');
  });
  it('omits an undefined whole-element hole; empties an undefined embedded hole', () => {
    eq(fillCommand(['tool', '{{opt}}'], {}).join(' '), 'tool');
    eq(fillCommand(['--x={{opt}}'], {})[0], '--x=');
  });
  it('delivers special chars as ONE literal argument (bind-parameter safety)', () => {
    const nasty = 'a b; $(whoami) `id` "q" \'s\' | rm -rf /';
    const argv = fillCommand(['tool', '{{x}}'], { x: nasty });
    eq(argv.length, 2, 'still exactly two argv elements — no splitting');
    eq(argv[1], nasty, 'value passed through verbatim, never re-parsed');
  });
});

report();
