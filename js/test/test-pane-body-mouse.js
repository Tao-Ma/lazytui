'use strict';

/**
 * Pane bodies on the hit map (docs/mouse-hit-map.md Release 3, step 3).
 *
 *   [1] gating at paint — bodies + the empty-screen region publish only when no
 *       chain mode is active (the T13 gate, expressed at paint); agentMode
 *       publishes the body WHEEL only; a popup's backdrop covers the rest.
 *   [2] the empty screen — a right-click on the footer row opens the general
 *       context menu (the pre-R3 null-context menu).
 *   [3] an errored pane keeps its body (a click still focuses it); a pane kind
 *       with no renderer publishes one too.
 *   [4] pointer capture through raw SGR — a text-select drag that crosses
 *       another pane stays with the pane it started in; a press while the drag
 *       is held (a lost release) drops it.
 *   [5] hover — over a popup the graph hover clears (no handler → hover-out).
 */

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const hm = require('../panel/hit-map');
const input = require('../dispatch/control/input');
const capture = require('../dispatch/control/pointer-capture');
const geo = require('../leaves/wm/geometry');
const loop = require('../dispatch/runtime/loop');
const { getModel } = require('../app/runtime');
const api = sm.api;

const toLayout = (msg) => sm.capture(() => loop.dispatchMsg(api.wrap('layout', msg)));
const layout = () => api.getInstanceSlice('layout');
const bodies = () => hm.all().filter(r => r.z === hm.BANDS.BODY);
const screen = () => hm.all().find(r => r.owner === 'screen') || null;
const sgr = (btn, mx, my, up) => `\x1b[<${btn};${mx + 1};${my + 1}${up ? 'm' : 'M'}`;
const tok = (s) => sm.capture(() => input._dispatchToken(s));

function boot() {
  sm.bootFresh();
  toLayout({ type: 'view_set', mode: 'normal' });
  sm.resize(120, 30);
  hc.paint();
}

describe('[1] gating at paint', () => {
  it('normal mode: one body per visible pane with every body gesture; the empty-screen region', () => {
    boot();
    const bs = bodies();
    assert(bs.length >= 2, `bodies published (${bs.length})`);
    for (const b of bs) {
      eq(Object.keys(b.on).sort(), ['double', 'middle', 'press', 'right', 'wheel-down', 'wheel-up'].sort(), `${b.paneId} gestures`);
      eq(b.on.press, { act: 'pane-press', paneId: b.paneId });
      eq(b.owner, hm.paneOwner(b.paneId));
    }
    const s = screen();
    assert(s && s.z === hm.BANDS.SCREEN, 'the screen region sits below every body');
    eq(Object.keys(s.on).sort(), ['double', 'middle', 'right'], 'the screen carries only button gestures');
  });
  it('an in-grid chain mode (filter): no bodies, no screen — a body click does nothing', () => {
    boot();
    toLayout({ type: 'focus_set', focus: 'pane-groups' });
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'filterMode' }));
    hc.paint();
    eq(bodies().length, 0); eq(screen(), null);
    const b = geo.visibleBoundsFor(layout(), 'pane-detail');
    hc.click(b.x + 3, b.y + 3);
    eq(layout().focus, 'pane-groups', 'focus unchanged');
    sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'filterMode' }));
  });
  it('agentMode: bodies publish the wheel only (the transcript scrolls under the input), no clicks', () => {
    boot();
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'agentMode' }));
    hc.paint();
    const bs = bodies();
    assert(bs.length >= 2, 'bodies published');
    for (const b of bs) eq(Object.keys(b.on).sort(), ['wheel-down', 'wheel-up'], `${b.paneId}: wheel only`);
    eq(screen(), null, 'no empty-screen menu under agentMode');
    sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'agentMode' }));
  });
  it('a popup (confirm): bodies are not published; its backdrop owns the screen', () => {
    boot();
    sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Really?', cmd: null }));
    hc.paint();
    eq(bodies().length, 0);
    sm.capture(() => sm.applyMsg({ type: 'confirm_exit' }));
  });
});

describe('[2] the empty screen', () => {
  it('a right-click on the footer row opens the general context menu', () => {
    boot();
    const rows = 30;
    eq(getModel().modes.menuOpen, false);
    hc.click(60, rows - 1, 2);
    eq(getModel().modes.menuOpen, true, 'the context menu opened');
    sm.capture(() => sm.applyMsg({ type: 'menu_close' }));
  });
});

describe('[3] errored / renderer-less panes keep their body', () => {
  it('a pane whose render throws paints an error block, and a click on it still focuses it', () => {
    boot();
    toLayout({ type: 'focus_set', focus: 'pane-detail' });
    const comp = api.getComponent(api.getComponentOwningPanel('groups'));
    const def = comp.panelTypes.groups;
    const real = def.render;
    const err = console.error;
    def.render = () => { throw new Error('boom'); };
    console.error = () => {};
    try {
      hc.paint();
      const b = bodies().find(r => r.paneId === 'pane-groups');
      assert(b, 'the errored pane still publishes its body');
      eq(hm.all().filter(r => r.paneId === 'pane-groups' && r.z === hm.BANDS.CHROME).length, 0, 'but no chrome (the error block drew none)');
      hc.click(b.rect.x + 2, b.rect.y + 2);
      eq(layout().focus, 'pane-groups', 'the click focused it');
    } finally { def.render = real; console.error = err; }
  });
});

describe('[4] pointer capture (raw SGR)', () => {
  // groups lists rows (selectable content); detail is the other pane.
  function pressOnGroups() {
    boot();
    const g = geo.visibleBoundsFor(layout(), 'pane-groups');
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    input._classifyPress(0, 250, 90, Date.now());
    tok(sgr(0, g.x + 2, g.y + 1));                 // press on groups content (row 0)
    const held = capture.held();
    assert(held && held.name === 'text-select', `a text-select capture is held (${JSON.stringify(held)})`);
    eq(held && held.owner, hm.paneOwner('pane-groups'));
    return { g, d };
  }
  it('a text-select drag crossing into another pane extends in the pane it started in', () => {
    const { g, d } = pressOnGroups();
    const psel = require('../panel/select-view');
    tok(sgr(32, d.x + 4, d.y + 2));                // motion over the detail pane
    assert(psel.selectionFor('pane-groups'), 'the selection lives in groups');
    assert(!psel.selectionFor('pane-detail'), 'detail got none');
    tok(sgr(0, d.x + 4, d.y + 2, true));           // release
    eq(capture.held(), null, 'release ended the capture');
    void g;
  });
  it('a press while the drag is held (lost release) drops it and routes the press', () => {
    const { d } = pressOnGroups();
    input._classifyPress(0, 250, 90, Date.now());
    tok(sgr(0, d.x + 4, d.y + 3));                 // the release never came; a new press on detail
    eq(layout().focus, 'pane-detail', 'the press routed normally');
    const h = capture.held();
    assert(!h || h.owner === hm.paneOwner('pane-detail'), 'the groups drag is gone');
    capture._reset();
  });
});

describe('[5] hover', () => {
  it('a live graph hover clears once a popup covers the graph (no hover handler → hover-out)', () => {
    const paneCfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' } };
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { g: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    sm.resize(120, 30);
    getModel().metrics = { 'gh.cpu': { series: { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) },
                                       schema: { columns: { cpu: { type: 'percent' } } } } };
    hc.paint();
    const body = bodies()[0];
    assert(body && body.on.hover, 'the stats body publishes a hover handler');
    const mx = body.rect.x + 40, my = body.rect.y + 10;
    sm.capture(() => input.handleMouse('hover', mx + 1, my + 1));
    assert(layout().hover && layout().hover.paneId === body.paneId, 'hover set over the graph');
    sm.capture(() => sm.applyMsg({ type: 'confirm_enter', message: 'Really?', cmd: null }));
    hc.paint();
    sm.capture(() => input.handleMouse('hover', mx + 2, my + 1));
    eq(layout().hover, null, 'cleared under the popup');
    sm.capture(() => sm.applyMsg({ type: 'confirm_exit' }));
  });
});

report();
