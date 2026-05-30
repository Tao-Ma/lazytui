/**
 * Cmdline args plumbing — buffer split + actual shell positional delivery.
 *
 * Buffer split is sync; the shell delivery test spawns sh and reads stdout
 * via section() + setTimeout (mirrors test-docker-events.js's pattern for
 * async assertions inside the home-grown test runner).
 *
 * Run: node js/test/test-cmdline-args.js
 */
'use strict';

const { spawn } = require('child_process');
const { _splitQuery: splitQuery } = require('../dispatch/cmdline');
const { describe, it, eq, section, report } = require('./test-runner');

describe('[1] no whitespace → query only, empty args', () => {
  it('plain word', () => {
    const r = splitQuery('tail');
    eq(r.query, 'tail', 'query');
    eq(r.args.length, 0, 'no args');
  });
  it('empty buffer', () => {
    const r = splitQuery('');
    eq(r.query, '', 'empty query');
    eq(r.args.length, 0, 'no args');
  });
});

describe('[2] one arg', () => {
  it('tail 50', () => {
    const r = splitQuery('tail 50');
    eq(r.query, 'tail', 'query');
    eq(r.args.length, 1, 'one arg');
    eq(r.args[0], '50', 'first arg');
  });
});

describe('[3] multi args + extra whitespace', () => {
  it('tail 100 -f --since=10m', () => {
    const r = splitQuery('tail 100 -f --since=10m');
    eq(r.query, 'tail', 'query');
    eq(r.args.length, 3, 'three args');
    eq(r.args[2], '--since=10m', 'last arg');
  });
  it('collapses runs of whitespace', () => {
    const r = splitQuery('tail   100    -f');
    eq(r.args.length, 2, 'two args');
    eq(r.args[0], '100', 'first');
    eq(r.args[1], '-f', 'second');
  });
});

describe('[4] trailing whitespace = empty args', () => {
  it('tail (with trailing space)', () => {
    const r = splitQuery('tail ');
    eq(r.query, 'tail', 'query');
    eq(r.args.length, 0, 'no args (whitespace consumed)');
  });
});

// --- Actual shell delivery — does sh see the right $@ ? ---

section('[5] sh -c "$cmd" -- a b c → script body sees $1, $2, $#');
const proc = spawn('sh', ['-c', 'printf "%s\\n" "$#" "$@"', '--', 'foo', 'bar baz'], { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
proc.stdout.on('data', d => { out += d.toString('utf8'); });
proc.on('close', () => {
  const lines = out.trim().split('\n');
  eq(lines[0], '2', '$# = 2');
  eq(lines[1], 'foo', '$1 = foo');
  eq(lines[2], 'bar baz', '$2 = "bar baz" (preserves spaces in single arg)');
  report();
});
