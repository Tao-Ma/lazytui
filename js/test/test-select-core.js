/**
 * Slice 1 — the pure text-selection core (leaves/text/select-core) + the root
 * reducer arms (mouse_sel_begin / mouse_sel_extend / mouse_sel_clear). See docs/pane-selection.md.
 * Run: node js/test/test-select-core.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sc = require('../leaves/text/select-core');
const { update } = require('../dispatch/update/reducer');
const { init } = require('../model/store');

const LINES = [
  'primary_lsn  demo.lsn  0/CAFE',
  'standby_lsn  demo.lsn  0/BEEF',
  '日本語  wide',                       // CJK — each glyph is 2 display cols
];

const selChar = (aL, aC, cL, cC) => ({
  anchor: { line: aL, col: aC }, cursor: { line: cL, col: cC }, kind: 'char', active: true,
});

describe('[select-core] selectedTextFrom — char mode', () => {
  it('grabs a substring on one line by DISPLAY columns', () => {
    // "0/CAFE" starts at display col 23 in line 0.
    eq(sc.selectedTextFrom(LINES, selChar(0, 23, 0, 28)), '0/CAFE');
  });
  it('is inclusive of the char under the end column (drag-onto includes it)', () => {
    // endCol 7 = the '_' at display col 7 → included.
    eq(sc.selectedTextFrom(LINES, selChar(0, 0, 0, 7)), 'primary_');
  });
  it('spans multiple lines (first tail + whole middle + last head)', () => {
    const t = sc.selectedTextFrom(LINES, selChar(0, 23, 1, 10));
    eq(t, '0/CAFE\nstandby_lsn');
  });
  it('normalizes a backwards (cursor-before-anchor) selection', () => {
    eq(sc.selectedTextFrom(LINES, selChar(0, 28, 0, 23)), '0/CAFE');
  });
  it('maps wide CJK glyphs — a click on either cell grabs the whole glyph', () => {
    // 日本語 occupies display cols 0..5 (3 glyphs × 2). Cols 0..1 → 日.
    eq(sc.selectedTextFrom(LINES, selChar(2, 0, 2, 1)), '日');
    eq(sc.selectedTextFrom(LINES, selChar(2, 0, 2, 5)), '日本語');
  });
  it('returns "" for an inactive selection', () => {
    eq(sc.selectedTextFrom(LINES, { ...selChar(0, 0, 0, 3), active: false }), '');
  });
});

describe('[select-core] selectedTextFrom — line mode', () => {
  it('grabs whole lines regardless of column', () => {
    const sel = { anchor: { line: 0, col: 5 }, cursor: { line: 1, col: 2 }, kind: 'line', active: true };
    eq(sc.selectedTextFrom(LINES, sel), `${LINES[0]}\n${LINES[1]}`);
  });
});

describe('[select-core] decorateWindow', () => {
  it('reverses only the selected span; other lines pass through', () => {
    const out = sc.decorateWindow(LINES, selChar(0, 23, 0, 28), 0);
    assert(/\[reverse\]0\/CAFE\[\/\]/.test(out[0]), `span reversed: ${out[0]}`);
    eq(out[1], LINES[1], 'unselected line untouched');
  });
  it('honours the window offset (absolute range vs windowed lines)', () => {
    // selection on absolute line 1; window starts at offset 1 → row 0 is line 1.
    const win = LINES.slice(1);
    const out = sc.decorateWindow(win, selChar(1, 0, 1, 10), 1);
    assert(/\[reverse\]/.test(out[0]), 'absolute line 1 highlighted at window row 0');
  });
  it('returns lines unchanged when no active selection', () => {
    const out = sc.decorateWindow(LINES, { active: false });
    eq(out, LINES);
  });
});

describe('[select-core] decorateWindow — selection over a reversed (cursor) row XORs', () => {
  // A selected/cursor row ships as a leading `[reverse]` (theme().selected). A
  // naive re-reverse would wipe the bar and leave the span reverse-on-reverse (no
  // contrast); the selected span must instead read as NORMAL video, with the row's
  // reverse kept around it. Regression for the "selection over the cursor row looks
  // wrong" report.
  const REV = '[reverse]  alpha   running  ';   // leading reverse, no closing tag
  it('drops reverse on the selected span so it stands out against the reversed row', () => {
    const out = sc.decorateWindow([REV], selChar(0, 2, 0, 6), 0)[0];
    assert(!/\[reverse\]alpha/.test(out), `selected span must NOT be reversed: ${out}`);
    assert(/\[\/\]alpha\[reverse\]/.test(out), `span is normal video between reversed sides: ${out}`);
  });
  it('keeps the row reverse on both sides of the selection', () => {
    const out = sc.decorateWindow([REV], selChar(0, 2, 0, 6), 0)[0];
    assert(out.startsWith('[reverse]  [/]'), `before-span stays reversed: ${out}`);
    assert(/alpha\[reverse\]   running/.test(out), `after-span reversed to EOL: ${out}`);
  });
  it('a plain (non-cursor) row still reverses the selected span (unchanged)', () => {
    const out = sc.decorateWindow(['  alpha   running  '], selChar(0, 2, 0, 6), 0)[0];
    assert(/\[reverse\]alpha\[\/\]/.test(out), `plain-row span reversed: ${out}`);
  });
});

describe('[select-core] reduceSelect — the shared state arms', () => {
  it('select_begin sets an active char selection at the coords', () => {
    const sel = sc.reduceSelect({ type: 'select_begin', line: 2, col: 4 }, undefined);
    eq(sel.active, true);
    eq(sel.kind, 'char');
    eq(sel.anchor.line, 2);
    eq(sel.cursor.col, 4, 'cursor starts at the anchor');
  });
  it('select_begin clamps the line against linesLen when given', () => {
    const sel = sc.reduceSelect({ type: 'select_begin', line: 99, col: 4 }, undefined, 3);
    eq(sel.anchor.line, 2, 'clamped to the last line');
  });
  it('select_begin floors coords at 0 without a linesLen bound', () => {
    const sel = sc.reduceSelect({ type: 'select_begin', line: -3, col: -1 }, undefined);
    eq(sel.anchor.line, 0);
    eq(sel.anchor.col, 0);
  });
  it('select_extend moves the cursor, keeps the anchor', () => {
    let sel = sc.reduceSelect({ type: 'select_begin', line: 0, col: 0 }, undefined);
    sel = sc.reduceSelect({ type: 'select_extend', line: 0, col: 6 }, sel);
    eq(sel.anchor.col, 0);
    eq(sel.cursor.col, 6);
  });
  it('select_extend is identity without an active selection', () => {
    const before = { ...selChar(0, 0, 0, 3), active: false };
    eq(sc.reduceSelect({ type: 'select_extend', line: 1, col: 1 }, before), before, 'same ref — no-op');
    eq(sc.reduceSelect({ type: 'select_extend', line: 1, col: 1 }, undefined), undefined);
  });
  it('select_cancel deactivates; identity when already inactive', () => {
    const active = selChar(0, 0, 1, 2);
    const off = sc.reduceSelect({ type: 'select_cancel' }, active);
    eq(off.active, false);
    eq(sc.reduceSelect({ type: 'select_cancel' }, off), off, 'same ref — no-op');
  });
  it('returns undefined for a Msg it does not own', () => {
    eq(sc.reduceSelect({ type: 'viewer_scroll', delta: 1 }, selChar(0, 0, 0, 1)), undefined);
  });
});

describe('[select-core] reset_group_context emits the selection clear Cmd', () => {
  it('a group switch carries select_cancel_all so a stale per-pane selection is dropped', () => {
    const [, cmds] = update(init(), { type: 'reset_group_context', owners: {} });
    assert(cmds.some((c) => c && c.type === 'select_cancel_all'),
      'reset_group_context Cmds include select_cancel_all');
  });
});

report();
