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

// --- Immutability helpers (pure-TEA conversion) ---
//
// Pre-Phase-1: most reducers mutate their slice/model arg in place. Phase
// 1 converts the leaves to return-new; Phases 2-4 do the same for
// Components and the root reducer. These helpers let a test assert that
// a function did NOT mutate its input — deep-freezes the input, calls
// the function, catches the TypeError that throws on any attempted
// write through a frozen path.

/**
 * Deep-freeze a plain-object / array tree. Walks own enumerable props;
 * skips Map/Set/Date/etc (the structured-clone-able tree we actually
 * use in slices is plain objects + arrays + the occasional Set, and
 * Sets/Maps don't honor freeze for their own writes — we work around
 * by treating them as opaque leaf cells via `_freezeLeafAware`).
 */
function deepFreeze(o) {
  if (!o || typeof o !== 'object') return o;
  if (Object.isFrozen(o)) return o;
  if (o instanceof Set || o instanceof Map) {
    // Sets/Maps don't honor Object.freeze for .add/.set/.delete — wrap
    // the mutating methods to throw instead so a mutation is observable.
    if (o instanceof Set) {
      o.add = () => { throw new TypeError('frozen Set: add'); };
      o.delete = () => { throw new TypeError('frozen Set: delete'); };
      o.clear = () => { throw new TypeError('frozen Set: clear'); };
    } else {
      o.set = () => { throw new TypeError('frozen Map: set'); };
      o.delete = () => { throw new TypeError('frozen Map: delete'); };
      o.clear = () => { throw new TypeError('frozen Map: clear'); };
    }
    return Object.freeze(o);
  }
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return Object.freeze(o);
}

/**
 * Assert that `fn` returns a value that is NOT the same reference as
 * `input` AND did not mutate `input`. Use to verify pure-reducer
 * behavior:
 *
 *     expectNoMutation('nav.apply set_cursor', () => {
 *       return nav.apply(slice, { type: 'set_cursor', panel: 'p', index: 3 });
 *     }, slice);
 *
 * Strict mode is required for the assignment-to-frozen-prop to throw
 * (it would silently no-op in sloppy mode). Test files run with
 * 'use strict' at the top.
 */
function expectNoMutation(label, fn, input) {
  deepFreeze(input);
  try {
    const out = fn();
    if (out === input) recordFail(`${label}: returned same ref (no clone)`);
    else _passCount++, console.log(`  ✓ ${label}`);
    return out;
  } catch (e) {
    recordFail(`${label}: threw on frozen input — likely in-place mutation (${e.message})`);
  }
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
// only require state.js / panel/api.js miss that step. Side-effect-on-
// import here gives every test a registered detail + groups slice from the
// start — same convenience the legacy `S` shim provided via lazy auto-
// register, but explicit at the test-harness level.
try {
  // Wire the panel-host seam (leaves/panel-host) — production does this in
  // tui.js#main before installBuiltins so panel's inverted up-calls (runEffects,
  // applyMsg, streamCommand, cleanup, showHelp) resolve. Tests miss main(), so
  // mirror it here. Must precede installBuiltins, exactly as in production.
  require('../dispatch/runtime/host-wiring').wirePanelHost();
  // nav-state writers dispatch through an injected host (B/S3) — wire it like
  // production (tui.js#main) so tests that drive writers / the finalizer work.
  require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
  require('../panel/commands').setCommandsDispatch(require('../dispatch/runtime/effects').effectHost());
  require('../dispatch/runtime/effects').installBuiltins();
  const api = require('../panel/api');
  // B/S6 test shim — the Component fan-out (dispatchMsg / dispatchKeyToFocused)
  // + setInstanceReconciler relocated to dispatch/runtime/fanout.js (the runtime lives
  // in the dispatch layer now). Production code calls them from there; the many
  // existing tests that drive them as `api.dispatchMsg(...)` keep working by
  // re-exposing them on the api object HERE (test-only; test/ is layering-exempt,
  // and api === fanout for these so assertions are unchanged). New tests should
  // require('../dispatch/runtime/fanout') directly.
  const fanout = require('../dispatch/runtime/fanout');
  api.dispatchMsg = fanout.dispatchMsg;
  api.dispatchKeyToFocused = fanout.dispatchKeyToFocused;
  api.setInstanceReconciler = fanout.setInstanceReconciler;
  // layout MUST register first — chrome owner + focus reader's primary
  // instance. Production (tui.js) already orders this way; tests need
  // the same.
  // getComponent (spec registry), not a slice read: post split-arc P2
  // an instance probe strictly misses once initState swapped the seed
  // for per-pane mints, and would re-register the Component mid-suite.
  if (!api.getComponent('layout')) api.registerComponent(require('../panel/layout'));
  if (!api.getComponent('detail')) api.registerComponent(require('../panel/viewer/viewer'));
  if (!api.getComponent('groups')) api.registerComponent(require('../panel/navigator/groups'));
} catch (_) { /* tests that don't need Components still load */ }

module.exports = { describe, section, it, assert, eq, report, _state,
                   deepFreeze, expectNoMutation };
