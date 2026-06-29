/**
 * E9 (v0.6.7) — keymap reserved-set DRIFT TRIPWIRE.
 *
 * `_SHADOWED_NORMAL_KEYS` is a hand-maintained mirror of handleNormalKey's
 * switch; the keymap's reserved set is derived from it. If a future switch case
 * is added without reserving its key, a `keymap.normal` bind would silently
 * shadow it (the review-round BLOCKER: space / T / digits). This test enforces
 * the invariant BEHAVIORALLY — it does NOT re-list the switch (that second list
 * would drift too). It drives the REAL handleNormalKey for every key with an
 * empty keymap and asserts:
 *
 *     a key that makes the switch ACT (dispatches a Msg) must be either
 *     remappable (in the keymap table) or reserved — never silently bindable.
 *
 * "Acts" is detected via the session-log middleware tap (every applyMsg /
 * dispatchMsg records a Msg when recording is on), so no dispatch ref needs
 * monkeypatching. A new unreserved switch case → a red test on the commit that
 * adds it, naming the key.
 *
 * Run: node js/test/test-keymap-drift.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const dispatch = require('../dispatch/control/dispatch');
const km = require('../leaves/input/keymap');
const sessionLog = require('../io/session-log');

const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = o; } };
const _grp = (n) => ({ name: n, label: n, containers: [], actions: { hi: { key: 'hi', label: 'Hi', type: 'run', script: 'echo', tab: false } }, children: [], parent: null, depth: 0, quick: false });

getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {}, groups: { g1: _grp('g1'), g2: _grp('g2') } };
cap(() => initState());
cap(() => dispatch.loadKeymap(getModel().config));   // empty keymap → defaults only

const remappable = new Set(km.DEFAULT_NORMAL.global.map(e => e.key));
const reserved   = dispatch._reservedNormalKeys();

// Sweep printable ASCII + the named keys handleNormalKey handles.
// 'q' is excluded: its case calls cleanup() + process.exit, which would tear the
// harness down mid-sweep. It is reserved + known, and the invariant only FAILS
// on a fired-but-unreserved key, so excluding a reserved key loses nothing.
const KEYS = [];
for (let c = 0x21; c <= 0x7e; c++) { const ch = String.fromCharCode(c); if (ch !== 'q') KEYS.push(ch); }
KEYS.push(' ');
KEYS.push('escape', 'return', 'up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'tab', 'backspace');

// "fired" = the keypress dispatched ≥1 Msg (the switch or the resolver acted).
function firedFor(key) {
  sessionLog.clear();
  cap(() => dispatch._handleNormalKey(key, key));
  const fired = sessionLog.snapshot().length > 0;
  sessionLog.clear();
  return fired;
}

describe('[E9] keymap reserved-set drift tripwire', () => {
  it('every key the normal-mode switch ACTS ON is remappable or reserved', () => {
    sessionLog.enable(true);
    const offenders = [];
    try {
      for (const key of KEYS) {
        if (firedFor(key) && !remappable.has(key) && !reserved.has(key)) offenders.push(key);
      }
    } finally { sessionLog.enable(false); sessionLog.clear(); }
    assert(offenders.length === 0,
      `keys handled by handleNormalKey but neither remappable nor reserved — a keymap.normal `
      + `bind would silently shadow them: ${JSON.stringify(offenders)}. Add each to `
      + `_SHADOWED_NORMAL_KEYS (or to the keymap default table).`);
  });

  // Detector sanity — guards against a broken tripwire that passes vacuously
  // (e.g. if "fired" never registered, the invariant would be trivially true).
  it('detector works: a reserved dispatcher fires; a free key does not', () => {
    sessionLog.enable(true);
    try {
      assert(firedFor(' '), 'space should fire (enter_prefix) — detector registers a dispatch');
      assert(!firedFor('Z'), "'Z' (no switch case, not a hotkey) should not fire");
    } finally { sessionLog.enable(false); sessionLog.clear(); }
  });
});

report();
