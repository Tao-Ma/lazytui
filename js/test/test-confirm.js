/**
 * Confirm overlay smoke test — runAction gating + reducer-driven accept/reject.
 *
 * Confirm now flows through update: runAction stages a confirm_enter Msg with
 * a do_run Cmd DESCRIPTOR (data, not a closure); the modeChain handler turns
 * y/Enter → confirm_accept (re-emits do_run) and n/Esc → confirm_reject. The
 * do_run Cmd is deferred via setImmediate (so the overlay-gone frame paints
 * before spawn), so accept tests observe the effect after setImmediate.
 *
 * Run: node js/test/test-confirm.js
 */
'use strict';

const { getModel } = require('../app/runtime');
const dispatch = require('../dispatch/dispatch');
const { runAction } = require('../dispatch/action-runner');
const { describe, it, section, eq, report } = require('./test-runner');

function reset() {
  getModel().modes.confirmMode = false;
  getModel().lastRunAction = '';
  getModel().modal.confirm = { message: '', cmd: null };
}
// Drive a key through the active mode handler (the confirm modeChain entry).
function press(key, seq) { dispatch._dispatchActiveMode(getModel(), key, seq); }

const CONFIRM_ACTION = { script: 'true', type: 'background', confirm: 'sure?' };

describe('[1] runAction with confirm: stages the overlay, defers the action', () => {
  it('confirmMode on, do_run Cmd staged as data, action not yet run', () => {
    reset();
    runAction(getModel(), 'stop', CONFIRM_ACTION);
    eq(getModel().modes.confirmMode, true, 'overlay opened');
    eq(getModel().modal.confirm.cmd.type, 'do_run', 'pending do_run Cmd staged (data, not a closure)');
    eq(getModel().lastRunAction, '', 'execution deferred');
  });
});

describe('[3] n / escape reject without running', () => {
  it('n clears mode, no run', () => {
    reset();
    runAction(getModel(), 'stop', CONFIRM_ACTION);
    press('', 'n');
    eq(getModel().modes.confirmMode, false, 'mode cleared');
    eq(getModel().lastRunAction, '', 'not run');
  });
  it('escape clears mode, no run', () => {
    reset();
    runAction(getModel(), 'stop', CONFIRM_ACTION);
    press('escape', '');
    eq(getModel().modes.confirmMode, false, 'mode cleared');
    eq(getModel().lastRunAction, '', 'not run');
  });
});

describe('[5] stray keys swallowed', () => {
  it('non-y/n keys keep the overlay open', () => {
    reset();
    runAction(getModel(), 'stop', CONFIRM_ACTION);
    press('', 'q'); press('up', ''); press('', 'a');
    eq(getModel().modes.confirmMode, true, 'still active');
    eq(getModel().lastRunAction, '', 'no run');
  });
});

describe('[6] no-confirm action runs immediately (sync)', () => {
  it('runs without staging an overlay', () => {
    reset();
    runAction(getModel(), 'noop', { script: 'true', type: 'background' });
    eq(getModel().modes.confirmMode, false, 'no overlay');
    eq(getModel().lastRunAction, 'noop', 'ran immediately');
  });
});

// --- Async: y / Enter accept → do_run Cmd deferred via setImmediate ---

section('[2] y commits — action runs after setImmediate');
reset();
runAction(getModel(), 'yes-run', CONFIRM_ACTION);
press('', 'y');
eq(getModel().modes.confirmMode, false, 'mode cleared synchronously on y');
eq(getModel().lastRunAction, '', 'action NOT yet run (do_run deferred to next tick)');
setImmediate(() => {
  eq(getModel().lastRunAction, 'yes-run', 'action ran after setImmediate');
  runStep4();
});

function runStep4() {
  section('[4] Enter also accepts — also deferred');
  reset();
  runAction(getModel(), 'ent-run', CONFIRM_ACTION);
  press('return', '');
  eq(getModel().modes.confirmMode, false, 'mode cleared on Enter');
  eq(getModel().lastRunAction, '', 'deferred');
  setImmediate(() => {
    eq(getModel().lastRunAction, 'ent-run', 'Enter ran the action after setImmediate');
    report();
  });
}
