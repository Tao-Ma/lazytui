/**
 * Pure-TEA conversion smoke test (Phase 1).
 *
 * For each converted leaf, deep-freeze a representative input and call
 * the leaf — the call must:
 *   1. NOT throw a "cannot assign to frozen X" TypeError (any throw
 *      means the leaf attempted an in-place mutation).
 *   2. Return a fresh object reference (NOT the same input ref) when
 *      the operation actually changes anything.
 *
 * Run: node js/test/test-immutable-leaves.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');

const mnav = require('../leaves/nav');
const mreg = require('../leaves/register');
const mtabs = require('../leaves/tabs');
const ms = require('../leaves/search');
const mdesign = require('../leaves/design');

// --- leaves/nav ----------------------------------------------------------

describe('[immutable] leaves/nav.js', () => {
  it('set_cursor produces a new slice with new entry', () => {
    const slice = { nav: { p: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } } };
    const out = expectNoMutation(
      'set_cursor leaves input frozen',
      () => mnav.apply(slice, { type: 'set_cursor', panel: 'p', index: 3 }),
      slice,
    );
    eq(out.nav.p.cursor, 3, 'cursor advanced on the new slice');
    eq(slice.nav.p.cursor, 0, 'original slice untouched');
  });

  it('multisel_toggle returns a slice with a new Set', () => {
    const slice = { nav: { p: { cursor: 0, scroll: 0, multiSel: new Set(['a']), filter: '' } } };
    const out = expectNoMutation(
      'multisel_toggle leaves input frozen',
      () => mnav.apply(slice, { type: 'multisel_toggle', panel: 'p', id: 'b' }),
      slice,
    );
    assert(out.nav.p.multiSel.has('a') && out.nav.p.multiSel.has('b'), 'b added to new Set');
    assert(slice.nav.p.multiSel.size === 1, 'original Set unchanged');
    assert(out.nav.p.multiSel !== slice.nav.p.multiSel, 'Set ref distinct');
  });

  it('non-nav msg returns undefined (caller signal)', () => {
    const slice = { nav: { p: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } } };
    eq(mnav.apply(slice, { type: 'something_else' }), undefined,
       'undefined for non-nav Msgs — signals fall-through');
  });
});

// --- leaves/register -----------------------------------------------------

describe('[immutable] leaves/register.js', () => {
  it('push returns [newRegister, value]', () => {
    const register = { history: ['old'], cap: 10 };
    const [next, value] = expectNoMutation(
      'push leaves input frozen',
      () => mreg.push(register, 'new'),
      register,
    );
    eq(next.history, ['new', 'old'], 'history prepended');
    eq(value, 'new', 'returned text matches');
    eq(register.history, ['old'], 'original history unchanged');
  });

  it('drop returns [newRegister, removed]', () => {
    const register = { history: ['a', 'b', 'c'], cap: 10 };
    const [next, removed] = expectNoMutation(
      'drop leaves input frozen',
      () => mreg.drop(register, 1),
      register,
    );
    eq(next.history, ['a', 'c'], 'middle entry dropped');
    eq(removed, true, 'reported removed');
  });

  it('promote moves entry to top', () => {
    const register = { history: ['a', 'b', 'c'], cap: 10 };
    const [next, value] = expectNoMutation(
      'promote leaves input frozen',
      () => mreg.promote(register, 2),
      register,
    );
    eq(next.history, ['c', 'a', 'b'], 'c promoted to head');
    eq(value, 'c');
  });

  it('clear returns the same ref when already empty (identity-preserve)', () => {
    const register = { history: [], cap: 10 };
    const out = mreg.clear(register);
    assert(out === register, 'empty clear returns same ref — caller can skip writes');
  });
});

// --- leaves/tabs ---------------------------------------------------------

describe('[immutable] leaves/tabs.js', () => {
  const makeModel = () => ({
    currentGroup: 'g',
    config: { groups: { g: { actions: {}, terminals: {} } } },
  });
  const makeSlice = () => ({
    lines: [], scroll: 0, tab: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
    contentTabs: {},
    ephemeralTerminals: {},
  });

  it('addContent returns [newSlice, info]', () => {
    const model = makeModel();
    const slice = makeSlice();
    const [next, info] = expectNoMutation(
      'addContent leaves input frozen',
      () => mtabs.addContent(slice, model, { groupName: 'g', key: 'k1', label: 'L', lines: ['x'] }),
      slice,
    );
    eq(info.focusDetail, true);
    eq(next.contentTabs.g.k1.label, 'L');
    eq(next.lines, ['x']);
    assert(slice.contentTabs.g === undefined, 'original contentTabs untouched');
  });

  it('addEphemeral builds nested update without mutating', () => {
    const model = makeModel();
    const slice = makeSlice();
    const [next, info] = expectNoMutation(
      'addEphemeral leaves input frozen',
      () => mtabs.addEphemeral(slice, model, { groupName: 'g', key: 't1', cmd: 'sh', label: 'T' }),
      slice,
    );
    eq(info.terminalEnter, true);
    eq(next.ephemeralTerminals.g.t1.label, 'T');
  });
});

// --- leaves/search -------------------------------------------------------

describe('[immutable] leaves/search.js', () => {
  const makeSlice = () => ({
    lines: ['hello world', 'foobar', 'world peace'],
    scroll: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
  });

  it('enter seeds typing + computes matches; returns [newSlice, info]', () => {
    const slice = makeSlice();
    slice.search = { ...slice.search, term: 'world' };
    const [next, info] = expectNoMutation(
      'enter leaves input frozen',
      () => ms.enter(slice),
      slice,
    );
    eq(info.enableSearchMode, true);
    eq(next.search.typing, 'world');
    assert(next.search.matches.length === 2, 'two matches found');
  });

  it('keystroke returns new slice with updated typing', () => {
    const slice = makeSlice();
    slice.search = { ...slice.search, typing: 'wor' };
    const next = expectNoMutation(
      'keystroke leaves input frozen',
      () => ms.keystroke(slice, 'l'),
      slice,
    );
    eq(next.search.typing, 'worl');
  });

  it('next cycles match index + may scroll', () => {
    const slice = makeSlice();
    slice.search = {
      active: true, term: 'world', typing: 'world', idx: 0,
      matches: [{ line: 0, col: 6, len: 5 }, { line: 2, col: 0, len: 5 }],
    };
    const next = expectNoMutation(
      'next leaves input frozen',
      () => ms.next(slice),
      slice,
    );
    eq(next.search.idx, 1, 'idx advanced');
  });
});

// --- leaves/design -------------------------------------------------------
//
// The design leaf has 14 public mutators + the drag state machine.
// Representative coverage: nav (no-op + advance), reorder (column swap +
// undo push), moveColumn (cross-column splice), resize (clamps),
// undo/redo (snapshot round-trip), title edit, mouse press/motion/release.
// `panelBounds` is set up to a plausible rendered geometry so the
// hit-test math has values to read.

describe('[immutable] leaves/design.js', () => {
  const makePanel = (type, title, hotkey, extra = {}) =>
    ({ type, title, hotkey, column: extra.column || 'left', ...extra });

  // 30-col left, 2 panels left ('a' at y=0..10, 'b' at y=10..20),
  // 2 panels right (detail at y=0..15, actions at y=15..20).
  const makeSlice = () => ({
    arrange: {
      leftWidth: 30,
      detailHeightPct: 60,
      leftPanels: [
        makePanel('a', 'A', '1', { column: 'left' }),
        makePanel('b', 'B', '2', { column: 'left' }),
      ],
      rightPanels: [
        makePanel('detail', 'Detail', 'o', { column: 'right' }),
        makePanel('actions', 'Actions', '0', { column: 'right' }),
      ],
    },
    dirty: false,
    design: {
      enabled: true,
      selectedIdx: 0,
      drag: null,
      undo: [],
      redo: [],
      titleEdit: { active: false, text: '' },
    },
    panelBounds: {
      a:       { x: 0,  y: 0,  w: 30, h: 10 },
      b:       { x: 0,  y: 10, w: 30, h: 10 },
      detail:  { x: 30, y: 0,  w: 50, h: 15 },
      actions: { x: 30, y: 15, w: 50, h: 5  },
    },
    panels: {},
    focus: 'groups',
    viewMode: 'normal',
    panelHeights: {},
  });

  const makeModel = () => ({ modes: { freeConfigMode: true } });

  it('navSelect advances selectedIdx without mutating input', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'navSelect(+1) leaves input frozen',
      () => mdesign.navSelect(slice, 1),
      slice,
    );
    eq(out.design.selectedIdx, 1, 'selectedIdx advanced');
    eq(slice.design.selectedIdx, 0, 'original untouched');
  });

  it('navSelect at boundary returns same ref (identity-preserve)', () => {
    const slice = makeSlice();
    const out = mdesign.navSelect(slice, -1);
    assert(out === slice, 'no-op nav at idx=0 returns same ref');
  });

  it('reorderWithin swaps panels, pushes undo, marks dirty', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'reorderWithin(+1) leaves input frozen',
      () => mdesign.reorderWithin(slice, 1),
      slice,
    );
    eq(out.arrange.leftPanels[0].type, 'b', 'b swapped to slot 0');
    eq(out.arrange.leftPanels[1].type, 'a', 'a swapped to slot 1');
    eq(out.arrange.leftPanels[0].hotkey, '1', 'hotkey reassigned positionally');
    eq(out.arrange.leftPanels[1].hotkey, '2');
    assert(out.dirty === true, 'dirty flag set');
    eq(out.design.undo.length, 1, 'undo stack pushed');
    eq(out.design.selectedIdx, 1, 'selection follows the panel');
  });

  it('moveColumn left→right splices across columns', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'moveColumn(right) leaves input frozen',
      () => mdesign.moveColumn(slice, 'right'),
      slice,
    );
    eq(out.arrange.leftPanels.length, 1, 'left lost a panel');
    eq(out.arrange.rightPanels.length, 3, 'right gained a panel');
    // 'a' inserts before detail; new right order: a, detail, actions
    eq(out.arrange.rightPanels[0].type, 'a');
    eq(out.arrange.rightPanels[0].column, 'right');
    assert(out.dirty === true);
  });

  it('resizeWidthOrDetail clamps + pushes undo', () => {
    const slice = makeSlice();
    // 'a' is selected (idx 0), isLeft = true, so +/- adjusts leftWidth by 2.
    const out = expectNoMutation(
      'resizeWidthOrDetail(+1) leaves input frozen',
      () => mdesign.resizeWidthOrDetail(slice, 1),
      slice,
    );
    eq(out.arrange.leftWidth, 32, 'leftWidth +2');
    eq(out.design.undo.length, 1);
    assert(out.dirty === true);
  });

  it('undo/redo round-trip restores arrange via snapshot', () => {
    const slice = makeSlice();
    // first reorder so undo stack has something
    const reordered = mdesign.reorderWithin(slice, 1);
    const undone = expectNoMutation(
      'undo leaves input frozen',
      () => mdesign.undo(reordered),
      reordered,
    );
    eq(undone.arrange.leftPanels[0].type, 'a', 'a restored to slot 0');
    eq(undone.design.undo.length, 0, 'undo stack emptied');
    eq(undone.design.redo.length, 1, 'redo stack got the snapshot');
    const redone = mdesign.redo(undone);
    eq(redone.arrange.leftPanels[0].type, 'b', 'redo replays the swap');
  });

  it('clearUndoStacks wipes both stacks; identity-preserve when empty', () => {
    const slice = makeSlice();
    const same = mdesign.clearUndoStacks(slice);
    assert(same === slice, 'already-empty stacks → same ref');
    const populated = mdesign.reorderWithin(slice, 1);
    const cleared = expectNoMutation(
      'clearUndoStacks leaves input frozen',
      () => mdesign.clearUndoStacks(populated),
      populated,
    );
    eq(cleared.design.undo.length, 0);
    eq(cleared.design.redo.length, 0);
  });

  it('titleEnter seeds the buffer', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'titleEnter leaves input frozen',
      () => mdesign.titleEnter(slice),
      slice,
    );
    eq(out.design.titleEdit.active, true);
    eq(out.design.titleEdit.text, 'A', 'seeded from selected panel title');
  });

  it('setSelectedTitle replaces panel title + pushes undo', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'setSelectedTitle leaves input frozen',
      () => mdesign.setSelectedTitle(slice, 'Aleph'),
      slice,
    );
    eq(out.arrange.leftPanels[0].title, 'Aleph');
    eq(out.design.undo.length, 1);
    assert(out.dirty === true);
  });

  it('clampSelected pulls out-of-range idx back in', () => {
    const slice = makeSlice();
    const high = { ...slice, design: { ...slice.design, selectedIdx: 99 } };
    const out = expectNoMutation(
      'clampSelected leaves input frozen',
      () => mdesign.clampSelected(high),
      high,
    );
    eq(out.design.selectedIdx, 3, 'clamped to last panel (4 total - 1)');
  });

  it('mousePress on a panel arms the drag + selects', () => {
    const slice = makeSlice();
    const model = makeModel();
    const out = expectNoMutation(
      'mousePress leaves input frozen',
      () => mdesign.mousePress(slice, 5, 5, 80),  // inside panel 'a'
      slice,
    );
    eq(out.design.drag.kind, 'armed');
    eq(out.design.drag.sourceType, 'a');
    eq(out.design.selectedIdx, 0);
  });

  it('mouseMotion promotes armed → dragging on movement', () => {
    const slice = makeSlice();
    const model = makeModel();
    const pressed = mdesign.mousePress(slice, 5, 5, 80);
    const moved = expectNoMutation(
      'mouseMotion leaves input frozen',
      () => mdesign.mouseMotion(pressed, 5, 12, 80),  // drag down into 'b'
      pressed,
    );
    eq(moved.design.drag.kind, 'dragging');
    assert(moved.design.drag.target !== null, 'drop target computed');
  });

  it('mouseRelease commits a valid drop + clears drag', () => {
    const slice = makeSlice();
    const model = makeModel();
    let s = mdesign.mousePress(slice, 5, 5, 80);   // press 'a'
    s = mdesign.mouseMotion(s, 5, 16, 80);                // drag below 'b'
    const out = expectNoMutation(
      'mouseRelease leaves input frozen',
      () => mdesign.mouseRelease(s),
      s,
    );
    eq(out.design.drag, null, 'drag cleared');
    eq(out.arrange.leftPanels[0].type, 'b', 'a moved past b');
    eq(out.arrange.leftPanels[1].type, 'a');
    assert(out.dirty === true);
  });
});

report();
