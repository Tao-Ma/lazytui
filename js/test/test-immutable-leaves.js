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

const mnav = require('../leaves/wm/nav');
const mreg = require('../leaves/register');
const mtabs = require('../leaves/wm/pane-tabs');
const ms = require('../leaves/text/search');
const mfc = require('../leaves/free-config/free-config');
const mfcCore = require('../leaves/free-config/free-config-core');
const mfcMouse = require('../leaves/free-config/free-config-mouse');

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

// --- leaves/pane-tabs ----------------------------------------------------

describe('[immutable] leaves/pane-tabs.js', () => {
  // v0.6.3 TEA Phase 3c: leaves now take a single (slice, msg) where
  // msg carries the precomputed model bundle (currentGroup,
  // groupExists, yamlTerminals, actionCount). modelBundle() is the
  // single helper that computes it from (model, groupName).
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
      () => mtabs.addContent(slice, { groupName: 'g', key: 'k1', label: 'L', lines: ['x'], ...mtabs.modelBundle(model, 'g') }),
      slice,
    );
    eq(info.focusDetail, true);
    eq(next.contentTabs.g.k1.label, 'L');
    // v0.6.2 N2 — slice.lines is finalizer-derived; the content lives
    // in contentTabs[group][key].lines. Pre-N2 the reducer also mirrored
    // it to slice.lines; that mirror retired.
    eq(next.contentTabs.g.k1.lines, ['x']);
    assert(slice.contentTabs.g === undefined, 'original contentTabs untouched');
  });

  it('addEphemeral builds nested update without mutating', () => {
    const model = makeModel();
    const slice = makeSlice();
    const [next, info] = expectNoMutation(
      'addEphemeral leaves input frozen',
      () => mtabs.addEphemeral(slice, { groupName: 'g', key: 't1', cmd: 'sh', label: 'T', ...mtabs.modelBundle(model, 'g') }),
      slice,
    );
    eq(info.terminalEnter, true);
    eq(next.ephemeralTerminals.g.t1.label, 'T');
  });
});

// --- leaves/search -------------------------------------------------------

describe('[immutable] leaves/search.js', () => {
  // P1 (viewer-lines selector) — matches are NOT stored on the slice:
  // ms.matchesFor(lines, term) is the chained-selector memo. Transforms
  // take (slice, innerH, lines, term) where the caller passes the
  // phase-correct term.
  const LINES = ['hello world', 'foobar', 'world peace'];
  const makeSlice = () => ({
    lines: LINES,
    scroll: 0,
    search: { active: false, term: '', idx: 0, typing: '' },
  });

  it('enter seeds typing; matches derive via matchesFor; returns [newSlice, info]', () => {
    const slice = makeSlice();
    slice.search = { ...slice.search, term: 'world' };
    const [next, info] = expectNoMutation(
      'enter leaves input frozen',
      () => ms.enter(slice),
      slice,
    );
    eq(info.enableSearchMode, true);
    eq(next.search.typing, 'world');
    assert(ms.matchesFor(LINES, 'world').length === 2, 'two matches found');
  });

  it('matchesFor is a ref-keyed memo (same (lines, term) → same matches ref)', () => {
    const a = ms.matchesFor(LINES, 'world');
    const b = ms.matchesFor(LINES, 'world');
    assert(a === b, 'memo hit returns the same ref');
    const c = ms.matchesFor(LINES.slice(), 'world');
    assert(c !== a && c.length === a.length, 'new lines ref recomputes');
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
    slice.search = { active: true, term: 'world', typing: 'world', idx: 0 };
    const next = expectNoMutation(
      'next leaves input frozen',
      () => ms.next(slice, 4, LINES, 'world'),
      slice,
    );
    eq(next.search.idx, 1, 'idx advanced');
  });
});

// --- leaves/free-config -------------------------------------------------------
//
// The free-config leaf has 14 public mutators + the drag state machine.
// Representative coverage: nav (no-op + advance), reorder (column swap +
// undo push), moveColumn (cross-column splice), resize (clamps),
// undo/redo (snapshot round-trip), title edit, mouse press/motion/release.
// `paneBounds` is set up to a plausible rendered geometry so the
// hit-test math has values to read.

describe('[immutable] leaves/free-config.js', () => {
  const makePanel = (type, title, hotkey, extra = {}) => {
    const ci = extra.columnIndex != null ? extra.columnIndex : 0;
    // T3.5 — every pane carries a paneId (production: parser mints via
    // `mpane.wrapAsPane`; this fixture mirrors that). focus is the
    // paneId form too.
    return { type, title, hotkey, columnIndex: ci, ...extra, id: type, paneId: `pane-${type}` };
  };

  // First column (width 30, 2 panels at y=0..10, y=10..20).
  // Last column (2 panels: detail y=0..15, actions y=15..20).
  const makeSlice = () => ({
    arrange: {
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [
          makePanel('a', 'A', '1', { columnIndex: 0 }),
          makePanel('b', 'B', '2', { columnIndex: 0 }),
        ] },
        { panels: [
          makePanel('detail',  'Detail',  'o', { columnIndex: 1 }),
          makePanel('actions', 'Actions', '0', { columnIndex: 1 }),
        ] },
      ],
    },
    dirty: false,
    freeConfig: {
      enabled: true,
      drag: null,
      undo: [],
      redo: [],
      titleEdit: { active: false, text: '' },
    },
    paneBounds: {
      a:       { x: 0,  y: 0,  w: 30, h: 10 },
      b:       { x: 0,  y: 10, w: 30, h: 10 },
      detail:  { x: 30, y: 0,  w: 50, h: 15 },
      actions: { x: 30, y: 15, w: 50, h: 5  },
    },
    // focus is the single source of truth for the active panel in
    // free-config (post-v0.6.x); the design.selectedIdx field is gone,
    // mfcCore.selectedIdx(slice) derives the index from focus.
    focus: 'pane-a',
    viewMode: 'normal',
  });

  const makeModel = () => ({ modes: { freeConfigMode: true } });

  it('navSelect advances focus to the next panel', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'navSelect(+1) leaves input frozen',
      () => mfc.navSelect(slice, 1),
      slice,
    );
    eq(out.focus, 'pane-b', 'focus advanced to next panel');
    eq(slice.focus, 'pane-a', 'original untouched');
  });

  it('navSelect at boundary returns same ref (identity-preserve)', () => {
    const slice = makeSlice();
    const out = mfc.navSelect(slice, -1);
    assert(out === slice, 'no-op nav at idx=0 returns same ref');
  });

  it('reorderWithin swaps panels, pushes undo, marks dirty', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'reorderWithin(+1) leaves input frozen',
      () => mfc.reorderWithin(slice, 1),
      slice,
    );
    eq(out.arrange.columns[0].panels[0].type, 'b', 'b swapped to slot 0');
    eq(out.arrange.columns[0].panels[1].type, 'a', 'a swapped to slot 1');
    eq(out.arrange.columns[0].panels[0].hotkey, '1', 'hotkey reassigned positionally');
    eq(out.arrange.columns[0].panels[1].hotkey, '2');
    assert(out.dirty === true, 'dirty flag set');
    eq(out.freeConfig.undo.length, 1, 'undo stack pushed');
    // focus stays at 'a' (same type, new position); derived selectedIdx
    // is now 1 because 'a' moved to slot 1 of the left column.
    eq(out.focus, 'pane-a', 'focus follows the panel by TYPE');
    eq(mfcCore.selectedIdx(out), 1, 'derived index reflects the new position');
  });

  it('moveColumn left→right splices across columns', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'moveColumn(+1) leaves input frozen',
      () => mfc.moveColumn(slice, +1),
      slice,
    );
    eq(out.arrange.columns[0].panels.length, 1, 'first column lost a panel');
    eq(out.arrange.columns[1].panels.length, 3, 'last column gained a panel');
    // v0.6.4 — 'a' appends at the tail (no detail-stays-at-end clamp):
    // new last order: detail, actions, a
    eq(out.arrange.columns[1].panels[2].type, 'a');
    eq(out.arrange.columns[1].panels[2].columnIndex, 1);
    eq(out.arrange.columns[1].panels[0].type, 'detail', 'detail unchanged at head');
    assert(out.dirty === true);
  });

  it('resizeWidthOrDetail clamps + pushes undo', () => {
    const slice = makeSlice();
    // 'a' is selected (idx 0), in first column → +/- adjusts column 0's width by 2.
    const out = expectNoMutation(
      'resizeWidthOrDetail(+1) leaves input frozen',
      () => mfc.resizeWidthOrDetail(slice, 1),
      slice,
    );
    eq(out.arrange.columns[0].width, 32, 'column 0 width +2');
    eq(out.freeConfig.undo.length, 1);
    assert(out.dirty === true);
  });

  it('undo/redo round-trip restores arrange via snapshot', () => {
    const slice = makeSlice();
    // first reorder so undo stack has something
    const reordered = mfc.reorderWithin(slice, 1);
    const undone = expectNoMutation(
      'undo leaves input frozen',
      () => mfcCore.undo(reordered),
      reordered,
    );
    eq(undone.arrange.columns[0].panels[0].type, 'a', 'a restored to slot 0');
    eq(undone.freeConfig.undo.length, 0, 'undo stack emptied');
    eq(undone.freeConfig.redo.length, 1, 'redo stack got the snapshot');
    const redone = mfcCore.redo(undone);
    eq(redone.arrange.columns[0].panels[0].type, 'b', 'redo replays the swap');
  });

  it('clearUndoStacks wipes both stacks; identity-preserve when empty', () => {
    const slice = makeSlice();
    const same = mfcCore.clearUndoStacks(slice);
    assert(same === slice, 'already-empty stacks → same ref');
    const populated = mfc.reorderWithin(slice, 1);
    const cleared = expectNoMutation(
      'clearUndoStacks leaves input frozen',
      () => mfcCore.clearUndoStacks(populated),
      populated,
    );
    eq(cleared.freeConfig.undo.length, 0);
    eq(cleared.freeConfig.redo.length, 0);
  });

  it('titleEnter seeds the buffer', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'titleEnter leaves input frozen',
      () => mfc.titleEnter(slice),
      slice,
    );
    eq(out.freeConfig.titleEdit.text, 'A', 'seeded from selected panel title');
  });

  it('setSelectedTitle replaces panel title + pushes undo', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'setSelectedTitle leaves input frozen',
      () => mfc.setSelectedTitle(slice, 'Aleph'),
      slice,
    );
    eq(out.arrange.columns[0].panels[0].title, 'Aleph');
    eq(out.freeConfig.undo.length, 1);
    assert(out.dirty === true);
  });

  it('clampSelected snaps focus back when focus names a hidden panel', () => {
    // post-v0.6.x: clampSelected restores the invariant by snapping
    // focus to a valid placed-panel type, not by clamping an integer.
    const slice = makeSlice();
    const stale = { ...slice, focus: 'pane-ghost' };
    const out = expectNoMutation(
      'clampSelected leaves input frozen',
      () => mfcCore.clampSelected(stale),
      stale,
    );
    // First placed panel becomes the snap target.
    eq(out.focus, 'pane-a', 'focus snapped to first placed panel');
  });

  it('mousePress on a panel arms the drag + sets focus to the clicked type', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'mousePress leaves input frozen',
      () => mfcMouse.mousePress(slice, 5, 5, 80),  // inside panel 'a'
      slice,
    );
    eq(out.freeConfig.drag.kind, 'dragging');
    eq(out.freeConfig.drag.target, null, 'AR4 — target=null until motion');
    eq(out.freeConfig.drag.sourceType, 'a');
    eq(out.focus, 'pane-a', 'focus tracks the clicked panel');
  });

  it('mouseMotion computes drop target on movement', () => {
    const slice = makeSlice();
    const model = makeModel();
    const pressed = mfcMouse.mousePress(slice, 5, 5, 80);
    const moved = expectNoMutation(
      'mouseMotion leaves input frozen',
      () => mfcMouse.mouseMotion(pressed, 5, 12, 80),  // drag down into 'b'
      pressed,
    );
    eq(moved.freeConfig.drag.kind, 'dragging');
    assert(moved.freeConfig.drag.target !== null, 'drop target computed');
  });

  it('mouseRelease commits a valid drop + clears drag', () => {
    const slice = makeSlice();
    const model = makeModel();
    let s = mfcMouse.mousePress(slice, 5, 5, 80);   // press 'a'
    s = mfcMouse.mouseMotion(s, 5, 16, 80);                // drag below 'b'
    const out = expectNoMutation(
      'mouseRelease leaves input frozen',
      () => mfcMouse.mouseRelease(s),
      s,
    );
    eq(out.freeConfig.drag, null, 'drag cleared');
    eq(out.arrange.columns[0].panels[0].type, 'b', 'a moved past b');
    eq(out.arrange.columns[0].panels[1].type, 'a');
    assert(out.dirty === true);
  });
});

report();
