/**
 * Test harness — describe/it/assert/eq with aggregation and exception
 * isolation. Replaces the hand-rolled pass/fail counters that every
 * test-*.js used to carry.
 *
 * Usage:
 *
 *   const { describe, it, assert, eq, report } = require('./test-runner');
 *
 *   describe('hub', () => {
 *     it('drops samples with no subscribers', () => {
 *       hub._reset();
 *       hub.publish('docker.stats', 'a', { ts: 1, cpu: 10 });
 *       eq(hub.history('docker.stats', 'a'), [], 'no buffer allocated');
 *     });
 *   });
 *
 *   report();   // prints summary; exits 0 if all pass, 1 otherwise
 *
 * Design notes:
 * - Zero npm deps. Pure Node.js.
 * - Each `it` runs in a try/catch so a throw in one test doesn't abort
 *   the file. Failures collect with section + test context.
 * - `assert(cond, msg?)` and `eq(a, b, msg?)` are the only two
 *   assertion primitives. They accumulate counts inside the active
 *   `it` block (or default to the file-level suite for legacy linear
 *   tests that haven't been migrated yet).
 * - report() exits the process. Don't put code after it.
 *
 * Output format mirrors the old hand-rolled style (✓ / ✗ per check)
 * so eyeballing test output remains familiar.
 */
'use strict';

// --- Aggregator state ---

let _activeSection = null;     // currently-active describe block name
let _activeTest = null;        // currently-active it block name
let _failedTests = [];         // [{ section, test, msg, error? }]
let _passCount = 0;
let _failCount = 0;
let _testStartedCount = 0;     // # of `it` blocks entered
let _testFailedCount = 0;      // # of `it` blocks with at least one failure or thrown error
let _testFailedThis = false;   // did the active `it` already record a failure?

// --- Public API ---

/**
 * Group related tests under a section header. Sections may not be
 * nested — flat structure, mirroring the old `[N] header` style.
 */
function describe(name, fn) {
  if (_activeSection) {
    throw new Error(`[test-runner] nested describe('${name}') inside describe('${_activeSection}') — not supported`);
  }
  _activeSection = name;
  console.log(`\n${name}`);
  try { fn(); }
  catch (e) {
    // describe-level throw is unusual — most setup goes inside `it`.
    // Surface it under a synthetic test entry so report() flags it.
    _failCount++;
    _failedTests.push({ section: name, test: '<describe setup>', msg: e.message, error: e });
    console.error(`  ✗ <describe setup threw>: ${e.message}`);
  }
  _activeSection = null;
}

/**
 * Set the active section header without a body block. Useful for async
 * test chains (setTimeout/Promise sequences) where wrapping each step
 * in describe/it would require an awkward async-IIFE structure. Direct
 * assert/eq calls until the next `section()` (or end of file) are
 * attributed to this section.
 */
function section(name) {
  _activeSection = name;
  _activeTest = null;
  console.log(`\n${name}`);
}

/**
 * Single test case. Failures inside the function body (assertion
 * failures or thrown errors) are caught; the test is marked failed
 * and the rest of the file continues.
 */
function it(name, fn) {
  if (!_activeSection) {
    throw new Error(`[test-runner] it('${name}') called outside describe() — wrap in describe('section', () => { it(...) })`);
  }
  _activeTest = name;
  _testStartedCount++;
  _testFailedThis = false;
  try { fn(); }
  catch (e) {
    if (!_testFailedThis) _testFailedCount++;
    _failCount++;
    _failedTests.push({ section: _activeSection, test: name, msg: e.message, error: e });
    console.error(`  ✗ ${name}: ${e.message}`);
  }
  _activeTest = null;
}

/**
 * Boolean assertion. `msg` defaults to the active test name so single-
 * assertion `it` blocks don't have to repeat themselves.
 */
function assert(cond, msg) {
  const label = msg || _activeTest || '(unnamed assertion)';
  if (cond) {
    console.log(`  ✓ ${label}`);
    _passCount++;
    return true;
  }
  recordFail(label);
  return false;
}

/**
 * Deep equality via JSON.stringify. Same semantics as the old
 * `eq()` helper every test file shipped — handles primitives, arrays,
 * plain objects. NOT suitable for Maps, Sets, functions, or objects
 * with circular refs (use `assert` for those).
 */
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  const label = msg || _activeTest || '(unnamed eq)';
  if (sa === sb) {
    console.log(`  ✓ ${label}`);
    _passCount++;
    return true;
  }
  recordFail(`${label} (got ${sa}, want ${sb})`);
  return false;
}

function recordFail(label) {
  console.error(`  ✗ ${label}`);
  _failCount++;
  if (!_testFailedThis) {
    _testFailedThis = true;
    _testFailedCount++;
  }
  _failedTests.push({
    section: _activeSection || '<top>',
    test: _activeTest || '<top>',
    msg: label,
  });
}

/**
 * Print summary and exit. Code 0 if everything passed, 1 if any
 * assertion failed or any test threw. Always call this at the end
 * of a test file — it's how the discovery runner detects status.
 */
function report() {
  console.log();
  if (_failCount === 0) {
    if (_testStartedCount > 0) {
      const t = _testStartedCount === 1 ? 'test' : 'tests';
      console.log(`${_passCount} passed across ${_testStartedCount} ${t}`);
    } else {
      // Legacy linear style — no `it` blocks, just bare assertions.
      console.log(`${_passCount} passed, ${_failCount} failed`);
    }
    process.exit(0);
  }
  console.error(`\n${_passCount} passed, ${_failCount} failed (${_testFailedCount} test(s) with failures)`);
  for (const f of _failedTests) {
    console.error(`  - [${f.section}] ${f.test}: ${f.msg}`);
  }
  process.exit(1);
}

// --- Test-only state introspection (used by run-tests.js to detect
// whether a file forgot to call report()) ---

function _state() {
  return {
    pass: _passCount,
    fail: _failCount,
    testsStarted: _testStartedCount,
    testsFailed: _testFailedCount,
  };
}

// --- Core-Component registration (test-only auto-setup) ---
//
// In production tui.js registers all built-in Components at boot. Tests that
// only require state.js / components/api.js miss that step. Side-effect-on-
// import here gives every test a registered detail + groups slice from the
// start — same convenience the legacy `S` shim provided via lazy auto-
// register, but explicit at the test-harness level.
try {
  require('../effects').installBuiltins();
  const api = require('../components/api');
  // Phase 3 — layout MUST register first so other Components nest under
  // layout.slice.panels[name]. Production (tui.js) already orders this
  // way; tests need the same.
  if (!api.getComponentSlice('layout')) api.registerComponent(require('../components/layout'));
  if (!api.getComponentSlice('detail')) api.registerComponent(require('../components/viewer'));
  if (!api.getComponentSlice('groups')) api.registerComponent(require('../components/groups'));
} catch (_) { /* tests that don't need Components still load */ }

module.exports = { describe, section, it, assert, eq, report, _state };
