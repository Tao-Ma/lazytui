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

// P3 — the legacy args-prompt modal (`prompt_enter`/`prompt_submit`) was retired
// along with its continuation path; invoke-time args collection now rides the
// fabric-field modal with a `pendingAction` (see test-shell-action-prompt.js).

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
  it('an anchored menu rides a `from` snapshot so a submenu reopens at the cursor + can go back', () => {
    // A right-click menu carries a cursor anchor; activating an item that opens a
    // SECOND menu (send_to_port's port picker) threads a `from` snapshot through so
    // the picker replaces the first menu in place (not centered) and can offer
    // "← Back" to it. An unanchored (keyboard) menu omits `from` (see above).
    const items = [['Send…', 'send_to_port', 'sel']];
    const [m1] = step(fresh(), { type: 'menu_open', items, anchor: { x: 12, y: 5 } });
    const [, cmds] = step(m1, { type: 'menu_activate', idx: 0 });
    eq(cmds, [{ type: 'menu_action', action: 'send_to_port', arg: 'sel',
      from: { items, anchor: { x: 12, y: 5 }, title: null, back: null } }], 'from snapshot rides the Cmd');
  });
  it('close emits nothing and clears the continuation', () => {
    const [m1] = step(fresh(), { type: 'menu_open', items: [['A', 'do_run']] });
    const [m2, cmds] = step(m1, { type: 'menu_close' });
    eq(cmds, [], 'close emits no Cmd');
    eq(m2.modal.continuation, null, 'continuation cleared');
  });
});

describe('[menu-back] restore the previous menu (Backspace / "← Back" row)', () => {
  const CTX = { items: [['Send…', 'send_to_port', 'sel']], anchor: { x: 12, y: 5 }, title: 'Actions', back: null };
  // A submenu (the port picker) opened with `back` = the context-menu snapshot.
  const openPicker = () => step(fresh(), {
    type: 'menu_open',
    items: [['a.in (t)', 'port_inject', {}], null, ['← Back', 'menu_back', null]],
    title: 'Send selection to port', anchor: { x: 12, y: 5 }, back: CTX,
  });

  it('menu_back restores the previous menu (items/anchor/title) and stays open', () => {
    const [m1] = openPicker();
    const [m2, cmds] = step(m1, { type: 'menu_back' });
    eq(cmds, [], 'menu_back emits no Cmd');
    eq(m2.modes.menuOpen, true, 'menu still open');
    eq(m2.modal.menu.items, CTX.items, 'the context menu items are back');
    eq(m2.modal.menu.anchor, CTX.anchor, 'restored at the original cursor anchor');
    eq(m2.modal.menu.title, 'Actions', 'restored title');
    eq(m2.modal.menu.back, null, 'the restored menu has no further back');
  });

  it('activating the "← Back" row restores in place (inline, mm.back not yet cleared)', () => {
    const [m1] = openPicker();
    const [m2, cmds] = step(m1, { type: 'menu_activate', idx: 2 });   // the "← Back" row
    eq(cmds, [], 'no menu_action Cmd — handled inline');
    eq(m2.modes.menuOpen, true, 'menu still open');
    eq(m2.modal.menu.items, CTX.items, 'restored to the context menu');
  });

  it('menu_back on a top-level menu (no back) closes it', () => {
    const [m1] = step(fresh(), { type: 'menu_open', items: [['A', 'do_run']] });
    const [m2] = step(m1, { type: 'menu_back' });
    eq(m2.modes.menuOpen, false, 'closed — nothing to go back to');
  });
});

describe('[E14] flat-modal guard — async *_enter must not stomp an open modal', () => {
  it('copy_enter over a live confirm is dropped; the confirm continuation survives', () => {
    // Open a confirm with a staged continuation, then try to open copy over it —
    // a no-op that leaves the confirm + its continuation intact. (The guard is
    // generic; the retired prompt arm used to assert this too, retired in P3.)
    const cc = { type: 'do_run', actionKey: 'deploy' };
    const [c1] = step(fresh(), { type: 'confirm_enter', message: 'Sure?', cmd: cc });
    const [c2] = step(c1, { type: 'copy_enter', options: [{ label: 'sha' }] });
    eq(c2.modes.copyMode, false, 'copy did NOT open over the confirm');
    eq(c2.modal.continuation, cc, 'confirm continuation intact after the dropped copy');
  });
});

describe('[E14] findModalClosure guard', () => {
  it('returns null for a clean modal and the dotted path for a leaked fn', () => {
    eq(findModalClosure(fresh().modal), null, 'fresh modal is clean');
    const leaked = { ...fresh().modal, continuation: { type: 'do_run', after: () => {} } };
    eq(findModalClosure(leaked), 'modal.continuation.after', 'finds a leaked closure by path');
  });
});

// Args→ports slice-1 pre-release review Fork 4: the fabric-form reducer
// writes a `fields` array into `model.modal.fabricForm` on enter. The
// contract: that subtree must round-trip JSON and carry no closures — like
// every other modal — so a WAL checkpoint taken while a form is open folds
// back to the identical state. The field array holds only strings / bools /
// nulls today, but adding this test pins the invariant so a future "cache
// the resolver's typed values as live objects" refactor can't quietly break
// replay. Same shape for fabric-field (the 1-port lane).

describe('[E14] fabric-form — replay-safe open/key/cancel/submit', () => {
  const PENDING_ACTION = { actionKey: 'provision',
    action: { type: 'run', script: 'provision "$host" "$role"',
      ports: { in: { host: { type: 'string', required: true },
                     role: { type: 'string', required: true, default: 'worker' } } } } };
  const fields = [
    { port: 'host', text: '',       required: true,  default: null },
    { port: 'role', text: 'worker', required: true,  default: 'worker' },
  ];

  it('enter → key → cancel: continuation + fabricForm round-trip JSON at every step', () => {
    let m = fresh();
    m.currentGroup = 'g';   // injects are group-scoped (B3)
    [m] = step(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING_ACTION });
    assert(m.modes.fabricFormMode, 'form open');
    eq(m.modal.fabricForm.fields.length, 2, 'both fields materialized');
    [m] = step(m, { type: 'fabric_form_key', key: 'a', seq: 'a' });
    eq(m.modal.fabricForm.fields[0].text, 'a', 'typed char appears');
    [m] = step(m, { type: 'fabric_form_cancel' });
    assert(!m.modes.fabricFormMode, 'form closed');
    eq(m.modal.fabricForm.fields.length, 0, 'buffer cleared');
  });

  it('submit path survives JSON round-trip (pendingAction is pure data from parser)', () => {
    let m = fresh();
    m.currentGroup = 'g';
    [m] = step(m, { type: 'fabric_form_enter', fields, pendingAction: PENDING_ACTION });
    [m] = step(m, { type: 'fabric_form_key', key: 'n', seq: 'n' });
    const [m2, cmds] = step(m, { type: 'fabric_form_submit' });
    assert(cmds.some((c) => c.type === 'do_run' && c.actionKey === 'provision'),
      'submit emits do_run');
    assert(!m2.modes.fabricFormMode, 'form closed');
  });

  it('a hand-planted closure under modal.fabricForm is caught by findModalClosure', () => {
    const m = fresh();
    const leaked = { ...m.modal, fabricForm: { fields: [{ port: 'host', text: () => {} }], focusIdx: 0, pendingAction: null } };
    eq(findModalClosure(leaked), 'modal.fabricForm.fields.0.text', 'closure walker catches a planted leak');
  });
});

describe('[E14] fabric-field — replay-safe open/key/cancel for the 1-port lane', () => {
  it('enter → key → cancel: fabricField round-trips JSON at every step', () => {
    let m = fresh();
    m.currentGroup = 'g';
    [m] = step(m, { type: 'fabric_field_enter', paneId: null, addr: 'provision.host', text: '',
      pendingAction: { actionKey: 'provision', action: { ports: { in: { host: {} } } } } });
    assert(m.modes.fabricFieldMode, 'field open');
    [m] = step(m, { type: 'fabric_field_key', key: 'x', seq: 'x' });
    eq(m.modal.fabricField.text, 'x', 'typed char landed');
    [m] = step(m, { type: 'fabric_field_cancel' });
    assert(!m.modes.fabricFieldMode, 'closed');
  });
});

// Round-3 review: the wedge-guard's mode_clear (fired when a modal handler
// throws) used to clear only the mode flag, leaving a stale continuation under
// model.modal — a contract leak ("every exit clears it"). Now it drops it too.
describe('[E14] mode_clear panic path clears the continuation', () => {
  it('a thrown-handler mode_clear drops a staged continuation', () => {
    const [m1] = step(fresh(), { type: 'confirm_enter', message: 'x', cmd: { type: 'do_run', actionKey: 'k' } });
    eq(m1.modal.continuation && m1.modal.continuation.type, 'do_run', 'continuation staged on enter');
    const [m2] = step(m1, { type: 'mode_clear', flag: 'confirmMode' });
    eq(m2.modes.confirmMode, false, 'mode flag cleared');
    eq(m2.modal.continuation, null, 'stale continuation dropped on the panic clear');
  });
});

report();
