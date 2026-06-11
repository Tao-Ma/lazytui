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

// Component.update returns either `slice` or `[slice, cmds]` — the
// runtime's `_runInstance` handles both forms. Tests only assert on
// slice fields, so unwrap the tuple. R1.3 made pool_hide/pool_show/
// remove_column emit a Cmd tuple when focus changes.
const update = (msg, slice) => {
  const r = layout.update(msg, slice);
  return Array.isArray(r) ? r[0] : r;
};

// Build a layout slice with a known pool + placement set. Helper makes
// tests cheap to write without bringing up the whole runtime.
function buildSlice({ left = [], right = [], hidden = [], leftWidth = 30, detailHeightPct = 60 } = {}) {
  const pool = {};
  const mkEntry = (id, type, title) => ({ id, type, title: title || id, config: {} });
  const mkPlacement = (id, type, hotkey, columnIndex) => ({
    id, type, title: id, hotkey, columnIndex,
  });
  const leftPanels = [];
  const rightPanels = [];
  for (let i = 0; i < left.length; i++) {
    const [id, type] = left[i];
    pool[id] = mkEntry(id, type);
    leftPanels.push(mkPlacement(id, type, String(i + 1), 0));
  }
  const RIGHT_KEYS = ['7', '8', '9'];
  for (let i = 0; i < right.length; i++) {
    const [id, type] = right[i];
    pool[id] = mkEntry(id, type);
    rightPanels.push(mkPlacement(id, type, RIGHT_KEYS[i], 1));
  }
  for (const [id, type] of hidden) pool[id] = mkEntry(id, type);
  return {
    ...layout.init(),
    arrange: {
      detailHeightPct,
      pool,
      columns: [
        { width: leftWidth, panels: leftPanels },
        { panels: rightPanels },
      ],
    },
  };
}

describe('[pool_hide] removes placement, pool entry stays', () => {
  it('hides a left-column panel', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups'], ['files', 'files']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_hide', id: 'files' }, slice);
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
    const next = update({ type: 'pool_hide', id: 'stats' }, slice);
    eq(next.arrange.columns[1].panels.map(p => p.id), ['actions', 'detail']);
    assert(next.dirty);
  });
  it('refuses to hide the LAST detail (layout invariant)', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_hide', id: 'detail' }, slice);
    eq(next, slice, 'no-op: same slice reference returned');
  });
  it('v0.6.4 — hides one of TWO detail panes; refuses the survivor (orphan guard)', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail'], ['detail2', 'detail']],
    });
    eq(mpool.detailPaneCount(slice.arrange), 2, 'precondition: two detail panes');
    // Hiding one is allowed (another viewer remains).
    const afterFirst = update({ type: 'pool_hide', id: 'detail2' }, slice);
    assert(afterFirst !== slice && afterFirst.dirty, 'first detail hidden (slice changed)');
    eq(mpool.detailPaneCount(afterFirst.arrange), 1, 'one detail remains');
    // Now the survivor is the last one → refused.
    const afterSecond = update({ type: 'pool_hide', id: 'detail' }, afterFirst);
    eq(afterSecond, afterFirst, 'no-op: the last viewer can`t be hidden');
  });
  it('v0.6.4 — panelListItems marks detail essential only when it`s the last one', () => {
    const two = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail'], ['detail2', 'detail']],
    });
    const itemsTwo = mpool.panelListItems(two.arrange);
    const d2 = itemsTwo.find(i => i.id === 'detail');
    eq(d2.status, 'placed', 'with two viewers a detail is an ordinary (hideable) placed entry');
    const one = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const d1 = mpool.panelListItems(one.arrange).find(i => i.id === 'detail');
    eq(d1.status, 'essential', 'the sole viewer is essential (unhideable)');
  });
  it('no-op on unknown id', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_hide', id: 'ghost' }, slice);
    eq(next, slice);
  });
  it('no-op on already-hidden id', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = update({ type: 'pool_hide', id: 'notes' }, slice);
    eq(next, slice);
  });
  it('reassigns positional hotkeys after a hide', () => {
    const slice = buildSlice({
      left:  [['containers', 'containers'], ['groups', 'groups'], ['files', 'files']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_hide', id: 'groups' }, slice);
    eq(next.arrange.columns[0].panels.map(p => p.hotkey), ['1', '2']);
    eq(next.arrange.columns[0].panels.map(p => p.id), ['containers', 'files']);
  });
});

describe('[pool_show] inserts placement from pool entry', () => {
  it('shows a hidden pool entry appended at the right column tail (v0.6.4 — no detail clamp)', () => {
    // v0.6.4: detail is an ordinary pane, so pool_show appends at the
    // tail (the old "insert before detail" clamp is gone).
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = update({ type: 'pool_show', id: 'notes' }, slice);
    eq(mpool.placedIds(next.arrange), ['groups', 'actions', 'detail', 'notes']);
    eq(mpool.hiddenIds(next.arrange), []);
    assert(next.dirty);
  });
  it("columnIndex: 0 places into the first column (append at tail)", () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['logs', 'tail']],
    });
    const next = update({ type: 'pool_show', id: 'logs', columnIndex: 0 }, slice);
    eq(next.arrange.columns[0].panels.map(p => p.id), ['groups', 'logs']);
    eq(next.arrange.columns[1].panels.map(p => p.id), ['actions', 'detail']);
  });
  it('right column: hotkey rekey preserves actions=0 / detail=o anchors (R2.5)', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const next = update({ type: 'pool_show', id: 'notes' }, slice);
    // Last column rekey runs through mfc.reassignHotkeys so actions keeps
    // its '0' anchor and detail keeps its 'o' anchor. v0.6.4: notes is now
    // appended AFTER detail (no detail-at-end clamp) and takes the next
    // positional pool slot.
    eq(next.arrange.columns[1].panels.map(p => [p.id, p.hotkey]),
       [['actions', '0'], ['detail', 'o'], ['notes', '9']]);
  });
  it('no-op when already placed', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_show', id: 'groups' }, slice);
    eq(next, slice);
  });
  it('no-op on unknown id', () => {
    const slice = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const next = update({ type: 'pool_show', id: 'ghost' }, slice);
    eq(next, slice);
  });
  it('places a second detail panel (v0.6.4 multi-viewer — no longer refused)', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['detail2', 'detail']],
    });
    const next = update({ type: 'pool_show', id: 'detail2' }, slice);
    assert(next !== slice && next.dirty, 'placed (slice changed + dirty)');
    assert(mpool.placedIds(next.arrange).includes('detail2'), 'detail2 is now placed');
    eq(mpool.detailPaneCount(next.arrange), 2, 'two detail panes now placed');
  });
  it('refuses to place a second actions panel', () => {
    const slice = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['extraActions', 'actions']],
    });
    const next = update({ type: 'pool_show', id: 'extraActions' }, slice);
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
    const next = update({ type: 'pool_show', id: 'g', columnIndex: 0 }, slice);
    eq(next.arrange.columns[0].panels.length, 7, 'soft cap exceeded: 7th panel placed');
    eq(next.arrange.columns[0].panels[6].id, 'g', 'g appended');
  });
});

describe('[hide + show round-trip]', () => {
  it('hide then show restores layout state (hotkey may differ)', () => {
    const slice = buildSlice({
      left:  [['containers', 'containers'], ['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const hidden = update({ type: 'pool_hide', id: 'groups' }, slice);
    eq(mpool.placedIds(hidden.arrange), ['containers', 'actions', 'detail']);
    eq(mpool.hiddenIds(hidden.arrange), ['groups']);
    const shown = update({ type: 'pool_show', id: 'groups', columnIndex: 0 }, hidden);
    eq(mpool.placedIds(shown.arrange).sort(), ['actions', 'containers', 'detail', 'groups']);
    eq(mpool.hiddenIds(shown.arrange), []);
  });
});

report();
