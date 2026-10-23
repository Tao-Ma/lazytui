/**
 * Invoke-time prompt via fabric-field (P2 of args→ports convergence).
 *
 * When a `type:run` shell (or fabric) action with required `ports.in` is invoked
 * and the inputs aren't yet resolved (no wire, no inject, no default), the
 * fabric-field modal opens over the FIRST missing port — exactly as the pane's
 * manual-edit flow does. The modal carries a `pendingAction` context; on submit
 * it writes a ONE-SHOT inject (D2 of the plan — popup-collected values are
 * consumed by the next run, not sticky) and re-dispatches the action, which
 * naturally loops to the next missing port (or finally runs when ready).
 *
 * These tests pin the reducer layer end-to-end — the pendingAction carry, the
 * oneShot inject + consume_oneshot path, and the submit→do_run cascade — through
 * the real root runtime (`runtime.update`), mirroring test-fabric-field.js style.
 *
 * Run: node js/test/test-shell-action-prompt.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');

const ADDR = 'verify.file';

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';          // fabric injects are group-scoped (B3)
  m.register = { history: [], cap: 10 };
  return m;
}
const inj = (m) => (m.fabric.injects[m.currentGroup] || {});

const PENDING_ACTION = {
  actionKey: 'verify',
  action: {
    type: 'run',
    script: '$SUM -c "$file.sha256"',
    ports: { in: { file: { type: 'string', required: true } } },
  },
};

describe('[shell-action-prompt] fabric-field carries pendingAction + submits one-shot + re-dispatches', () => {
  it('enter with pendingAction stores it on the modal state', () => {
    const m = freshModel();
    const [next] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, addr: ADDR, text: '',
      pendingAction: PENDING_ACTION,
    });
    assert(next.modes.fabricFieldMode, 'modal opens');
    eq(next.modal.fabricField.addr, ADDR);
    assert(next.modal.fabricField.pendingAction != null, 'pendingAction stored on modal state');
    eq(next.modal.fabricField.pendingAction.actionKey, 'verify');
  });

  it('submit with pendingAction writes a ONE-SHOT inject + emits a do_run cmd', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, addr: ADDR, text: 'arc.tar.xz',
      pendingAction: PENDING_ACTION,
    });
    const [next, cmds] = runtime.update(m, { type: 'fabric_field_submit' });
    eq(inj(next)[ADDR].value, 'arc.tar.xz', 'inject written');
    assert(inj(next)[ADDR].oneShot === true, 'inject is one-shot (consumed by the next run)');
    assert(!next.modes.fabricFieldMode, 'modal closed');
    assert(cmds.some((c) => c && c.type === 'do_run' && c.actionKey === 'verify'),
      'submit re-dispatches the pending action via a do_run cmd');
  });

  it('submit WITHOUT pendingAction keeps the current STICKY behavior (no oneShot, no cmd)', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, addr: ADDR, text: 'x',
      // no pendingAction — this is the ports-pane manual-edit path
    });
    const [next, cmds] = runtime.update(m, { type: 'fabric_field_submit' });
    eq(inj(next)[ADDR].value, 'x', 'inject written');
    assert(!inj(next)[ADDR].oneShot, 'no oneShot flag — ports-pane edits stay sticky');
    eq(cmds.length, 0, 'no cmd — pane edits are atomic, no re-dispatch');
  });

  it('cancel with pendingAction closes cleanly + drops the pendingAction + does NOT run', () => {
    let m = freshModel();
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, addr: ADDR, text: 'x',
      pendingAction: PENDING_ACTION,
    });
    const [next, cmds] = runtime.update(m, { type: 'fabric_field_cancel' });
    assert(!next.modes.fabricFieldMode, 'modal closed');
    assert(next.modal.fabricField.pendingAction == null, 'pendingAction dropped');
    assert(!cmds.some((c) => c && c.type === 'do_run'), 'cancel does NOT re-dispatch');
    assert(!inj(next)[ADDR], 'no inject written on cancel');
  });
});

describe('[shell-action-prompt] port_consume_oneshot clears only one-shot injects', () => {
  it('removes a oneShot inject', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'port_inject', port: ADDR, value: 'x', oneShot: true });
    assert(inj(m)[ADDR].oneShot === true, 'oneShot flag set via port_inject');
    const [next] = runtime.update(m, { type: 'port_consume_oneshot', ports: [ADDR] });
    assert(!inj(next)[ADDR], 'oneShot inject cleared');
  });

  it('leaves a STICKY inject (no oneShot flag) untouched', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'port_inject', port: ADDR, value: 'y' });   // sticky
    const [next] = runtime.update(m, { type: 'port_consume_oneshot', ports: [ADDR] });
    eq(inj(next)[ADDR].value, 'y', 'sticky inject survives consume_oneshot');
  });

  it('clearing a non-existent port is a no-op (identity-preserving)', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'port_inject', port: ADDR, value: 'y' });
    const [next] = runtime.update(m, { type: 'port_consume_oneshot', ports: ['other.port'] });
    assert(next === m || inj(next)[ADDR].value === 'y', 'no-op');
  });

  it('port_inject with oneShot flag stamps the record', () => {
    let m = freshModel();
    m.now = 1234;
    [m] = runtime.update(m, { type: 'port_inject', port: ADDR, value: 'z', oneShot: true });
    eq(inj(m)[ADDR].value, 'z');
    eq(inj(m)[ADDR].at, 1234, 'at-stamped from model.now');
    assert(inj(m)[ADDR].oneShot === true, 'oneShot carried through');
  });
});

report();
