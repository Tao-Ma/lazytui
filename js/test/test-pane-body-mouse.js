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
const route = () => require('../panel/route');

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
  it('the T13 wheel cases, paint-gated: under filter / a leader chord a wheel over a pane moves nothing', () => {
    for (const setup of [
      () => sm.applyMsg({ type: 'mode_set', flag: 'filterMode' }),
      () => { sm.applyMsg({ type: 'mode_set', flag: 'prefixMode' }); getModel().prefixSeq = ['g']; },
    ]) {
      boot();
      toLayout({ type: 'focus_set', focus: 'pane-detail' });
      const before = JSON.stringify({ sel: api.getInstanceSlice('pane-groups'), focus: layout().focus });
      sm.capture(setup);
      hc.paint();                                   // the frame the user sees under the mode
      const g = geo.visibleBoundsFor(layout(), 'pane-groups');
      eq(bodies().filter(b => b.paneId === 'pane-groups').length, 0, 'no body under the mode');
      sm.capture(() => input._dispatchToken(sgr(65, g.x + 3, g.y + 2)));   // wheel-down
      eq(JSON.stringify({ sel: api.getInstanceSlice('pane-groups'), focus: layout().focus }), before, 'nothing moved');
      sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'filterMode' }));
      sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'prefixMode' }));
      getModel().prefixSeq = [];
    }
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
    sm.capture(() => sm.applyMsg({ type: 'confirm_reject' }));
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
  it('a pane kind with no renderer paints blank but still publishes its body (a click focuses it)', () => {
    boot();
    toLayout({ type: 'focus_set', focus: 'pane-detail' });
    const comp = api.getComponent(api.getComponentOwningPanel('groups'));
    const def = comp.panelTypes.groups;
    const real = def.render;
    delete def.render;
    try {
      hc.paint();
      const b = bodies().find(r => r.paneId === 'pane-groups');
      assert(b, 'the renderer-less pane publishes its body');
      eq(b.rect, geo.visibleBoundsFor(layout(), 'pane-groups'), 'over the pane\'s bounds');
      hc.click(b.rect.x + 2, b.rect.y + 2);
      eq(layout().focus, 'pane-groups', 'the click focused it');
    } finally { def.render = real; }
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

describe('[4b] a capture lives only in the scope it started in', () => {
  for (const [label, open] of [
    ['confirm', () => sm.applyMsg({ type: 'confirm_enter', message: 'Really?', cmd: null })],
    ['the command menu', () => sm.applyMsg({ type: 'menu_open' })],
    ['filter', () => sm.applyMsg({ type: 'mode_set', flag: 'filterMode' })],
  ]) {
    it(`a text-select drag interrupted by ${label}: no selection, no copy behind it; the capture is abandoned`, () => {
      boot();
      const g = geo.visibleBoundsFor(layout(), 'pane-groups');
      const d = geo.visibleBoundsFor(layout(), 'pane-detail');
      const psel = require('../panel/select-view');
      input._classifyPress(0, 250, 90, Date.now());
      tok(sgr(0, g.x + 2, g.y + 1));
      assert(capture.held(), 'drag armed');
      const reg = JSON.stringify(getModel().register);
      sm.capture(open);                              // a key opened a modal mid-drag
      tok(sgr(32, d.x + 4, d.y + 2));
      eq(capture.held(), null, 'abandoned on the first motion');
      assert(!psel.selectionFor('pane-groups'), 'no selection began behind it');
      tok(sgr(0, d.x + 4, d.y + 2, true));
      eq(JSON.stringify(getModel().register), reg, 'the release copied nothing');
      sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'filterMode' }));
      sm.capture(() => sm.applyMsg({ type: 'confirm_reject' }));
      sm.capture(() => sm.applyMsg({ type: 'menu_close' }));
    });
  }
});

describe('[4c] pre-release review — code track', () => {
  const mb = require('../dispatch/control/mouse-bindings');
  const dbl = (mx, my) => { input._classifyPress(0, 250, 90, Date.now()); tok(sgr(0, mx, my)); tok(sgr(0, mx, my)); };
  it('a fast double-click on pane chrome is ONE toggle — the body beneath does not take the 2nd click (default + double-click: context)', () => {
    for (const remap of [null, 'context']) {
      boot();
      if (remap) mb.configure({ 'double-click': remap });
      try {
        toLayout({ type: 'focus_set', focus: 'pane-detail' });
        hc.paint();
        const c = hm.all().find(r => r.id === 'collapse' && r.paneId === 'pane-groups');
        assert(c, 'groups [_] published');
        dbl(c.rect.x + 1, c.rect.y);
        const p = require('../leaves/wm/pool').allPanesInColumns(layout().arrange).find(x => x.paneId === 'pane-groups');
        eq(!!p.collapsed, true, `${remap || 'default'}: collapsed once`);
        eq(layout().focus, 'pane-detail', `${remap || 'default'}: the body's double-click did not fire (no focus move)`);
        eq(getModel().modes.menuOpen, false, `${remap || 'default'}: no context menu`);
      } finally { mb.reset(); }
    }
  });
  it('a press on a list pane\'s bottom border selects no row (it mapped to the row after the last visible one)', () => {
    const groups = {};
    for (let i = 0; i < 40; i++) {
      const id = `g${String(i).padStart(2, '0')}`;
      groups[id] = { label: id, containers: [], actions: { a: { cmd: 'echo', label: 'A' } } };
    }
    sm.bootFresh({ groups });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    hc.paint();
    const g = geo.visibleBoundsFor(layout(), 'pane-groups');
    assert(api.getInstanceSlice('pane-groups').list.length > g.h, 'precondition: the list overflows the pane');
    const before = api.getInstanceSlice('pane-groups').nav.cursor;
    tok(sgr(0, g.x + 3, g.y + g.h - 1));
    eq(api.getInstanceSlice('pane-groups').nav.cursor, before, 'cursor unchanged');
  });
  it('an inert gesture paints nothing (middle-click noop, an off-row double-click)', () => {
    boot();
    const rq = require('../leaves/infra/render-queue');
    const paint = require('../render/paint');
    let n = 0;
    rq.setRenderers({ render: () => { n++; } });
    try {
      const d = geo.visibleBoundsFor(layout(), 'pane-detail');
      tok(sgr(1, d.x + 3, d.y + 3));                // middle → noop
      dbl(60, 29);                                  // footer row: activate on no row
      eq(n, 0, 'no paint');
    } finally { rq.setRenderers({ render: () => paint.render(getModel()) }); }   // paint.js's own registration
  });
});

describe('[4d] pre-release review round 2', () => {
  it('a composite: a press on a widget BELOW the interactive bars selects no row', () => {
    for (const p of ['monitor/stats', 'monitor/gauge', 'monitor/composite']) {
      const c = require(`../panel/${p}`);
      if (!api.getComponent(c.name)) { try { api.registerComponent(c); } catch (_) { /* registered */ } }
    }
    const paneCfg = { id: 'cbox', type: 'composite', title: 'CPU', config: { widgets: [
      { type: 'bars', topic: 'ci.core', column: 'busy', label: 'core', interactive: true, height: 4 },
      { type: 'graph', topic: 'ci.cpu', row: '_', metrics: ['cpu'] },
    ] } };
    sm.bootFresh({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { cbox: paneCfg }, columns: [{ panels: [paneCfg] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    const series = {};
    for (let i = 0; i < 40; i++) series['c' + String(i).padStart(2, '0')] = [{ busy: 100 - i, core: 'cpu' + i }];
    getModel().metrics = { 'ci.core': { series, schema: { columns: { busy: { type: 'percent' }, core: { type: 'string' } } } },
      'ci.cpu': { series: { _: [{ cpu: 20 }, { cpu: 40 }, { cpu: 60 }] }, schema: { columns: { cpu: { type: 'percent' } } } } };
    hc.paint();
    const paneId = bodies()[0].paneId;
    const b = geo.visibleBoundsFor(layout(), paneId);
    const nav = require('../panel/nav-state');
    const before = nav.getSel(paneId);
    tok(sgr(0, b.x + 5, b.y + b.h - 4));          // a row of the graph widget near the bottom
    tok(sgr(0, b.x + 5, b.y + b.h - 4, true));
    eq(nav.getSel(paneId), before, 'cursor unchanged (it jumped to a bar row drawn nowhere)');
  });
  it('a text-select drag whose pane switches tabs mid-drag goes inert — nothing from the other tab is copied', () => {
    boot();
    route().eachInstance((inst) => {
      if (inst.kind === 'info') inst.slice.lines = Array.from({ length: 60 }, (_, i) => `info line ${i} alpha beta gamma`);
      if (inst.kind === 'text-view') inst.slice.lines = Array.from({ length: 60 }, (_, i) => `tv line ${i} one two three`);
    });
    const p = require('../leaves/wm/pool').allPanesInColumns(layout().arrange).find(x => x.paneId === 'pane-detail');
    const tabs = (p && p.tabs) || [];
    const other = tabs.map(t => t.poolId || t.id).find(id => id !== p.activeTabId);
    assert(other, 'the content slot has a second tab');
    toLayout({ type: 'focus_set', focus: 'pane-detail' });
    hc.paint();
    const d = geo.visibleBoundsFor(layout(), 'pane-detail');
    const reg = JSON.stringify(getModel().register);
    input._classifyPress(0, 250, 90, Date.now());
    tok(sgr(0, d.x + 3, d.y + 2));
    assert(capture.held() && capture.held().name === 'text-select', 'a text-select drag');
    tok(sgr(32, d.x + 10, d.y + 4));
    toLayout({ type: 'set_active_tab', paneId: 'pane-detail', tabPoolId: other });
    tok(sgr(32, d.x + 15, d.y + 6));
    tok(sgr(0, d.x + 15, d.y + 6, true));
    eq(JSON.stringify(getModel().register), reg, 'the register is unchanged');
    eq(capture.held(), null, 'the release ended the capture');
  });
});

describe('[4e] pre-release review round 3', () => {
  it('a composite whose bars scrolled inside their own body: a click selects the bar painted there', () => {
    for (const p of ['monitor/stats', 'monitor/gauge', 'monitor/composite']) {
      const c = require(`../panel/${p}`);
      if (!api.getComponent(c.name)) { try { api.registerComponent(c); } catch (_) { /* registered */ } }
    }
    // The bars sit BELOW a graph, in a quarter of the box: the pane's nav (sized
    // to the whole box) never scrolls, while the bars body windows itself to keep
    // the cursor visible.
    const paneCfg = { id: 'cbox', type: 'composite', title: 'CPU', config: { widgets: [
      { type: 'graph', topic: 'ci.cpu', row: '_', metrics: ['cpu'] },
      { type: 'bars', topic: 'ci.core', column: 'busy', label: 'core', interactive: true, height: '25%' },
    ] } };
    sm.bootFresh({ groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { cbox: paneCfg }, columns: [{ panels: [paneCfg] }] } });
    toLayout({ type: 'view_set', mode: 'normal' });
    sm.resize(120, 30);
    const series = {};
    for (let i = 0; i < 40; i++) series['c' + String(i).padStart(2, '0')] = [{ busy: 100 - i, core: 'cpu' + i }];
    getModel().metrics = { 'ci.core': { series, schema: { columns: { busy: { type: 'percent' }, core: { type: 'string' } } } },
      'ci.cpu': { series: { _: [{ cpu: 20 }, { cpu: 40 }, { cpu: 60 }] }, schema: { columns: { cpu: { type: 'percent' } } } } };
    hc.paint();
    const paneId = bodies()[0].paneId;
    toLayout({ type: 'focus_set', focus: paneId });
    for (let i = 0; i < 12; i++) tok('j');
    hc.paint();
    const nav = require('../panel/nav-state');
    const items = api.getItems(paneId);
    eq(items[nav.getSel(paneId)], 'c12', 'the cursor moved down the bars');
    const cap = require('../panel/select-view').contentFor(paneId);
    const b = geo.visibleBoundsFor(layout(), paneId);
    const y = b.y + 1 + cap.headerRows;                       // the bars body's first screen row
    const shown = (hc.screenRows()[y] || []).map(c => (c == null ? ' ' : c)).join('').slice(b.x, b.x + 40);
    const m = /cpu(\d+)/.exec(shown);
    assert(m && m[1] !== '0', `the bars scrolled (first row shows ${JSON.stringify(shown.trim())})`);
    input._classifyPress(0, 250, 90, Date.now());
    tok(sgr(0, b.x + 5, y));
    tok(sgr(0, b.x + 5, y, true));
    eq(items[nav.getSel(paneId)], 'c' + m[1].padStart(2, '0'), 'the click selected the row painted there');
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
    sm.capture(() => sm.applyMsg({ type: 'confirm_reject' }));
    // A stale frame: a popup opened by a batched key, not yet painted — a hover
    // over the graph sets nothing (pre-review: it resolved the stale body).
    hc.paint();
    sm.capture(() => sm.applyMsg({ type: 'menu_open' }));
    sm.capture(() => input.handleMouse('hover', mx + 5, my + 1));
    eq(layout().hover, null, 'no hover resolved against the stale frame');
    sm.capture(() => sm.applyMsg({ type: 'menu_close' }));
    // A hover-OUT on a stale frame still clears (round-2 review: the value
    // stayed on screen when the pointer left the graph in a chunk with a key).
    hc.paint();
    sm.capture(() => input.handleMouse('hover', mx + 1, my + 1));
    assert(layout().hover, `hover live again (modes: ${require('../leaves/input/modes').chainStamp(getModel().modes)})`);
    sm.capture(() => sm.applyMsg({ type: 'mode_set', flag: 'prefixMode' }));   // a batched key — not painted
    sm.capture(() => input.handleMouse('hover', 1, 1));                         // the pointer left the graph
    eq(layout().hover, null, 'cleared on the stale frame');
    sm.capture(() => sm.applyMsg({ type: 'mode_clear', flag: 'prefixMode' }));
  });
});

report();
