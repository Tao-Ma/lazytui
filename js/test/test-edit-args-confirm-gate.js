/**
 * Confirm-gate regression for `[a]` edit-args (v0.6.45 fix).
 *
 * Pre-fix (v0.6.41–v0.6.44), the fabric-form submit arm UNCONDITIONALLY
 * emitted `do_run` — the POST-confirm-gate Cmd. The missing-required flow
 * reaches the form via `runAction → doRun → _promptMissing`, so an
 * `action.confirm:` has already been accepted and the gate must NOT re-fire
 * (double confirm). But Brief 1 (v0.6.41) added a SECOND way into the form:
 * `[a]` → `_editArgsForAction → openPortsForm` directly — no gate ever
 * staged. Submit re-emitted `do_run`, so a confirm-gated action spawned
 * UN-confirmed on two keystrokes (`[a]` Enter).
 *
 * Fix: `openPortsForm({confirmed})` records the origin on pendingAction.
 *   - `_promptMissing`      → confirmed:true  → submit emits do_run    (unchanged)
 *   - `_editArgsForAction`  → confirmed:false → submit emits run_action (GATED)
 *
 * This file pins ALL FOUR corner cases of the lane split:
 *   (A) [a] + confirm-gated action        → run_action (gate fires on submit)
 *   (B) [a] + no-confirm action           → run_action (equivalent to do_run; gate is a no-op)
 *   (C) _promptMissing + confirm-gated    → do_run (ALREADY past gate; no double-confirm)
 *   (D) _promptMissing + no-confirm       → do_run (unchanged — baseline)
 *
 * The ask: a user-habit two-keystroke `[a]` Enter must never spawn a
 * confirm-gated destructive action. ReportFindings call-site: the probe
 * script's internal --force gate was the only thing that saved the live
 * cert from being reverted when this fired on the consumer's secret
 * rotate-ca action.
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const runtime = require('../app/runtime');
const runner = require('../dispatch/runtime/action-runner');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { applyMsg } = require('../dispatch/control/dispatch');

wireFabricHost();

const CONFIRM_ACTION = {
  type: 'run', script: 'echo would-have-run',
  confirm: 'Really revoke the CA?',
  ports: { in: {
    force:      { type: 'string', required: true },
    passphrase: { type: 'string', required: true, sensitive: true },
    server_cn:  { type: 'string', required: false },
  } },
};

const PLAIN_ACTION = {
  type: 'run', script: 'echo ok',
  ports: { in: {
    name: { type: 'string', required: false, default: 'alice' },
  } },
};

describe('[edit-args/confirm-gate] (A) `[a]` on confirm-gated action: submit must GATE, not bypass', () => {
  it('_editArgsForAction opens with confirmed:false and submit emits run_action (NOT do_run)', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('rotate-ca', CONFIRM_ACTION, getModel());
    runner.openPortsForm('rotate-ca', CONFIRM_ACTION, resolved, { confirmed: false });
    // Pin the pendingAction stamp — the submit arm reads this field.
    const f = getModel().modal.fabricForm;
    eq(f.pendingAction.confirmed, false,
      `pendingAction.confirmed must be false when opened from [a], got: ${JSON.stringify(f.pendingAction.confirmed)}`);
    // Fill required fields so submit doesn't degenerate.
    applyMsg({ type: 'fabric_form_key', key: 'y', seq: 'y' });   // force → "y"
    applyMsg({ type: 'fabric_form_focus_next' });
    applyMsg({ type: 'fabric_form_key', key: 'p', seq: 'p' });   // passphrase → "p"
    // Drive submit via the pure reducer (so we can inspect emitted cmds —
    // applyMsg's dispatcher consumes them before we can look).
    const [, cmds] = runtime.update(getModel(), { type: 'fabric_form_submit' });
    // The ONLY run-shaped Cmd must be run_action (gates), not do_run (bypass).
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds.length, 1, `exactly one run-shaped cmd, got: ${JSON.stringify(cmds)}`);
    eq(runCmds[0].type, 'run_action',
      `BUG regression — [a] submit on confirm-gated action must emit run_action (which gates), ` +
      `not do_run (which bypasses). Got: ${runCmds[0].type}. ` +
      `Pre-fix, this emitted do_run and spawned the action with NO confirm overlay.`);
    eq(runCmds[0].actionKey, 'rotate-ca');
    // The gate target survives on the Cmd — runAction will see action.confirm.
    assert(runCmds[0].action && runCmds[0].action.confirm === 'Really revoke the CA?',
      `action.confirm must be carried through verbatim so runAction's gate reads it`);
  });
});

describe('[edit-args/confirm-gate] (B) `[a]` on no-confirm action: submit still routes via run_action', () => {
  it('run_action with no action.confirm is a no-op gate — behavior is equivalent to do_run', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('ok', PLAIN_ACTION, getModel());
    runner.openPortsForm('ok', PLAIN_ACTION, resolved, { confirmed: false });
    // Mark name as modified so the field injects (any non-default edit).
    applyMsg({ type: 'fabric_form_key', key: 'b', seq: 'b' });   // name → "aliceb"
    const [, cmds] = runtime.update(getModel(), { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds.length, 1);
    eq(runCmds[0].type, 'run_action',
      `[a] on a no-confirm action must still route via run_action — the opt-in to the gate ` +
      `is pending.confirmed, not the presence of action.confirm. runAction skips the gate ` +
      `when action.confirm is absent, so behavior is unchanged.`);
    eq(runCmds[0].actionKey, 'ok');
  });
});

describe('[edit-args/confirm-gate] (C) _promptMissing on confirm-gated: submit must NOT re-confirm', () => {
  it('_promptMissing opens with confirmed:true and submit emits do_run (post-gate; no double confirm)', () => {
    sm.bootFresh();
    const resolved = {
      ready: false,
      values: {},
      sources: {},
      missing: [{ port: 'force', reason: 'empty' }],
    };
    runner._promptMissing('rotate-ca', CONFIRM_ACTION, resolved);
    const f = getModel().modal.fabricForm;
    assert(getModel().modes.fabricFormMode, 'form opened (3 ports → form lane)');
    eq(f.pendingAction.confirmed, true,
      `pendingAction.confirmed must be true when opened from _promptMissing (post-gate); ` +
      `got: ${JSON.stringify(f.pendingAction.confirmed)}. Pre-fix, this field didn't exist.`);
    // Fill required fields.
    applyMsg({ type: 'fabric_form_key', key: 'y', seq: 'y' });
    applyMsg({ type: 'fabric_form_focus_next' });
    applyMsg({ type: 'fabric_form_key', key: 'p', seq: 'p' });
    const [, cmds] = runtime.update(getModel(), { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds.length, 1);
    eq(runCmds[0].type, 'do_run',
      `_promptMissing's post-gate submit must emit do_run to AVOID double-confirming the user. ` +
      `Pre-fix this already worked; new regression ensures the fix didn't break it.`);
  });
});

describe('[edit-args/confirm-gate] (D) _promptMissing on no-confirm action: do_run (baseline unchanged)', () => {
  it('baseline — form opens post-gate for a 2-port no-confirm action; submit emits do_run', () => {
    sm.bootFresh();
    const twoPort = {
      type: 'run', script: 'echo x',
      ports: { in: {
        host: { type: 'string', required: true },
        port: { type: 'string', required: false, default: '22' },
      } },
    };
    const resolved = {
      ready: false,
      values: { port: '22' },
      sources: { port: 'default' },
      missing: [{ port: 'host', reason: 'empty' }],
    };
    runner._promptMissing('ssh', twoPort, resolved);
    const f = getModel().modal.fabricForm;
    eq(f.pendingAction.confirmed, true,
      `_promptMissing always stamps confirmed:true, regardless of whether action.confirm is set`);
    // Fill host.
    applyMsg({ type: 'fabric_form_key', key: 'x', seq: 'x' });
    const [, cmds] = runtime.update(getModel(), { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds.length, 1);
    eq(runCmds[0].type, 'do_run', `baseline: _promptMissing → do_run (unchanged)`);
  });
});

describe('[edit-args/confirm-gate] stamp SOURCE invariant — opts.confirmed is strict-boolean coerced', () => {
  it('openPortsForm({confirmed: "yes"}) does NOT truthy-coerce to confirmed:true', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('ok', PLAIN_ACTION, getModel());
    // String "yes" / 1 / etc. must not accidentally flip the gate-bypass flag.
    runner.openPortsForm('ok', PLAIN_ACTION, resolved, { confirmed: 'yes' });
    const f = getModel().modal.fabricForm;
    eq(f.pendingAction.confirmed, false,
      `defense-in-depth — only strict \`true\` opts into the do_run bypass; any other value ` +
      `(string "true", 1, {}, etc.) falls back to the gated path`);
  });

  it('openPortsForm with no opts arg at all defaults to confirmed:false (gated)', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('ok', PLAIN_ACTION, getModel());
    runner.openPortsForm('ok', PLAIN_ACTION, resolved);     // no 4th arg
    const f = getModel().modal.fabricForm;
    eq(f.pendingAction.confirmed, false,
      `missing opts param defaults to safe side (confirmed:false → run_action). ` +
      `A future caller that forgets to pass opts gets GATED, not BYPASSED.`);
  });
});

describe('[edit-args/confirm-gate] pending.confirmed hostile-input defense in the reducer', () => {
  it('pending.confirmed === true explicitly emits do_run (strict compare)', () => {
    sm.bootFresh();
    let m = getModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [{ port: 'host', text: 'x', required: true, default: null, desc: '' }],
      pendingAction: { actionKey: 'k', action: PLAIN_ACTION, confirmed: true } });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds[0].type, 'do_run');
  });

  it('pending.confirmed === "truthy string" is NOT accepted by the reducer — emits run_action', () => {
    sm.bootFresh();
    let m = getModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [{ port: 'host', text: 'x', required: true, default: null, desc: '' }],
      pendingAction: { actionKey: 'k', action: PLAIN_ACTION, confirmed: 'yes' } });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds[0].type, 'run_action',
      `defense-in-depth at the reducer boundary — a hand-built Msg with confirmed:"yes" ` +
      `(coerced from WAL / someone's test / future caller) must NOT bypass the gate. ` +
      `The strict \`=== true\` compare in the submit arm catches it.`);
  });

  it('pending.confirmed absent (undefined) emits run_action — the pre-fix default was unsafe', () => {
    sm.bootFresh();
    let m = getModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter',
      fields: [{ port: 'host', text: 'x', required: true, default: null, desc: '' }],
      pendingAction: { actionKey: 'k', action: PLAIN_ACTION } });   // no confirmed field
    const [, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const runCmds = cmds.filter((c) => c && (c.type === 'run_action' || c.type === 'do_run'));
    eq(runCmds[0].type, 'run_action',
      `A pre-fix WAL replay (no confirmed field on pendingAction) now routes through ` +
      `run_action, not do_run. runAction without action.confirm is a no-op gate, so ` +
      `benign actions behave identically; confirm-gated actions get their gate back.`);
  });
});

// -------------------------------------------------------------------------
// Round-2 adversarial: declined `[a]` → confirm → `n` must NOT leave one-
// shot injects orphaned. Pre-fix of this fix (v0.6.45 round-1), the submit
// arm wrote `applyInject({oneShot:true})` for every modified field BEFORE
// the confirm fired. On decline the one-shots stayed, and the next invoke
// Enter → confirm `y` → spawn used the previously-DECLINED values. Fix:
// stamp modal.onReject with a port_consume_oneshot Cmd on the unconfirmed
// confirm-gated lane; confirm.js's confirm_reject arm fires it.
// -------------------------------------------------------------------------

describe('[edit-args/confirm-gate] round-2 — decline rollback', () => {
  it('`[a]` → fill → submit → decline must consume the one-shot injects', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('rotate-ca', CONFIRM_ACTION, getModel());
    runner.openPortsForm('rotate-ca', CONFIRM_ACTION, resolved, { confirmed: false });
    applyMsg({ type: 'fabric_form_key', key: 'y', seq: 'y' });   // force → "y"
    applyMsg({ type: 'fabric_form_focus_next' });
    applyMsg({ type: 'fabric_form_key', key: 'p', seq: 'p' });   // passphrase → "p"
    // Submit — writes one-shot injects + stamps modal.onReject + emits run_action.
    applyMsg({ type: 'fabric_form_submit' });
    // Verify the stamp landed before confirm fires.
    const stamped = getModel().modal.onReject;
    assert(stamped && stamped.type === 'msg' && stamped.msg
           && stamped.msg.type === 'port_consume_oneshot',
      `modal.onReject must be a port_consume_oneshot Cmd on the confirmed:false ` +
      `confirm-gated lane; got: ${JSON.stringify(stamped)}`);
    eq(stamped.msg.ports.sort(), ['rotate-ca.force', 'rotate-ca.passphrase'].sort(),
      `onReject must carry the exact addrs the submit arm wrote`);
    // Verify the injects were actually written to the model (precondition for
    // the rollback-matters claim).
    const group = getModel().currentGroup;
    const beforeInjects = (getModel().fabric && getModel().fabric.injects
                           && getModel().fabric.injects[group]) || {};
    assert(beforeInjects['rotate-ca.force'] && beforeInjects['rotate-ca.force'].oneShot,
      `inject written as one-shot (precondition)`);
    assert(beforeInjects['rotate-ca.passphrase'] && beforeInjects['rotate-ca.passphrase'].oneShot,
      `inject written as one-shot (precondition)`);
    // Simulate the confirm_enter that runAction would stage, then the decline.
    applyMsg({ type: 'confirm_enter', message: 'Really revoke the CA?',
      cmd: { type: 'do_run', actionKey: 'rotate-ca', action: CONFIRM_ACTION } });
    // confirm_enter must PRESERVE onReject (not clear it) — our stamp survives.
    const stillStamped = getModel().modal.onReject;
    assert(stillStamped && stillStamped.msg
           && stillStamped.msg.type === 'port_consume_oneshot',
      `confirm_enter must preserve modal.onReject; got: ${JSON.stringify(stillStamped)}`);
    applyMsg({ type: 'confirm_reject' });
    // After decline: one-shot injects consumed, modal.onReject cleared.
    const afterInjects = (getModel().fabric && getModel().fabric.injects
                          && getModel().fabric.injects[group]) || {};
    assert(!afterInjects['rotate-ca.force'],
      `declined one-shot rotate-ca.force must be CONSUMED; still present: ${JSON.stringify(afterInjects['rotate-ca.force'])}`);
    assert(!afterInjects['rotate-ca.passphrase'],
      `declined one-shot rotate-ca.passphrase must be CONSUMED; still present: ${JSON.stringify(afterInjects['rotate-ca.passphrase'])}`);
    eq(getModel().modal.onReject, null, `modal.onReject cleared after reject fires it`);
  });

  it('`[a]` → fill → submit → ACCEPT must NOT fire onReject (do_run consumes via spawn)', () => {
    sm.bootFresh();
    const resolved = runner._resolvePortsForAction('rotate-ca', CONFIRM_ACTION, getModel());
    runner.openPortsForm('rotate-ca', CONFIRM_ACTION, resolved, { confirmed: false });
    applyMsg({ type: 'fabric_form_key', key: 'y', seq: 'y' });
    applyMsg({ type: 'fabric_form_focus_next' });
    applyMsg({ type: 'fabric_form_key', key: 'p', seq: 'p' });
    applyMsg({ type: 'fabric_form_submit' });
    applyMsg({ type: 'confirm_enter', message: 'Really revoke the CA?',
      cmd: { type: 'do_run', actionKey: 'rotate-ca', action: CONFIRM_ACTION } });
    // Verify precondition: onReject is set + injects written.
    const group = getModel().currentGroup;
    const beforeInjects = (getModel().fabric && getModel().fabric.injects
                           && getModel().fabric.injects[group]) || {};
    assert(beforeInjects['rotate-ca.force'], `precondition: inject exists`);
    // Accept — must clear onReject WITHOUT firing it (so injects stay for the
    // forward do_run / doRun / _consumeOneShotInjects path to sweep after spawn).
    const [after, cmds] = runtime.update(getModel(), { type: 'confirm_accept' });
    eq(after.modal.onReject, null, `confirm_accept clears onReject`);
    // The forward do_run must fire — the ONLY Cmd on confirm_accept.
    const runCmds = cmds.filter((c) => c && (c.type === 'do_run' || c.type === 'run_action'));
    eq(runCmds.length, 1, `exactly one run-cmd on accept`);
    eq(runCmds[0].type, 'do_run');
    // One-shot addrs must STILL be in the model (do_run → doRun will consume
    // them after the spawn starts). Pre-rollback-stamp fix: this was already
    // the behavior; the regression here is that onReject isn't fired on accept.
    assert(after.fabric.injects[group]['rotate-ca.force'],
      `one-shot inject must survive accept — doRun consumes after spawn, not here`);
  });

  it('`[a]` + no-confirm action does NOT stamp onReject (nothing to roll back)', () => {
    sm.bootFresh();
    // bootFresh doesn't reset model.modal.onReject (helper is scoped to flags
    // + per-pane state, not modal buffers). Clear explicitly so we assert on
    // THIS test's net effect, not a leak from a prior scenario.
    const m0 = getModel();
    if (m0.modal.onReject) m0.modal.onReject = null;
    const resolved = runner._resolvePortsForAction('ok', PLAIN_ACTION, getModel());
    runner.openPortsForm('ok', PLAIN_ACTION, resolved, { confirmed: false });
    applyMsg({ type: 'fabric_form_key', key: 'b', seq: 'b' });
    applyMsg({ type: 'fabric_form_submit' });
    eq(getModel().modal.onReject, null,
      `no action.confirm → no gate will fire → no stamp needed. Stamp here would ` +
      `taint a later unrelated confirm overlay's reject.`);
  });

  it('_promptMissing lane (confirmed:true) does NOT stamp onReject either', () => {
    sm.bootFresh();
    const m0 = getModel();
    if (m0.modal.onReject) m0.modal.onReject = null;
    const resolved = {
      ready: false,
      values: {},
      sources: {},
      missing: [{ port: 'force', reason: 'empty' }],
    };
    runner._promptMissing('rotate-ca', CONFIRM_ACTION, resolved);
    applyMsg({ type: 'fabric_form_key', key: 'y', seq: 'y' });
    applyMsg({ type: 'fabric_form_focus_next' });
    applyMsg({ type: 'fabric_form_key', key: 'p', seq: 'p' });
    applyMsg({ type: 'fabric_form_submit' });
    eq(getModel().modal.onReject, null,
      `_promptMissing lane is post-gate; the forward Cmd is do_run (no confirm_enter), ` +
      `so there's no reject surface and no stamp is needed`);
  });

  it('confirm_enter PRESERVES modal.onReject across the setImmediate boundary', () => {
    // Simulate the race: fabric_form_submit stamps onReject (sync in reducer),
    // then run_action Cmd fires setImmediate'd runAction → applyMsg confirm_enter.
    // Pre-round-2 behavior had confirm_enter nullify modal.onReject implicitly
    // via its _withModalMode patch spread; verify it is explicitly preserved.
    sm.bootFresh();
    let m = getModel();
    // Hand-stamp onReject (bypass the submit arm — we're testing the preserve
    // invariant on confirm_enter, not the stamp itself).
    m = { ...m, modal: { ...m.modal, onReject: {
      type: 'msg', msg: { type: 'port_consume_oneshot', ports: ['x.y'] },
    } } };
    const [after] = runtime.update(m, { type: 'confirm_enter', message: 'ok',
      cmd: { type: 'do_run', actionKey: 'x', action: PLAIN_ACTION } });
    assert(after.modal.onReject && after.modal.onReject.msg
           && after.modal.onReject.msg.type === 'port_consume_oneshot',
      `confirm_enter must preserve onReject; got: ${JSON.stringify(after.modal.onReject)}`);
  });

  it('a stale onReject (unrelated session) does NOT fire if there is no active confirm', () => {
    // Guard on the confirm_reject arm: `!model.modes.confirmMode` early-returns.
    // A stale onReject from a dropped flow should not blast one-shots on an
    // unrelated keystroke.
    sm.bootFresh();
    let m = getModel();
    m = { ...m, modal: { ...m.modal, onReject: {
      type: 'msg', msg: { type: 'port_consume_oneshot', ports: ['x.y'] },
    } } };
    // confirmMode is false — reject must no-op (guard).
    const [after, cmds] = runtime.update(m, { type: 'confirm_reject' });
    eq(cmds.length, 0, `confirm_reject outside confirmMode is a no-op (guard holds)`);
    assert(after.modal.onReject !== null,
      `the stale onReject stays because the guard early-returned; a future legit ` +
      `confirm overlay can still carry its own stamp — but the stale leak is a ` +
      `small cost vs. firing arbitrary rollbacks on stray key events`);
  });
});

report();
