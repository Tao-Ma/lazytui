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
    eq(sm.getModel ? sm.getModel().modes.menuOpen : require('../app/runtime').getModel().modes.menuOpen, false, 'a right-click opened no menu');
    const before = layout();
    sm.capture(() => input.handleMouse('hover', d.x + 4, d.y + 4));
    assert(layout() === before, 'hover wrote nothing into the frozen app');
    eq(SEEKS, [], 'no seek');
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
