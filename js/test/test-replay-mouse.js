'use strict';

/**
 * The replay owner on the hit map (docs/mouse-hit-map.md Release 3, step 5) —
 * a real paint with an INJECTED replay source (the seams tui.js wires: paint's
 * setReplaySource, the scrubber's setDataSource, hit-map's setReplayView), raw
 * SGR through input._dispatchToken.
 *
 *   [1] replay owns the mouse: a full-screen region above every overlay band;
 *       a click on a pane, a wheel and a hover change nothing in the frozen app.
 *   [2] mini view: a press on a seek cell seeks to its fraction.
 *   [3] hidden view: still owned — no seek cells, every click swallowed.
 *   [4] stale frame: a batched key that starts replay + a click → the click
 *       never reaches the (now reconstructed) app.
 */

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const hm = require('../panel/hit-map');
const input = require('../dispatch/control/input');
const paint = require('../render/paint');
const ov = require('../overlay/replay-scrubber');
const rc = require('../dispatch/runtime/replay-control');
const geo = require('../leaves/wm/geometry');
const loop = require('../dispatch/runtime/loop');
const api = sm.api;

const toLayout = (msg) => sm.capture(() => loop.dispatchMsg(api.wrap('layout', msg)));
const layout = () => api.getInstanceSlice('layout');
const sgr = (btn, mx, my) => `\x1b[<${btn};${mx + 1};${my + 1}M`;
const tok = (s) => { input._classifyPress(0, 250, 90, Date.now()); sm.capture(() => input._dispatchToken(s)); };

let DATA = null;   // the fake replay controller's renderData (null = not replaying)
const SEEKS = [];
function inject() {
  paint.setReplaySource(() => DATA);
  ov.setDataSource(() => DATA);
  hm.setReplayView(() => (DATA ? DATA.paneView : null));
  rc._realSeek = rc._realSeek || rc.seekToFraction;
  rc.seekToFraction = (f) => SEEKS.push(f);
}
function restore() {
  DATA = null;
  paint.setReplaySource(null); ov.setDataSource(null); hm.setReplayView(null);
  if (rc._realSeek) { rc.seekToFraction = rc._realSeek; delete rc._realSeek; }
}
const replaying = (paneView) => ({ paneView, diffMode: 'off', checkpoints: [{ seq: 1, t: 0, idx: 0 }], cursor: 0, idx: 5, pos: 5,
  total: 20, t: 1000, firstT: 1000, lastT: 2000, playing: null, ratio: 1, mode: 'realtime', idleCap: 1000 });

function boot(paneView) {
  sm.bootFresh();
  toLayout({ type: 'view_set', mode: 'normal' });
  toLayout({ type: 'focus_set', focus: 'pane-groups' });
  sm.resize(120, 30);
  inject();
  DATA = paneView ? replaying(paneView) : null;
  SEEKS.length = 0;
  hc.paint();
}

describe('[1] replay owns the mouse', () => {
  it('a full-screen owner region above every overlay band; pane clicks / wheel / hover change nothing', () => {
    boot('mini');
    const owner = hm.all().find(r => r.owner === 'replay-scrubber' && r.id === 'owner');
    assert(owner && owner.z === hm.BANDS.REPLAY, 'the owner region at BANDS.REPLAY');
    eq(owner.rect, { x: 0, y: 0, w: 120, h: 30 });
    const rest = hm.all().filter(r => r.owner !== 'replay-scrubber');
    const top = Math.max(...rest.map(r => r.z));
    assert(owner.z > top, `above everything else in the frame (top ${top})`);
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, d.x + 3, d.y + 3));
    eq(layout().focus, 'pane-groups', 'a pane click did not focus');
    tok(sgr(2, d.x + 3, d.y + 3));
    eq(require('../app/runtime').getModel().modes.menuOpen, false, 'a right-click opened no menu');
    const g = geo.visibleBoundsFor(layout(), 'pane-groups');
    const navBefore = JSON.stringify(api.getInstanceSlice('pane-groups').nav);
    sm.capture(() => input._dispatchToken(sgr(65, g.x + 3, g.y + 2)));   // wheel-down over groups
    eq(JSON.stringify(api.getInstanceSlice('pane-groups').nav), navBefore, 'the wheel moved nothing');
    eq(SEEKS, [], 'no seek');
    restore();
  });
  it('hover over replay is a TRUE no-op — a live graph value is neither updated nor cleared (hover-out would clear it)', () => {
    const paneCfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { g: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    sm.resize(120, 30);
    require('../app/runtime').getModel().metrics = { 'gh.cpu': { series: { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) },
                                                                schema: { columns: { cpu: { type: 'percent' } } } } };
    inject();
    DATA = null;
    hc.paint();
    const body = hm.all().find(r => r.z === hm.BANDS.BODY);
    const mx = body.rect.x + 40, my = body.rect.y + 10;
    sm.capture(() => input.handleMouse('hover', mx + 1, my + 1));
    const live = layout().hover;
    assert(live && live.paneId === body.paneId, 'a graph hover is live before replay');
    DATA = replaying('mini');
    hc.paint();
    sm.capture(() => input.handleMouse('hover', mx + 3, my + 2));   // another graph cell, under the replay owner
    assert(layout().hover === live, 'hover untouched (neither moved to the new cell nor cleared)');
    restore();
  });
});

describe('[2] mini view seek cells', () => {
  it('a press on a seek cell seeks to its fraction', () => {
    boot('mini');
    const cells = hm.all().filter(r => r.owner === 'replay-scrubber' && r.id.startsWith('seek:'));
    assert(cells.length >= 2, `seek cells published (${cells.length})`);
    const last = cells[cells.length - 1];
    tok(sgr(0, cells[0].rect.x, cells[0].rect.y));
    tok(sgr(0, last.rect.x, last.rect.y));
    eq(SEEKS, [0, 1]);
    restore();
  });
});

describe('[2b] replay frames are current while the replay view holds', () => {
  it('the reconstructed model moving under an unchanged replay view (playback, Lock — repaints debounced or skipped) does not stale the seek cells', () => {
    boot('mini');
    const cells = hm.all().filter(r => r.owner === 'replay-scrubber' && r.id.startsWith('seek:'));
    // The reconstructed model moves without a repaint: a popup opens in it.
    sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Really?', cmd: null }));
    tok(sgr(0, cells[0].rect.x, cells[0].rect.y));
    eq(SEEKS, [0], 'the seek still lands (pre-review: swallowed as a stale frame)');
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, d.x + 3, d.y + 3));
    eq(require('../app/runtime').getModel().modes.confirmMode, true, 'everything else is still swallowed (the confirm is untouched)');
    sm.capture(() => sm.applyMsg({ type: 'confirm_reject' }));
    restore();
  });
});

describe('[2c] a capture that sees the replay view change (the swap backstop, round-2 review)', () => {
  it('is dropped WITHOUT its cancel (nothing written into the replayed model); the first press seeks', () => {
    // A free-config layout drag whose release was lost, then the replay view
    // appears WITHOUT replay-control's enter (which ends a held capture first —
    // [2d]): its cancel would write into the model now present. (The injected
    // replay leaves the live model in place, so "the replayed model" here is
    // the one whose drag must stay untouched.)
    const capture = require('../dispatch/control/pointer-capture');
    sm.bootFresh();
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    toLayout({ type: 'free_config_enter' });
    if (layout().panelList && layout().panelList.open) toLayout({ type: 'panel_list_close' });
    inject();
    DATA = null;
    SEEKS.length = 0;
    hc.paint();
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, d.x + 5, d.y + 5));                  // starts the free-config capture
    assert(capture.held() && capture.held().name === 'free-config', 'free-config capture held');
    const dragBefore = JSON.stringify(layout().freeConfig.drag);
    DATA = replaying('mini');                        // replay starts; the release never came
    hc.paint();
    const cell = hm.all().find(r => r.owner === 'replay-scrubber' && r.id === 'seek:0');
    tok(sgr(0, cell.rect.x, cell.rect.y));
    eq(capture.held(), null, 'the leftover capture is gone');
    eq(JSON.stringify(layout().freeConfig.drag), dragBefore, 'its cancel did not run (no release dispatched)');
    eq(SEEKS, [0], 'the press seeked (not swallowed by the leftover drag)');
    restore();
    toLayout({ type: 'free_config_exit' });
  });
});

describe('[2d] the REAL :record-load round trip with a drag left over (round-3 review)', () => {
  it('replay enter ends the drag BEFORE the live snapshot: exit restores no zoom band', () => {
    const capture = require('../dispatch/control/pointer-capture');
    const sessionLog = require('../io/session-log');
    const mpool = require('../leaves/wm/pool');
    const stats = require('../panel/monitor/stats');
    if (!api.getComponent(stats.name)) { try { api.registerComponent(stats); } catch (_) { /* registered */ } }
    capture._reset();
    const cfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'z.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' } };
    const det = { id: 'd', type: 'detail', title: 'Out' };
    sm.bootFresh({ groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { g: cfg, d: det }, columns: [{ width: 80, panels: [cfg] }, { panels: [det] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    require('../app/runtime').getModel().metrics = { 'z.cpu': { series: { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, schema: { columns: { cpu: { type: 'percent' } } } } };
    // A tiny recorded session to load.
    const wal = require('path').join(require('os').tmpdir(), `lazytui-replay-mouse-${process.pid}.jsonl`);
    sessionLog.enable(true); sessionLog.clear();
    sm.capture(() => { for (let i = 1; i <= 3; i++) loop.applyMsg({ type: 'clock_tick', now: i * 1000 }); });
    sessionLog.save(wal);
    sessionLog.enable(false); sessionLog.clear();
    try {
      hc.paint();
      const p = mpool.allPanesInColumns(layout().arrange).find((x) => x.type === 'stats');
      const b = geo.visibleBoundsFor(layout(), p.paneId);
      tok(sgr(0, b.x + 10, b.y + 5));                              // press on the graph → graph-zoom
      sm.capture(() => input._dispatchToken(sgr(32, b.x + 30, b.y + 5)));   // drag → band
      assert(layout().dragBand, 'the zoom band is painted');
      eq(capture.held() && capture.held().name, 'graph-zoom');
      // The release is lost; the user runs :record-load.
      sm.capture(() => rc.enter(wal));
      assert(rc.active(), 'replay is active');
      eq(capture.held(), null, 'the drag ended at replay enter');
      sm.capture(() => rc.exit());
      eq(rc.active(), false);
      eq(layout().dragBand, null, 'the restored live session holds no band (it was taken down before the snapshot)');
    } finally {
      if (rc.active()) sm.capture(() => rc.exit());
      try { require('fs').unlinkSync(wal); } catch (_) { /* gone */ }
    }
  });
});

describe('[3] hidden view', () => {
  it('still owned: no seek cells, every click swallowed', () => {
    boot('hidden');
    assert(hm.all().some(r => r.owner === 'replay-scrubber' && r.id === 'owner'), 'owner region published');
    eq(hm.all().filter(r => r.id.startsWith('seek:')).length, 0);
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    tok(sgr(0, d.x + 3, d.y + 3));
    eq(layout().focus, 'pane-groups');
    restore();
  });
});

describe('[4] stale frame', () => {
  it('replay starting between paint and click: the click never reaches the app', () => {
    boot(null);   // a normal frame, not replaying
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    DATA = replaying('mini');   // replay started (e.g. a batched key) — no repaint yet
    tok(sgr(0, d.x + 3, d.y + 3));
    eq(layout().focus, 'pane-groups', 'stale (the stamp records the replay view) → swallowed');
    restore();
  });
});

report();
