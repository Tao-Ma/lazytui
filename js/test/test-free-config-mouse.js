'use strict';

/**
 * Free-config mouse on the hit map + pointer capture (docs/mouse-hit-map.md
 * Release 3, step 4) — raw SGR through input._dispatchToken after a real paint.
 *
 *   [1] panel list: a non-essential row press starts a pool drag for THAT item
 *       (cursor moves to it); motion drags; release drops. The header, an
 *       essential row and the preview start nothing — adjacent finding 1 (a
 *       header press used to drag the highlighted item).
 *   [2] outside the list: a press closes the list and starts the layout drag;
 *       a right-click does neither; chrome above the backdrop stays live.
 *   [3] pool drag: a press while the drag is held is swallowed.
 */

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const hm = require('../panel/hit-map');
const input = require('../dispatch/control/input');
const capture = require('../dispatch/control/pointer-capture');
const loop = require('../dispatch/runtime/loop');
const mpool = require('../leaves/wm/pool');
const { getModel } = require('../app/runtime');
const api = sm.api;

const toLayout = (msg) => sm.capture(() => loop.dispatchMsg(api.wrap('layout', msg)));
const layout = () => api.getInstanceSlice('layout');
const drag = () => (layout().freeConfig && layout().freeConfig.drag) || null;
const sgr = (btn, mx, my, up) => `\x1b[<${btn};${mx + 1};${my + 1}${up ? 'm' : 'M'}`;
const tok = (s) => { input._classifyPress(0, 250, 90, Date.now()); sm.capture(() => input._dispatchToken(s)); };
const mtok = (s) => sm.capture(() => input._dispatchToken(s));   // motion / release: no double-click reset needed

const P3 = { g1: { id: 'g1', type: 'groups', title: 'G1' }, g2: { id: 'g2', type: 'groups', title: 'G2' },
             g3: { id: 'g3', type: 'groups', title: 'G3' }, detail: { id: 'detail', type: 'detail', title: 'Detail' } };

function boot({ openList = true } = {}) {
  capture._reset();
  sm.bootFresh({ layout: { pool: P3, columns: [{ width: 70, panels: [P3.g1, P3.g2, P3.g3] }, { panels: [P3.detail] }] } });
  toLayout({ type: 'view_set', mode: 'normal' });
  sm.resize(120, 30);
  toLayout({ type: 'free_config_enter' });
  if (openList && !(layout().panelList && layout().panelList.open)) toLayout({ type: 'panel_list_open', cursor: 0 });
  if (!openList && layout().panelList && layout().panelList.open) toLayout({ type: 'panel_list_close' });
  hc.paint();
}
const rowsOf = () => hm.all().filter(r => r.owner === 'panel-list' && r.id.startsWith('row:'));
const box = () => hm.all().find(r => r.owner === 'panel-list' && r.id === 'box');
const items = () => mpool.panelListItems(layout().arrange);
const done = () => { capture._reset(); toLayout({ type: 'free_config_exit' }); };

describe('[1] panel list rows', () => {
  it('only non-essential item rows publish a drag source, over the list column only', () => {
    boot();
    const its = items();
    const rs = rowsOf();
    eq(rs.length, its.filter(i => i.status !== 'essential').length, 'one row per draggable item');
    const b = box().rect;
    for (const r of rs) assert(r.rect.x + r.rect.w <= b.x + 1 + 36, `${r.id} stays in the list column`);
    for (const r of rs) eq(Object.keys(r.on), ['press']);
    done();
  });
  it('a press on the header drags nothing (adjacent finding 1)', () => {
    boot();
    toLayout({ type: 'panel_list_open', cursor: items().findIndex(i => i.status !== 'essential') });
    hc.paint();
    const b = box().rect;
    tok(sgr(0, b.x + 3, b.y + 1));
    eq(drag(), null, 'no pool drag armed');
    eq(capture.held(), null);
    mtok(sgr(32, 60, 3));
    eq(drag(), null, 'motion after it drags nothing');
    done();
  });
  it('a press on the preview or an essential row drags nothing', () => {
    boot();
    const b = box().rect;
    tok(sgr(0, b.x + b.w - 5, b.y + 3));   // preview side
    eq(drag(), null, 'preview: nothing');
    const ess = items().findIndex(i => i.status === 'essential');
    assert(ess >= 0, 'the fixture has an essential item');
    tok(sgr(0, b.x + 3, b.y + 2 + ess));   // its row (header is row 0 of the box interior)
    eq(drag(), null, 'essential row: nothing');
    done();
  });
  it('a press on a row drags THAT item: cursor moves to it, motion drags, release drops', () => {
    boot();
    const rs = rowsOf();
    const r = rs[1];   // the second draggable row
    const idx = r.on.press.idx;
    tok(sgr(0, r.rect.x + 3, r.rect.y));
    eq(layout().panelList.cursor, idx, 'the cursor moved to the pressed row');
    eq(drag() && drag().kind, 'pool-armed');
    eq(capture.held() && capture.held().name, 'pool-drag');
    for (const [x, y] of [[60, 3], [100, 4], [110, 5]]) mtok(sgr(32, x, y));
    eq(drag() && drag().kind, 'pool-dragging', 'motion dragged it');
    mtok(sgr(0, 110, 5, true));
    eq(drag(), null, 'release dropped it');
    eq(capture.held(), null);
    done();
  });
});

describe('[2] outside the list', () => {
  it('a press on a pane closes the list and starts the layout drag on it', () => {
    boot();
    const g = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, g.x + g.w - 4, g.y + g.h - 2));
    eq(!!(layout().panelList && layout().panelList.open), false, 'the list closed');
    eq(layout().focus, 'pane-detail', 'the press focused the pane under it (free_config_mouse_press)');
    assert(capture.held() && capture.held().name === 'free-config', 'the free-config capture is held');
    mtok(sgr(0, g.x + g.w - 4, g.y + g.h - 2, true));
    eq(drag(), null, 'release ended the drag');
    done();
  });
  it('a right-click outside the list does nothing (swallowed, as before)', () => {
    boot({ openList: false });
    const before = layout().focus;
    const g = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(2, g.x + 4, g.y + 4));
    eq(layout().focus, before, 'no layout press');
    eq(capture.held(), null);
    eq(getModel().modes.menuOpen, false, 'no context menu in free-config');
    done();
  });
  it('a pane\'s [_] above the backdrop still takes the click', () => {
    boot({ openList: false });
    const c = hm.all().find(r => r.id === 'collapse' && r.z === hm.BANDS.CHROME);
    assert(c, 'chrome is published in free-config');
    const hit = hm.resolve(c.rect.x + 1, c.rect.y, 'press');
    eq(hit && hit.region.id, 'collapse', 'chrome wins over the free-config backdrop');
    done();
  });
});

describe('[2b] a mode change mid-drag', () => {
  it('title-edit entered during a layout drag abandons the capture and ends the drag (nothing left stuck)', () => {
    boot({ openList: false });
    const g = require('../leaves/wm/geometry').visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, g.x + 4, g.y + 4));
    assert(capture.held() && drag(), 'a layout drag is live');
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'freeConfigTitleEditMode' }));
    mtok(sgr(32, g.x + 8, g.y + 6));
    eq(capture.held(), null, 'abandoned');
    eq(drag(), null, 'the drag was released, not left in the slice');
    sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'freeConfigTitleEditMode' }));
    done();
  });
});

describe('[2c] a lost release discards the unreleased drag (round-2 review)', () => {
  it('drag a pane over a valid swap target, the release never comes, press elsewhere → nothing committed', () => {
    boot({ openList: false });
    const geo = require('../leaves/wm/geometry');
    const order = () => require('../leaves/wm/pool').allPanesInColumns(layout().arrange).map(p => p.paneId).join();
    const before = order();
    const g1 = geo.visibleBoundsFor(layout(), 'pane-g1');
    const g3 = geo.visibleBoundsFor(layout(), 'pane-g3');
    tok(sgr(0, g1.x + 5, g1.y + Math.floor(g1.h / 2)));
    mtok(sgr(32, g3.x + 5, g3.y + Math.floor(g3.h / 2)));
    assert(drag(), 'a move drag is live over g3');
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, d.x + 5, d.y + 5));                     // the next press — no release came
    eq(order(), before, 'no swap was committed (the reducer\'s press discards the unreleased drag)');
    done();
  });
});

describe('[3] pool drag holds the mouse', () => {
  it('a press while the pool drag is live is swallowed; the drag continues', () => {
    boot();
    const r = rowsOf()[0];
    tok(sgr(0, r.rect.x + 3, r.rect.y));
    mtok(sgr(32, 60, 3));
    const kind = drag() && drag().kind;
    assert(kind === 'pool-armed' || kind === 'pool-dragging', `pool drag live (${kind})`);
    tok(sgr(0, 100, 10));   // the release never came
    eq(capture.held() && capture.held().name, 'pool-drag', 'still held');
    assert(drag() && /^pool-/.test(drag().kind), 'the drag continues');
    mtok(sgr(0, 100, 10, true));
    eq(drag(), null);
    done();
  });
});

report();
