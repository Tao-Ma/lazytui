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
 *   trigger → every visible pane paints its own [≡]; the hit map's trigger
 *           region (published where the glyph painted — docs/mouse-hit-map.md
 *           Release 2) resolves to the specific pane whose glyph was clicked.
 *
 *   node js/test/test-tab-list.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');
const { leftBorderPrefix } = require('../leaves/render/draw');

// `[≡]` clicks resolve on the hit map, which only a REAL paint populates. The
// trigger sections below paint a two-viewer fixture: three columns — groups,
// then a content slot in the MIDDLE column (middle columns get no hotkey, so its
// `[≡]` sits flush at local col 2: `╭─[≡]`), then a content slot in the last
// column (hotkey 7 → `╭─(7)[≡]`, local col 5). Each content slot is a multi-tab
// (Info + Transcript) slot, so both show a trigger.
function paintTwoViewers(modeFlags) {
  const sm = require('./smoke/_helpers/smoke');
  const hc = require('./_helpers/hit-click');
  const loop = require('../dispatch/runtime/loop');
  const toLayout = (m) => sm.capture(() => loop.dispatchMsg(sm.api.wrap('layout', m)));
  sm.bootFresh({ layout: {
    pool: { groups: { id: 'groups', type: 'groups' }, d1: { id: 'd1', type: 'detail' }, d2: { id: 'd2', type: 'detail' } },
    columns: [
      { width: 30, panels: [{ id: 'groups', type: 'groups' }] },
      { width: 45, panels: [{ id: 'd1', type: 'detail' }] },
      { panels: [{ id: 'd2', type: 'detail' }] },
    ],
  } });
  toLayout({ type: 'view_set', mode: 'normal' });
  sm.resize(120, 24);
  for (const flag of (modeFlags || [])) sm.capture(() => sm.applyMsg({ type: 'mode_set', flag }));
  hc.paint();
  const ls = sm.api.getInstanceSlice('layout');
  const b = (paneId) => require('../leaves/wm/geometry').visibleBoundsFor(ls, paneId);
  const glyph = (paneId) => {   // the [≡]'s `[` screen column, from the pane's hotkey
    const p = require('../leaves/wm/pool').allPanesInColumns(ls.arrange).find(x => x.paneId === paneId);
    return b(paneId).x + leftBorderPrefix(p.hotkey || '').triggerCol;
  };
  return { hc, b, glyph };
}

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
  it('skips the section separator (sepIdx) in both directions', () => {
    // List: tab0, tab1, [sep@2], pane3, pane4 (n=5). Cursor must never
    // rest on the divider.
    let s = open(1);  // on tab1
    s = applyUpdate(s, { type: 'pane_menu_nav', dir: +1, n: 5, vh: 5, sepIdx: 2 }).next;
    eq(s.paneMenu.cursor, 3, 'down from 1 jumps over sep@2 to 3');
    s = applyUpdate(s, { type: 'pane_menu_nav', dir: -1, n: 5, vh: 5, sepIdx: 2 }).next;
    eq(s.paneMenu.cursor, 1, 'up from 3 jumps over sep@2 to 1');
  });
});

describe('[pane-menu items] section depends on the pane kind', () => {
  const api = require('../panel/api');
  const { getModel } = require('../app/runtime');
  try { api.registerComponent(layout); } catch (e) { /* already registered */ }
  const overlay = require('../overlay/pane-menu');
  const layoutSlice = api.getInstanceSlice('layout');

  it('a content slot → position-tab rows (section:tab), Info + Transcript', () => {
    // U2f — the content slot is a MULTI-tab position container (role:'content')
    // seeded with Info + Transcript position-tabs; its `[≡]` shows the SAME unified
    // slot rows the visible border strip does (backing:'slot', kind:'position'),
    // NOT the retired viewer's flat Info/Transcript literals.
    layoutSlice.arrange = { columns: [
      { panels: [{ type: 'info', id: 'detail', paneId: 'pane-d', role: 'content',
        activeTabId: 'info-pane-d',
        tabs: [{ id: 'info-pane-d', poolId: 'info-pane-d' }, { id: 'transcript-pane-d', poolId: 'transcript-pane-d' }] }] },
    ], pool: {
      'info-pane-d': { id: 'info-pane-d', type: 'info', title: 'Info' },
      'transcript-pane-d': { id: 'transcript-pane-d', type: 'text-view', title: 'Transcript', hint: 'transcript' },
    } };
    getModel().currentGroup = getModel().currentGroup || '';
    const items = overlay.items('pane-d');
    assert(items.length >= 2, 'Info + Transcript at minimum');
    assert(items.every(it => it.section === 'tab' && it.backing === 'slot' && it.kind === 'position'),
      'all rows are unified position-tab slot rows');
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
  const { renderPanel } = require('../leaves/render/draw');
  const { richToAnsi, visibleLen } = require('../leaves/text/ansi');
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
// own `[≡]` glyph; a click must resolve to the SPECIFIC viewer whose glyph was
// clicked (not the focused-or-first singleton).
describe('[trigger] multi-viewer — each glyph opens its own pane', () => {
  it('clicking the first viewer glyph returns pane-d1', () => {
    const { hc, glyph } = paintTwoViewers();
    eq(hc.triggerAt(glyph('pane-d1') + 1, 0), 'pane-d1');
  });
  it('clicking the non-first viewer glyph returns pane-d2', () => {
    const { hc, glyph } = paintTwoViewers();
    eq(hc.triggerAt(glyph('pane-d2') + 1, 0), 'pane-d2');
  });
  it('clicking the gap / wrong row returns null', () => {
    const { hc, glyph } = paintTwoViewers();
    eq(hc.triggerAt(glyph('pane-d1') + 20, 0), null, 'top border between the glyphs misses');
    eq(hc.triggerAt(glyph('pane-d1') + 1, 5), null, 'wrong row misses');
  });
  it('not clickable while another chain mode owns input', () => {
    const { hc, glyph } = paintTwoViewers(['freeConfigMode']);
    eq(hc.triggerAt(glyph('pane-d1') + 1, 0), null, 'first glyph dead under chain mode');
    eq(hc.triggerAt(glyph('pane-d2') + 1, 0), null, 'second glyph dead under chain mode');
  });
});

// Regression — a pane with NO hotkey draws `[≡]` flush at local col 2 (`╭─[≡]`),
// not col 5. The trigger hit-zone must follow the glyph (derive from the hotkey
// width), else clicking the visible `[≡]` misses by 3 cells and the user has to
// aim right of it. Reproduced on the host-monitor demo's hotkey-less middle
// column; the region is published where the glyph painted.
describe('[trigger] hotkey-less pane — [≡] hit-zone follows the glyph (col 2)', () => {
  it('clicking the glyph at local col 2/3/4 opens the menu', () => {
    const { hc, b } = paintTwoViewers();
    const x = b('pane-d1').x;
    eq(hc.triggerAt(x + 2, 0), 'pane-d1', 'the `[` at col 2');
    eq(hc.triggerAt(x + 3, 0), 'pane-d1', 'the `≡` at col 3');
    eq(hc.triggerAt(x + 4, 0), 'pane-d1', 'the `]` at col 4');
    eq(hc.screenText('pane-d1', 'trigger'), '[≡]', 'the region covers the painted glyph');
  });
  it('clicking the OLD fixed offset (col 5) — 3 cells right of the glyph — misses', () => {
    const { hc, b } = paintTwoViewers();
    eq(hc.triggerAt(b('pane-d1').x + 5, 0), null, 'no phantom hit-zone right of the glyph');
  });
});

report();
