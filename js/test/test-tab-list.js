/**
 * Pane-menu — the viewer/tab face of the unified `[≡]` overlay.
 *
 * v0.6.4 #1 Step 2 unioned the former tab-list + pane-select overlays into
 * one `overlay/pane-menu.js` driven by `layout.paneMenu` + `paneMenuMode`.
 * This file covers the tab-section + trigger behavior; test-pane-select.js
 * covers the pane-section + pool_swap arms.
 *
 *   open  → layout.paneMenu stores the cursor/scroll the handler seeds
 *           (at the active tab); arms paneMenuMode.
 *   nav   → cursor moves, scroll auto-advances at viewport edges (shared
 *           pane_menu_nav math).
 *   items → a viewer pane yields tab rows (section:'tab'); a navigator
 *           yields pane rows (section:'pane').
 *   trigger → every visible pane paints its own [≡]; hitTestTrigger
 *           returns the specific pane whose glyph was clicked.
 *
 *   node js/test/test-tab-list.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');

function applyUpdate(slice, msg) {
  const r = layout.update(msg, slice);
  return Array.isArray(r) ? { next: r[0], cmds: r[1] } : { next: r, cmds: [] };
}

describe('[pane_menu_open] stores the seeded cursor/scroll + arms mode', () => {
  it('stores cursor/scroll from the Msg (handler seeds them at the active tab)', () => {
    const s = layout.init();
    const { next, cmds } = applyUpdate(s, { type: 'pane_menu_open', paneId: 'pane-d', cursor: 7, scroll: 3 });
    eq(next.paneMenu.targetPaneId, 'pane-d');
    eq(next.paneMenu.cursor, 7);
    eq(next.paneMenu.scroll, 3);
    assert(cmds.some(c => c.type === 'msg' && c.msg.flag === 'paneMenuMode' && c.msg.type === 'mode_set'),
      'mode_set paneMenuMode emitted');
  });
  it('defaults cursor/scroll to 0 when omitted', () => {
    const { next } = applyUpdate(layout.init(), { type: 'pane_menu_open', paneId: 'pane-d' });
    eq(next.paneMenu.cursor, 0);
    eq(next.paneMenu.scroll, 0);
  });
  it('re-open on the same target preserves cursor/scroll (idempotent, identity)', () => {
    let s = applyUpdate(layout.init(), { type: 'pane_menu_open', paneId: 'pane-d', cursor: 4, scroll: 1 }).next;
    const before = s.paneMenu;
    s = applyUpdate(s, { type: 'pane_menu_open', paneId: 'pane-d', cursor: 9, scroll: 9 }).next;
    eq(s.paneMenu, before, 'slice identity preserved; cursor/scroll untouched');
  });
});

describe('[pane_menu_nav] cursor + auto-scroll (shared math)', () => {
  function open(cursor, scroll = 0) {
    return { ...layout.init(), paneMenu: { targetPaneId: 'pane-d', cursor, scroll } };
  }
  it('dir:+1 advances cursor', () => {
    const { next } = applyUpdate(open(0), { type: 'pane_menu_nav', dir: 1, n: 10, vh: 5 });
    eq(next.paneMenu.cursor, 1);
  });
  it('cursor walking off bottom advances scroll', () => {
    let s = open(0);
    for (let i = 0; i < 7; i++) s = applyUpdate(s, { type: 'pane_menu_nav', dir: 1, n: 10, vh: 5 }).next;
    eq(s.paneMenu.cursor, 7);
    eq(s.paneMenu.scroll, 3, 'cursor=7, vh=5 → scroll=3');
  });
  it('cursor walking off top retreats scroll', () => {
    let s = open(9, 5);
    for (let i = 0; i < 6; i++) s = applyUpdate(s, { type: 'pane_menu_nav', dir: -1, n: 10, vh: 5 }).next;
    eq(s.paneMenu.cursor, 3);
    eq(s.paneMenu.scroll, 3, 'scroll preserved while cursor stays in view');
  });
  it('to:pageup / pagedown jump by vh', () => {
    let s = open(10);
    s = applyUpdate(s, { type: 'pane_menu_nav', to: 'pagedown', n: 20, vh: 5 }).next;
    eq(s.paneMenu.cursor, 15);
    s = applyUpdate(s, { type: 'pane_menu_nav', to: 'pageup', n: 20, vh: 5 }).next;
    eq(s.paneMenu.cursor, 10);
  });
  it('to:top / bottom jump to ends', () => {
    let s = open(5);
    s = applyUpdate(s, { type: 'pane_menu_nav', to: 'bottom', n: 10, vh: 5 }).next;
    eq(s.paneMenu.cursor, 9);
    s = applyUpdate(s, { type: 'pane_menu_nav', to: 'top', n: 10, vh: 5 }).next;
    eq(s.paneMenu.cursor, 0);
    eq(s.paneMenu.scroll, 0);
  });
  it('cursor clamps within [0, n-1]', () => {
    let s = open(0);
    for (let i = 0; i < 10; i++) s = applyUpdate(s, { type: 'pane_menu_nav', dir: 1, n: 3, vh: 5 }).next;
    eq(s.paneMenu.cursor, 2, 'clamps to n-1');
  });
  it('n=0 is a no-op (identity preserved)', () => {
    const s = open(0);
    eq(applyUpdate(s, { type: 'pane_menu_nav', dir: 1, n: 0, vh: 5 }).next, s);
  });
});

describe('[pane-menu items] section depends on the pane kind', () => {
  const api = require('../panel/api');
  const { getModel } = require('../app/runtime');
  try { api.registerComponent(layout); } catch (e) { /* already registered */ }
  const overlay = require('../overlay/pane-menu');
  const layoutSlice = api.getInstanceSlice('layout');

  it('a viewer pane → tab rows (section:tab), at least Info + Transcript', () => {
    layoutSlice.arrange = { columns: [
      { panels: [{ type: 'detail', id: 'd', paneId: 'pane-d', tabs: [{ id: 'd', poolId: 'd' }] }] },
    ], pool: { d: { id: 'd', type: 'detail' } } };
    getModel().currentGroup = getModel().currentGroup || '';
    const items = overlay.items('pane-d');
    assert(items.length >= 2, 'Info + Transcript at minimum');
    assert(items.every(it => it.section === 'tab'), 'all rows are tab rows');
    eq(items[0].label, 'Info');
    eq(items[1].label, 'Transcript');
  });

  it('a navigator pane → pane rows (section:pane)', () => {
    layoutSlice.arrange = { columns: [
      { width: 24, panels: [
        { type: 'groups',  id: 'groups',  paneId: 'pane-groups' },
        { type: 'actions', id: 'actions', paneId: 'pane-actions' },
      ] },
      { panels: [{ type: 'detail', id: 'detail', paneId: 'pane-detail' }] },
    ], pool: {
      groups:  { id: 'groups',  type: 'groups' },
      actions: { id: 'actions', type: 'actions' },
      detail:  { id: 'detail',  type: 'detail' },
      stats:   { id: 'stats',   type: 'stats' },
    } };
    const items = overlay.items('pane-groups');
    assert(items.length >= 2, 'here + swap targets');
    assert(items.every(it => it.section === 'pane'), 'all rows are pane rows');
    eq(items[0].id, 'groups');
    eq(items[0].status, 'here');
  });
});

// Render-side: the [≡] trigger glyph is inserted AFTER (o), so the user
// sees both the hotkey and the trigger; total width is preserved.
describe('[chrome:tabTrigger] (o)[≡] layout preserves panel width', () => {
  const { renderPanel } = require('../render/panel');
  const { richToAnsi, visibleLen } = require('../io/ansi');
  function strip(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

  it('top row contains both (o) and [≡] with width preserved', () => {
    const out = renderPanel({
      width: 40, height: 10, lines: [], title: 'Detail', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const vis = strip(richToAnsi(top));
    eq(visibleLen(top), 40, 'top-border width = 40 with chrome inline');
    assert(vis.includes('(o)'), `(o) preserved: ${vis}`);
    assert(vis.includes('[≡]'), `[≡] inserted: ${vis}`);
    assert(vis.indexOf('(o)[≡]') >= 0, `(o)[≡] adjacent: ${vis}`);
  });

  it('narrow pane (no room) drops chrome — bare border', () => {
    const out = renderPanel({
      width: 10, height: 10, lines: [], title: 'T', hotkey: 'o', focused: true,
      chrome: { collapse: null, close: null, tabTrigger: 'available' },
    });
    const top = out.split('\n')[0];
    const vis = strip(richToAnsi(top));
    eq(visibleLen(top), 10, 'width preserved in fallback');
    assert(vis.includes('(o)'), 'hotkey shown in bare-border fallback');
    assert(!vis.includes('[≡]'), 'trigger dropped on narrow pane');
  });
});

// The trigger state machine: open (paneMenuMode) / disabled (another chain
// mode) / normal. Exposed via overlay/pane-menu._triggerState.
describe('[trigger state machine] open / disabled / normal', () => {
  const overlay = require('../overlay/pane-menu');
  const { getModel } = require('../app/runtime');
  const md = getModel().modes;

  function withModes(setFlags, fn) {
    const saved = {};
    for (const k of Object.keys(setFlags)) { saved[k] = md[k]; md[k] = setFlags[k]; }
    try { return fn(); } finally { for (const k of Object.keys(saved)) md[k] = saved[k]; }
  }

  it('normal when no chain mode active', () => {
    withModes({ paneMenuMode: false, freeConfigMode: false, cmdMode: false },
      () => eq(overlay._triggerState(), 'normal'));
  });
  it('open when paneMenuMode is on', () => {
    withModes({ paneMenuMode: true }, () => eq(overlay._triggerState(), 'open'));
  });
  it('disabled when another chain mode owns input', () => {
    withModes({ paneMenuMode: false, freeConfigMode: true },
      () => eq(overlay._triggerState(), 'disabled'));
    withModes({ paneMenuMode: false, cmdMode: true },
      () => eq(overlay._triggerState(), 'disabled'));
  });
});

// v0.6.4 — multi-viewer trigger routing. Each placed viewer paints its
// own `[≡]` glyph; hitTestTrigger must return the SPECIFIC viewer whose
// glyph was clicked (not the focused-or-first singleton).
describe('[hitTestTrigger] multi-viewer — each glyph opens its own pane', () => {
  const overlay = require('../overlay/pane-menu');
  const api = require('../panel/api');
  const { getModel } = require('../app/runtime');
  try { api.registerComponent(layout); } catch (e) { /* already registered */ }
  const layoutSlice = api.getInstanceSlice('layout');

  // Glyph band is [x+5, x+8) on row y → left at mx 6, right at mx 56.
  function withTwoViewers(fn) {
    const saved = { bounds: layoutSlice.paneBounds, arrange: layoutSlice.arrange, pm: layoutSlice.paneMenu };
    const md = getModel().modes;
    const savedModes = { paneMenuMode: md.paneMenuMode, freeConfigMode: md.freeConfigMode, cmdMode: md.cmdMode };
    layoutSlice.paneBounds = {
      'pane-left':  { x: 0,  y: 0, w: 40, h: 20 },
      'pane-right': { x: 50, y: 0, w: 40, h: 20 },
    };
    layoutSlice.arrange = { columns: [
      { panels: [{ paneId: 'pane-left',  type: 'detail', id: 'l' }] },
      { panels: [{ paneId: 'pane-right', type: 'detail', id: 'r' }] },
    ], pool: { l: { id: 'l', type: 'detail' }, r: { id: 'r', type: 'detail' } } };
    layoutSlice.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
    layoutSlice.freeConfig = { drag: null };
    md.paneMenuMode = false; md.freeConfigMode = false; md.cmdMode = false;
    try { return fn(); } finally {
      layoutSlice.paneBounds = saved.bounds;
      layoutSlice.arrange = saved.arrange;
      layoutSlice.paneMenu = saved.pm;
      Object.assign(md, savedModes);
    }
  }

  it('clicking the first viewer glyph returns pane-left', () => {
    withTwoViewers(() => eq(overlay.hitTestTrigger(6, 0), 'pane-left'));
  });
  it('clicking the non-first viewer glyph returns pane-right', () => {
    withTwoViewers(() => eq(overlay.hitTestTrigger(56, 0), 'pane-right'));
  });
  it('clicking the gap / wrong row returns null', () => {
    withTwoViewers(() => {
      eq(overlay.hitTestTrigger(20, 0), null, 'gap between panes misses');
      eq(overlay.hitTestTrigger(6, 5), null, 'wrong row misses');
    });
  });
  it('not clickable while another chain mode owns input', () => {
    withTwoViewers(() => {
      getModel().modes.freeConfigMode = true;
      eq(overlay.hitTestTrigger(6, 0), null, 'left glyph dead under chain mode');
      eq(overlay.hitTestTrigger(56, 0), null, 'right glyph dead under chain mode');
    });
  });
});

report();
