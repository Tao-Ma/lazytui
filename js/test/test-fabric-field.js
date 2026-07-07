/**
 * Fabric field-edit (P1.5 slice C2) — the component-ports pane's in-grid input
 * editor. Two layers:
 *   - the fabric-field modal sub-reducer via the ROOT reducer (enter/key/submit/
 *     cancel → a sticky inject), frozen-input purity;
 *   - the pane's update() key-claim (Enter/x → the resolve effects).
 * Run: node js/test/test-fabric-field.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const runtime = require('../app/runtime');
const pane = require('../panel/fabric/ports-pane');

function freshModel() {
  const m = runtime.init();
  m.register = { history: [], cap: 10 };
  return m;
}
const ADDR = 'xlogminer.start_lsn';

describe('[fabric-field] enter / key / submit', () => {
  it('enter opens the editor (mode + buffer) on a fresh model (frozen input)', () => {
    const m = freshModel();
    const [next] = expectNoMutation(
      'fabric_field_enter leaves input frozen',
      () => runtime.update(m, { type: 'fabric_field_enter', paneId: 'p', addr: ADDR, text: '0/10' }),
      m,
    );
    assert(next.modes.fabricFieldMode, 'mode on');
    eq(next.modal.fabricField.addr, ADDR);
    eq(next.modal.fabricField.paneId, 'p');
    eq(next.modal.fabricField.text, '0/10', 'seeded with the current value');
  });

  it('enter is refused over a live modal (flat-modal guard)', () => {
    const m = freshModel();
    m.modes.cmdMode = true;   // another chain mode active
    const [same] = runtime.update(m, { type: 'fabric_field_enter', paneId: 'p', addr: ADDR });
    assert(!same.modes.fabricFieldMode, 'did not open over cmdline');
  });

  it('enter with no address is a no-op', () => {
    const m = freshModel();
    const [same] = runtime.update(m, { type: 'fabric_field_enter', paneId: 'p' });
    assert(!same.modes.fabricFieldMode);
  });

  it('key appends printable chars; backspace + Ctrl-U edit', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_field_enter', paneId: 'p', addr: ADDR, text: '' });
    [m] = runtime.update(m, { type: 'fabric_field_key', key: '0', seq: '0' });
    [m] = runtime.update(m, { type: 'fabric_field_key', key: '/', seq: '/' });
    [m] = runtime.update(m, { type: 'fabric_field_key', key: 'A', seq: 'A' });
    eq(m.modal.fabricField.text, '0/A');
    [m] = runtime.update(m, { type: 'fabric_field_key', seq: '\x7f' });   // backspace
    eq(m.modal.fabricField.text, '0/');
    [m] = runtime.update(m, { type: 'fabric_field_key', seq: '\x15' });   // Ctrl-U
    eq(m.modal.fabricField.text, '');
  });

  it('submit commits the raw text as a sticky inject + closes the editor', () => {
    let m = freshModel();
    m.now = 999;
    [m] = runtime.update(m, { type: 'fabric_field_enter', paneId: 'p', addr: ADDR, text: '0/1A2B3C0' });
    const [next, cmds] = runtime.update(m, { type: 'fabric_field_submit' });
    eq(next.fabric.injects[ADDR].value, '0/1A2B3C0', 'raw value, never re-parsed');
    eq(next.fabric.injects[ADDR].at, 999, 'stamped from model.now');
    assert(!next.modes.fabricFieldMode, 'editor closed');
    eq(next.modal.fabricField.addr, null, 'buffer cleared');
    eq(cmds.length, 0, 'atomic reduction — inject folded in, no cascade');
  });

  it('cancel closes without injecting', () => {
    let m = freshModel();
    [m] = runtime.update(m, { type: 'fabric_field_enter', paneId: 'p', addr: ADDR, text: 'x' });
    const [next] = runtime.update(m, { type: 'fabric_field_cancel' });
    assert(!next.modes.fabricFieldMode);
    assert(!(ADDR in next.fabric.injects), 'no inject written');
  });

  it('key / submit / cancel outside the mode are no-ops', () => {
    const m = freshModel();
    const [a] = runtime.update(m, { type: 'fabric_field_key', seq: 'z' });
    assert(a === m, 'key no-op');
    const [b] = runtime.update(m, { type: 'fabric_field_submit' });
    assert(b === m, 'submit no-op');
  });
});

describe('[fabric-field] pane key-claim', () => {
  const slice = { paneId: 'p', nav: { cursor: 2, scroll: 0, multiSel: new Set(), filter: '' } };

  it('Enter claims + emits fabric_field_open for the cursor row', () => {
    const [, cmds] = pane.update({ type: 'key', key: 'return' }, slice);
    assert(cmds.some((c) => c.type === '_claimed'), 'claims Enter (suppresses run_selected)');
    const open = cmds.find((c) => c.type === 'fabric_field_open');
    assert(open, 'emits the resolve effect');
    eq(open.paneId, 'p');
    eq(open.cursor, 2, 'carries the current cursor');
  });

  it('x claims + emits fabric_field_clear', () => {
    const [, cmds] = pane.update({ type: 'key', key: 'x' }, slice);
    assert(cmds.some((c) => c.type === '_claimed'));
    assert(cmds.some((c) => c.type === 'fabric_field_clear'), 'clear effect');
  });

  it('an unclaimed key returns the slice unchanged (falls through)', () => {
    const out = pane.update({ type: 'key', key: 'g' }, slice);
    assert(out === slice, 'no claim, framework handles it');
  });
});

report();
