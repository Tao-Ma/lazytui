/**
 * Phase 4 — panel-list overlay state machine.
 *
 * Pins the slice transitions (open / close / nav / pick) and the
 * panelListItems derivation. Render-side is the thin `js/overlay/
 * panel-list.js` module — tested indirectly via the items derivation.
 *
 *   node js/test/test-panel-list-overlay.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');
const mpool = require('../leaves/wm/pool');

function buildSlice({ left = [], right = [], hidden = [] } = {}) {
  const pool = {};
  const mkEntry = (id, type) => ({ id, type, title: id, config: {} });
  const mkPlacement = (id, type, hotkey, columnIndex) => ({
    id, type, title: id, hotkey, columnIndex,
  });
  const leftPanels  = [];
  const rightPanels = [];
  for (let i = 0; i < left.length; i++) {
    const [id, type] = left[i];
    pool[id] = mkEntry(id, type);
    leftPanels.push(mkPlacement(id, type, String(i + 1), 0));
  }
  for (let i = 0; i < right.length; i++) {
    const [id, type] = right[i];
    pool[id] = mkEntry(id, type);
    rightPanels.push(mkPlacement(id, type, ['7','8','9'][i], 1));
  }
  for (const [id, type] of hidden) pool[id] = mkEntry(id, type);
  return {
    ...layout.init(),
    arrange: {
      detailHeightPct: 60,
      pool,
      columns: [
        { width: 30, panels: leftPanels },
        { panels: rightPanels },
      ],
    },
  };
}

describe('[panelListItems] order + status markers', () => {
  it('placed first (left then right), hidden after, detail flagged essential', () => {
    const arrange = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer'], ['stats', 'stats']],
    }).arrange;
    const items = mpool.panelListItems(arrange);
    eq(items.map(it => it.id), ['groups', 'actions', 'detail', 'notes', 'stats']);
    eq(items.map(it => it.status), ['placed', 'placed', 'essential', 'hidden', 'hidden']);
  });
});

describe('[panel_list_open / close] simple toggles', () => {
  it('open sets open=true, cursor=0', () => {
    const s = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const [next, cmds] = layout.update({ type: 'panel_list_open' }, s);
    eq(next.panelList.open, true);
    eq(next.panelList.cursor, 0);
    // Overlay-compositor Release 2 Phase 2.a #6: the overlay composites
    // into newRows, so cell-diff handles the open transition from the
    // natural row delta — the pre-migration `force_full_repaint` Cmd is
    // retired. applyMsg's depth-0 trailing paint (Release 1) still fires.
    eq(cmds.length, 0, 'no per-arm paint Cmd — compositor path');
  });
  it('close sets open=false (cursor preserved), no per-arm force Cmd', () => {
    const s = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const [opened] = layout.update({ type: 'panel_list_open', cursor: 2 }, s);
    const [closed, cmds] = layout.update({ type: 'panel_list_close' }, opened);
    eq(closed.panelList.open, false);
    eq(closed.panelList.cursor, 2);
    // Mirror of the open case — compositor path, cell-diff handles the
    // vacated overlay rect from the natural row delta.
    eq(cmds.length, 0, 'no per-arm paint Cmd — compositor path');
  });
});

describe('[panel_list_nav] cursor moves, clamped to item range', () => {
  function shape() {
    const s = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const [next] = layout.update({ type: 'panel_list_open' }, s);
    return next;
  }
  it('+1 advances cursor', () => {
    const next = layout.update({ type: 'panel_list_nav', dir: +1 }, shape());
    eq(next.panelList.cursor, 1);
  });
  it('-1 at top clamps to 0', () => {
    const next = layout.update({ type: 'panel_list_nav', dir: -1 }, shape());
    eq(next.panelList.cursor, 0);
  });
  it('+1 past last item clamps to last', () => {
    let s = shape();
    for (let i = 0; i < 20; i++) s = layout.update({ type: 'panel_list_nav', dir: +1 }, s);
    // 4 items total: groups, actions, detail, notes.
    eq(s.panelList.cursor, 3);
  });
});

describe('[panel_list_pick] context-dependent: hide / show / no-op', () => {
  function setupCursor(spec, cursorIdx) {
    const s = buildSlice(spec);
    let [opened] = layout.update({ type: 'panel_list_open' }, s);
    for (let i = 0; i < cursorIdx; i++) opened = layout.update({ type: 'panel_list_nav', dir: +1 }, opened);
    return opened;
  }
  it('pick on a placed item returns a pool_hide dispatch_msg Cmd, closes', () => {
    // groups @ cursor 0
    const s = setupCursor({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    }, 0);
    const result = layout.update({ type: 'panel_list_pick' }, s);
    assert(Array.isArray(result), 'returns [slice, cmds] tuple');
    const [next, cmds] = result;
    eq(next.panelList.open, false, 'overlay closes on pick');
    // Overlay-compositor Release 2 Phase 2.a #6: close rides on cell-diff
    // via the compositor path; the former trailing `force_full_repaint`
    // Cmd is retired. Only the pool_hide re-dispatch remains.
    eq(cmds.length, 1, 'dispatch_msg only — no per-arm paint Cmd');
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.kind, 'layout');
    eq(cmds[0].msg.msg.type, 'pool_hide');
    eq(cmds[0].msg.msg.id, 'groups');
  });
  it('pick on a hidden item returns a pool_show dispatch_msg Cmd', () => {
    // After 3 nav steps: cursor on 'notes' (groups,actions,detail,notes)
    const s = setupCursor({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    }, 3);
    const [next, cmds] = layout.update({ type: 'panel_list_pick' }, s);
    eq(next.panelList.open, false);
    eq(cmds.length, 1, 'dispatch_msg only — no per-arm paint Cmd');
    eq(cmds[0].msg.msg.type, 'pool_show');
    eq(cmds[0].msg.msg.id, 'notes');
  });
  it('pick on detail (essential) is a no-op — slice unchanged, overlay stays open', () => {
    // detail @ cursor 2: groups, actions, detail
    const s = setupCursor({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    }, 2);
    const result = layout.update({ type: 'panel_list_pick' }, s);
    assert(!Array.isArray(result), 'returns plain slice (no Cmds)');
    eq(result, s, 'identity: same slice');
  });
});

describe('[free_config_enter] auto-opens overlay when hidden entries exist', () => {
  it('opens when pool has hidden entries', () => {
    const s = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const [next] = layout.update({ type: 'free_config_enter' }, s);
    eq(next.panelList.open, true);
  });
  it('stays closed when every pool entry is placed', () => {
    const s = buildSlice({
      left:  [['groups', 'groups']],
      right: [['actions', 'actions'], ['detail', 'detail']],
    });
    const [next] = layout.update({ type: 'free_config_enter' }, s);
    eq(next.panelList.open, false);
  });
});

describe('[free_config_exit] closes overlay', () => {
  it('overlay closes on exit', () => {
    const s = buildSlice({
      left:   [['groups', 'groups']],
      right:  [['actions', 'actions'], ['detail', 'detail']],
      hidden: [['notes', 'viewer']],
    });
    const [opened] = layout.update({ type: 'free_config_enter' }, s);
    eq(opened.panelList.open, true);
    const [exited] = layout.update({ type: 'free_config_exit' }, opened);
    eq(exited.panelList.open, false);
  });
});

report();
