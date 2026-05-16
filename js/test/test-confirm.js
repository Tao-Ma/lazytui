/**
 * Confirm overlay smoke test — runAction gating + key handler dispatch.
 *
 * The proceed callback is dispatched via setImmediate (so the input
 * pump's trailing render() paints the overlay-gone frame before the
 * action's spawn() blocks). Tests that observe callback effects therefore
 * use section() + setImmediate, mirroring test-docker-events.js's pattern.
 *
 * Run: node js/test/test-confirm.js
 */
'use strict';

const { S } = require('../state');
const { enterConfirm, handleConfirmKey } = require('../confirm');
const { describe, it, section, eq, report } = require('./test-runner');

S.confirmMode = false;

describe('[1] enter sets mode', () => {
  it('confirmMode flips on, escape cancels without firing', () => {
    let fired = 0;
    enterConfirm('really?', () => { fired += 1; });
    eq(S.confirmMode, true, 'mode active');
    eq(fired, 0, 'callback not yet fired');
    handleConfirmKey('escape', '');
    eq(S.confirmMode, false, 'escape exits');
    eq(fired, 0, 'escape does not fire callback (still 0 — setImmediate skipped on cancel)');
  });
});

describe('[3] n cancels', () => {
  it('n exits without firing callback', () => {
    let fired = 0;
    enterConfirm('go?', () => { fired += 1; });
    handleConfirmKey('', 'n');
    eq(S.confirmMode, false, 'mode cleared');
    eq(fired, 0, 'callback not fired');
  });
});

describe('[5] stray keys swallowed', () => {
  it('non-y/n keys keep the overlay open', () => {
    let fired = 0;
    enterConfirm('go?', () => { fired += 1; });
    handleConfirmKey('', 'q');
    handleConfirmKey('up', '');
    handleConfirmKey('', 'a');
    eq(S.confirmMode, true, 'still active');
    eq(fired, 0, 'no callback');
    handleConfirmKey('', 'n');  // close cleanly without firing
  });
});

describe('[6] runAction respects confirm', () => {
  it('action with confirm: stages overlay, no execution; without runs immediately', () => {
    const { runAction } = require('../actions');
    S.lastRunAction = '';
    runAction('stop', { script: 'true', type: 'run', confirm: 'sure?' });
    eq(S.confirmMode, true, 'overlay opened');
    eq(S.lastRunAction, '', 'execution deferred');
    handleConfirmKey('escape', '');
    eq(S.lastRunAction, '', 'escape leaves lastRunAction untouched');
    // No-confirm path is fully sync (no setImmediate), so lastRunAction
    // observable on the next line.
    runAction('noop', { script: 'true', type: 'background' });
    eq(S.lastRunAction, 'noop', 'no-confirm action ran');
  });
});

// --- Async sections — observe deferred-callback effects after setImmediate fires ---

let _firedY = 0;
section('[2] y commits — callback fires after setImmediate');
enterConfirm('go?', () => { _firedY += 1; });
handleConfirmKey('', 'y');
eq(S.confirmMode, false, 'mode cleared synchronously on y');
eq(_firedY, 0, 'callback NOT yet fired (still on input frame)');
setImmediate(() => {
  eq(_firedY, 1, 'callback fired exactly once after setImmediate');
  runStep4();
});

function runStep4() {
  let firedR = 0;
  section('[4] return acts as confirm — also deferred');
  enterConfirm('go?', () => { firedR += 1; });
  handleConfirmKey('return', '');
  eq(S.confirmMode, false, 'mode cleared on Enter');
  eq(firedR, 0, 'callback not yet fired');
  setImmediate(() => {
    eq(firedR, 1, 'Enter fires callback after setImmediate');
    report();
  });
}
