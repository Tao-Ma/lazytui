/**
 * Phase 2 — `pool_hide` / `pool_show` Msg handlers on the layout slice.
 *
 * These power the `:hide <id>` / `:show <id>` cmdline verbs (registered
 * dynamically in panel/api.js#_frameworkDynamicCommands), and will be
 * driven by the Phase 4 overlay's keyboard pick + Phase 5 mouse drag.
 *
 *   node js/test/test-pool-cmdline.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');
const mpool = require('../leaves/pool');

// Build a layout slice with a known pool + placement set. Helper makes
// tests cheap to write without bringing up the whole runtime.
function buildSlice({ left = [], right = [], hidden = [], leftWidth = 30, detailHeightPct = 60 } = {}) {
  const pool = {};
  const mkEntry = (id, type, title) => ({ id, type, title: title || id, config: {} });
  const mkPlacement = (id, type, hotkey, column) => ({
    id, type, title: id, hotkey, column,
  });
  const leftPanels = [];
  const rightPanels = [];
  for (let i = 0; i < left.length; i++) {
    const [id, type] = left[i];
    pool[id] = mkEntry(id, type);
    leftPanels.push(mkPlacement(id, type, String(i + 1), 'left'));
  }
  const RIGHT_KEYS = ['7', '8', '9'];
  for (let i = 0; i < right.length; i++) {
    const [id, type] = right[i];
    pool[id] = mkEntry(id, type);
    rightPanels.push(mkPlacement(id, type, RIGHT_KEYS[i], 'right'));
  }
  for (const [id, type] of hidden) pool[id] = mkEntry(id, type);
  return {
    ...layout.init(),
    arrange: { leftWidth, detailHeightPct, leftPanels, rightPanels, pool },
  };
}

describe('[pool_hide] removes placement, pool entry stays', () => {
  it('hides a left-column panel', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups'], ['files', 'files']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'files' }, slice);
    eq(mpool.placedIds(next.arrange), ['groups', 'actions', 'detail']);
    eq(mpool.hiddenIds(next.arrange), ['files']);
    assert(next.dirty, 'slice marked dirty');
    assert(slice !== next, 'returns new slice');
  });
  it('hides a right-column panel', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['stats', 'stats'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'stats' }, slice);
    eq(next.arrange.rightPanels.map(p => p.id), ['actions', 'detail']);
    assert(next.dirty);
  });
  it('refuses to hide detail (layout invariant)', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'detail' }, slice);
    eq(next, slice, 'no-op: same slice reference returned');
  });
  it('no-op on unknown id', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'ghost' }, slice);
    eq(next, slice);
  });
  it('no-op on already-hidden id', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'notes' }, slice);
    eq(next, slice);
  });
  it('reassigns positional hotkeys after a hide', () => {
    const slice = buildSlice({
      left:  [['containers', 'containers'], ['groups', 'groups'], ['files', 'files']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_hide', id: 'groups' }, slice);
    eq(next.arrange.leftPanels.map(p => p.hotkey), ['1', '2']);
    eq(next.arrange.leftPanels.map(p => p.id), ['containers', 'files']);
  });
});

describe('[pool_show] inserts placement from pool entry', () => {
  it('shows a hidden pool entry on the right column INSERTED BEFORE detail', () => {
    // Right column convention: detail stays at the end. pool_show
    // inserts before detail (matches moveColumn behavior).
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = layout.update({ type: 'pool_show', id: 'notes' }, slice);
    eq(mpool.placedIds(next.arrange), ['groups', 'actions', 'notes', 'detail']);
    eq(mpool.hiddenIds(next.arrange), []);
    assert(next.dirty);
  });
  it("column: 'left' places into the left column (append at tail)", () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['logs', 'tail']],
    });
    const next = layout.update({ type: 'pool_show', id: 'logs', column: 'left' }, slice);
    eq(next.arrange.leftPanels.map(p => p.id), ['groups', 'logs']);
    eq(next.arrange.rightPanels.map(p => p.id), ['actions', 'detail']);
  });
  it('right column: hotkeys reassign positionally — new panel takes the slot before detail', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = layout.update({ type: 'pool_show', id: 'notes' }, slice);
    eq(next.arrange.rightPanels.map(p => [p.id, p.hotkey]),
       [['actions', '7'], ['notes', '8'], ['detail', '9']]);
  });
  it('no-op when already placed', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_show', id: 'groups' }, slice);
    eq(next, slice);
  });
  it('no-op on unknown id', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = layout.update({ type: 'pool_show', id: 'ghost' }, slice);
    eq(next, slice);
  });
  it('refuses to place a second detail panel', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['detail2', 'detail']],
    });
    const next = layout.update({ type: 'pool_show', id: 'detail2' }, slice);
    eq(next, slice);
  });
  it('refuses to place a second actions panel', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['extraActions', 'actions']],
    });
    const next = layout.update({ type: 'pool_show', id: 'extraActions' }, slice);
    eq(next, slice);
  });
  it('allows exceeding column soft cap (6 left)', () => {
    // Column caps (6 left / 3 right) are SOFT — the parser warns at
    // load time when a config exceeds them, but runtime placement
    // (pool_show / drag-insert) doesn't refuse. The renderer's
    // MIN_PANEL_H clamp is the only physical bound.
    const slice = buildSlice({
      left: [
        ['a', 'a'], ['b', 'b'], ['c', 'c'], ['d', 'd'], ['e', 'e'], ['f', 'f'],
      ],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['g', 'g']],
    });
    const next = layout.update({ type: 'pool_show', id: 'g', column: 'left' }, slice);
    eq(next.arrange.leftPanels.length, 7, 'soft cap exceeded: 7th panel placed');
    eq(next.arrange.leftPanels[6].id, 'g', 'g appended');
  });
});

describe('[hide + show round-trip]', () => {
  it('hide then show restores layout state (hotkey may differ)', () => {
    const slice = buildSlice({
      left:  [['containers', 'containers'], ['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const hidden = layout.update({ type: 'pool_hide', id: 'groups' }, slice);
    eq(mpool.placedIds(hidden.arrange), ['containers', 'actions', 'detail']);
    eq(mpool.hiddenIds(hidden.arrange), ['groups']);
    const shown = layout.update({ type: 'pool_show', id: 'groups', column: 'left' }, hidden);
    eq(mpool.placedIds(shown.arrange).sort(), ['actions', 'containers', 'detail', 'groups']);
    eq(mpool.hiddenIds(shown.arrange), []);
  });
});

report();
