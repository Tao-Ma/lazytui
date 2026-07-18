/**
 * Slice 1 — the pure text-selection core (leaves/text/select-core) + the root
 * reducer arms (sel_begin / sel_extend / sel_clear). See docs/pane-selection.md.
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

describe('[select-core] root reducer arms', () => {
  it('sel_begin sets an active selection owned by the pane', () => {
    const [m] = update(init(), { type: 'sel_begin', paneId: 'ports-1', line: 2, col: 4 });
    eq(m.selection.paneId, 'ports-1');
    eq(m.selection.active, true);
    eq(m.selection.anchor.line, 2);
    eq(m.selection.cursor.col, 4, 'cursor starts at the anchor');
  });
  it('sel_extend moves the cursor, keeps the anchor', () => {
    let m = init();
    [m] = update(m, { type: 'sel_begin', paneId: 'ports-1', line: 0, col: 0 });
    [m] = update(m, { type: 'sel_extend', line: 0, col: 6 });
    eq(m.selection.anchor.col, 0);
    eq(m.selection.cursor.col, 6);
  });
  it('sel_extend is a no-op without an active selection', () => {
    const before = init();
    const [after] = update(before, { type: 'sel_extend', line: 1, col: 1 });
    eq(after, before, 'same model ref — no-op');
  });
  it('sel_clear resets to the inactive, unowned selection', () => {
    let m = init();
    [m] = update(m, { type: 'sel_begin', paneId: 'ports-1', line: 1, col: 1 });
    [m] = update(m, { type: 'sel_clear' });
    eq(m.selection.paneId, null);
    eq(m.selection.active, false);
  });
});

report();
