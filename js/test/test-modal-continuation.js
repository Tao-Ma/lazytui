/**
 * E14 — uniform modal continuation.
 *
 * Every modal stages a serializable Cmd DESCRIPTOR on `model.modal.continuation`
 * and emits it (patched with the user's result) on a successful dismissal:
 *   - confirm / prompt — the OPENER stages the Cmd (do_run / run_action); submit
 *     patches the parsed args in.
 *   - copy / cmdline / menu — a FIXED base ({copy_commit}/{cmdline_run}/
 *     {menu_action}) is staged at enter and patched with the chosen
 *     idx / sel+args+display / verb at the terminal arm.
 * Every enter sets `continuation`; every exit (success OR cancel) clears it.
 *
 * The contract this pins: the continuation is DATA, never a closure — so it
 * round-trips a checkpoint's JSON and a fold reproduces the same Cmd
 * (replay-safe). `findModalClosure(model.modal)` is asserted null after every
 * transition, and a deliberate function injection is asserted to be caught.
 *
 * Run: node js/test/test-modal-continuation.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const { findModalClosure } = require('../dispatch/update/model-ops');

const fresh = () => runtime.init();
// Apply a Msg to a model, return [next, cmds]. Also assert the post-state has
// no closure anywhere under model.modal (the E14 contract) and that
// model.modal round-trips JSON unchanged (serializable / replay-safe).
function step(model, msg) {
  const [next, cmds] = runtime.update(model, msg);
  const leak = findModalClosure(next.modal);
  assert(leak === null, `no closure under model.modal after ${msg.type}` + (leak ? ` (found at ${leak})` : ''));
  eq(JSON.parse(JSON.stringify(next.modal)).continuation, next.modal.continuation,
    `${msg.type}: continuation survives a JSON round-trip`);
  return [next, cmds];
}

describe('[E14] confirm — opener-staged continuation', () => {
  it('enter stages the Cmd on continuation; accept re-emits it; clears', () => {
    const staged = { type: 'do_run', actionKey: 'deploy', action: {} };
    const [m1] = step(fresh(), { type: 'confirm_enter', message: 'Sure?', cmd: staged });
    eq(m1.modes.confirmMode, true, 'mode on');
    eq(m1.modal.continuation, staged, 'continuation = staged Cmd');
    eq(m1.modal.confirm.message, 'Sure?', 'display message kept on confirm');
    const [m2, cmds] = step(m1, { type: 'confirm_accept' });
    eq(m2.modes.confirmMode, false, 'mode cleared');
    eq(m2.modal.continuation, null, 'continuation cleared');
    eq(cmds, [staged], 'accept re-emits the staged Cmd');
  });
  it('reject emits nothing and clears the continuation', () => {
    const [m1] = step(fresh(), { type: 'confirm_enter', message: 'x', cmd: { type: 'do_run' } });
    const [m2, cmds] = step(m1, { type: 'confirm_reject' });
    eq(cmds, [], 'reject emits no Cmd');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
});

describe('[E14] prompt — opener-staged continuation + arg injection', () => {
  it('submit emits the staged Cmd with parsed args patched in', () => {
    const base = { type: 'run_action', actionKey: 'a', action: {} };
    const [m1] = step(fresh(), { type: 'prompt_enter', label: 'Args', text: 'foo bar', cmd: base });
    eq(m1.modal.continuation, base, 'continuation = base Cmd');
    const [m2, cmds] = step(m1, { type: 'prompt_submit' });
    eq(m2.modes.promptMode, false, 'mode cleared');
    eq(m2.modal.continuation, null, 'continuation cleared');
    eq(cmds, [{ ...base, args: ['foo', 'bar'] }], 'emits base Cmd + parsed args');
  });
  it('cancel emits nothing and clears the continuation', () => {
    const [m1] = step(fresh(), { type: 'prompt_enter', label: 'X', cmd: { type: 'run_action' } });
    const [m2, cmds] = step(m1, { type: 'prompt_cancel' });
    eq(cmds, [], 'cancel emits no Cmd');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
});

describe('[E14] copy — fixed base, patched with the chosen idx/label', () => {
  it('enter stages {copy_commit}; select patches idx+label; clears', () => {
    const [m1] = step(fresh(), { type: 'copy_enter', options: [{ label: 'sha' }, { label: 'msg' }] });
    eq(m1.modal.continuation, { type: 'copy_commit' }, 'base staged');
    const [m1b] = step(m1, { type: 'copy_nav', dir: 1 });   // idx → 1
    const [m2, cmds] = step(m1b, { type: 'copy_select' });
    eq(cmds, [{ type: 'copy_commit', idx: 1, label: 'msg' }], 'select patches idx + chosen label');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
  it('cancel emits copy_commit{-1} and clears the continuation', () => {
    const [m1] = step(fresh(), { type: 'copy_enter', options: [{ label: 'a' }] });
    const [m2, cmds] = step(m1, { type: 'copy_cancel' });
    eq(cmds, [{ type: 'copy_commit', idx: -1 }], 'cancel clears clipboard');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
});

describe('[E14] cmdline — fixed base, patched with sel/args/display', () => {
  it('submit on a runnable match patches sel+args+display; clears', () => {
    const [m1] = step(fresh(), { type: 'cmdline_enter' });
    eq(m1.modal.continuation, { type: 'cmdline_run' }, 'base staged at enter');
    const [m2] = step(m1, { type: 'cmdline_set_matches', matches: [{ display: 'open', kind: 'cmd' }] });
    const [m3, cmds] = step(m2, { type: 'cmdline_submit' });
    eq(m3.modes.cmdMode, false, 'mode cleared');
    eq(m3.modal.continuation, null, 'continuation cleared');
    eq(cmds[0], { type: 'cmdline_run', sel: 0, args: [], display: 'open' }, 'run Cmd patched');
    eq(cmds[1], { type: 'cmdline_clear' }, 'clear Cmd follows');
  });
  it('cancel clears continuation (and emits revert + clear)', () => {
    const [m1] = step(fresh(), { type: 'cmdline_enter' });
    const [m2, cmds] = step(m1, { type: 'cmdline_cancel' });
    eq(m2.modal.continuation, null, 'continuation cleared');
    eq(cmds.map(c => c.type), ['cmdline_revert_preview', 'cmdline_clear'], 'revert then clear');
  });
});

describe('[E14] menu — fixed base, patched with the chosen verb/arg', () => {
  it('activate patches action+arg from the selected item; clears', () => {
    const [m1] = step(fresh(), { type: 'menu_open', items: [['Copy', 'copy_text', 'val'], ['Run', 'do_run']] });
    eq(m1.modal.continuation, { type: 'menu_action' }, 'base staged at open');
    const [m2, cmds] = step(m1, { type: 'menu_activate', idx: 0 });
    eq(cmds, [{ type: 'menu_action', action: 'copy_text', arg: 'val' }], 'activate patches verb + arg');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
  it('close emits nothing and clears the continuation', () => {
    const [m1] = step(fresh(), { type: 'menu_open', items: [['A', 'do_run']] });
    const [m2, cmds] = step(m1, { type: 'menu_close' });
    eq(cmds, [], 'close emits no Cmd');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
});

describe('[E14] findModalClosure guard', () => {
  it('returns null for a clean modal and the dotted path for a leaked fn', () => {
    eq(findModalClosure(fresh().modal), null, 'fresh modal is clean');
    const leaked = { ...fresh().modal, continuation: { type: 'do_run', after: () => {} } };
    eq(findModalClosure(leaked), 'modal.continuation.after', 'finds a leaked closure by path');
  });
});

report();
