/**
 * bounded-match — the wall-clock ceiling on regex matching (ReDoS defense).
 *
 * Pins: (1) the worker path produces the SAME matches as the pure scan for a
 * benign pattern; (2) a catastrophic paren-free pattern (`a*a*…X`) that the shape
 * guard in regex-guard ACCEPTS — and that froze Node for 76s in review round 4 —
 * now returns [] within a small multiple of the budget instead of hanging; (3)
 * the probe verdicts for both the search and files-filter vectors.
 *
 * Run: node js/test/test-bounded-match.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const ms = require('../leaves/text/search');
const mc = require('../leaves/text/match-core');
const bounded = require('../leaves/text/bounded-match');

// A paren-free sequential-quantifier bomb: passes safeRegex (no nested parens,
// < 200 chars) yet backtracks super-polynomially against a run of the same char.
const BOMB = 'a*'.repeat(30) + 'X';
const BOMB_LINE = ['a'.repeat(40)];   // 40 'a's, no 'X' → forces the full backtrack

describe('[bounded-match] benign pattern — worker path matches the pure scan', () => {
  it('matchesFor returns the same result computeMatches would', () => {
    const lines = ['hello foo world', 'no match here', 'foo again foo'];
    const got = ms.matchesFor(lines, 'foo');
    eq(JSON.stringify(got), JSON.stringify(mc.computeMatches([...lines], 'foo')));
    eq(got.length, 3);
    eq(got[0], { line: 0, col: 6, len: 3 });
  });
  it('probeSearch on a benign pattern is "safe"', () => {
    eq(bounded.probeSearch(['foo bar baz'], 'ba'), 'safe');
  });
});

describe('[bounded-match] catastrophic pattern is BOUNDED, not a freeze', () => {
  it('probeSearch on the bomb times out well under a second (budget-capped)', () => {
    const t = Date.now();
    const verdict = bounded.probeSearch(BOMB_LINE, BOMB);
    const ms_elapsed = Date.now() - t;
    eq(verdict, 'timedOut');
    assert(ms_elapsed < 2000, `bomb probe took ${ms_elapsed}ms (should be ~budget, not a freeze)`);
  });
  it('matchesFor on the bomb returns [] instead of hanging', () => {
    const t = Date.now();
    const got = ms.matchesFor(BOMB_LINE, BOMB);   // fresh array → real probe, not a memo hit
    const ms_elapsed = Date.now() - t;
    eq(got.length, 0);
    assert(ms_elapsed < 2000, `matchesFor(bomb) took ${ms_elapsed}ms (should be budget-capped)`);
  });
  it('probeFilter on the bomb times out; a benign filter is safe', () => {
    eq(bounded.probeFilter(['a'.repeat(40), 'b'.repeat(40)], BOMB, 'i'), 'timedOut');
    eq(bounded.probeFilter(['foo.txt', 'bar.js', 'baz.md'], 'ba', 'i'), 'safe');
  });
});

bounded._dispose();   // terminate the worker so the test process exits promptly
report();
