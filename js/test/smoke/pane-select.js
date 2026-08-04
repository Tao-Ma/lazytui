/**
 * Smoke — per-pane text selection (docs/pane-selection.md), end-to-end through
 * the REAL mouse pipeline (press → motion → release) + render, driving the
 * shipped demo/fabric/tui.yml so a non-viewer pane (the component-ports pane) is
 * on screen. Asserts: a drag selects a substring + copies it to the register;
 * the highlight paints; a plain click leaves no selection; right-click offers
 * "Copy selection"; and the global / per-pane config gate disables it.
 *
 * Run: node js/scripts/run-smoke.js   (or node js/test/smoke/pane-select.js)
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('../test-runner');   // auto-registers layout/detail/groups
const sm = require('./_helpers/smoke');
const api = sm.api;
const route = sm.route;
const { parse } = require('../../parser/index');
const { getModel } = require('../../app/runtime');
const { initState } = require('../../app/state');
const { wireFabricHost } = require('../../dispatch/runtime/host-wiring');
const { dispatchMsg } = require('../../dispatch/runtime/loop');
const navState = require('../../panel/nav-state');
const input = require('../../dispatch/control/input');
const selView = require('../../panel/select-view');
const { visibleBoundsFor } = require('../../leaves/wm/geometry');
const paint = require('../../render/paint');

for (const p of ['navigator/actions', 'fabric/ports-pane', 'fabric/wire-list']) {
  const c = require('../../panel/' + p);
  if (!api.getInstanceSlice(c.name)) api.registerComponent(c);
}

const DEMO = path.join(__dirname, '..', '..', '..', 'demo', 'fabric', 'tui.yml');
const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();
wireFabricHost();

function paneIdOf(type) {
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const pn of (col.panels || [])) {
      if (pn && pn.type === type && pn.paneId) return pn.paneId;
      for (const t of ((pn && pn.tabs) || [])) if (t && t.type === type && t.paneId) return t.paneId;
    }
  }
  return null;
}
const PORTS = paneIdOf('component-ports');
const rawFrame = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()).frame; };
const raw = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()).raw; };
// Raw-byte assertions below compare against richToAnsi's canonical truecolor
// compile — pin the depth so the harness env (e.g. TERM=tmux-256color → 256)
// doesn't downgrade the frame bytes first. Depth adaptation has its own
// end-to-end proof in smoke/stats-graph.js.
paint.setColorDepth('truecolor');
const bounds = (paneId) => visibleBoundsFor(api.getInstanceSlice('layout'), paneId, route.resolveViewerPaneId());

// Drive the real mouse pipeline. Content coords → 1-based SGR: the content
// region starts at (b.x+1, b.y+1); a display col/row maps to mx=b.x+1+col,
// my=b.y+1+row; SGR x/y are those +1.
function mouse(kind, paneId, col, row) {
  const b = bounds(paneId);
  // handleMouse paints internally; capture so the driver doesn't spray the
  // rendered frame across the smoke runner's output (mirrors the key() driver).
  sm.capture(() => input.handleMouse(kind, (b.x + 1 + col) + 1, (b.y + 1 + row) + 1));
}

// Select `miner` in the ports header (display cols 0..4) via a drag.
navState.setSel('actions', 2);   // miner
rawFrame();                      // first paint → capture content + bounds

describe('[1] a drag selects a substring and copies it to the register', () => {
  it('dragging cols 0..4 on the header selects "miner"', () => {
    mouse('press', PORTS, 0, 0);
    mouse('motion', PORTS, 2, 0);
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    const own = selView.activeSelection();
    assert(own && own.sel.active && own.paneId === PORTS, `selection active on ports: ${JSON.stringify(own)}`);
    eq(getModel().register.history[0], 'miner', 'selected text pushed to the register');
  });
  it('the selected span renders in the theme selected style', () => {
    // 3b — the span carries theme().selected (a fg/bg pair on hex themes,
    // reverse on minimal); assert the tag's COMPILED SGR wraps the span so
    // the smoke stays correct under any theme the harness boots with.
    const { theme } = require('../../leaves/infra/themes');
    const { richToAnsi } = require('../../leaves/text/ansi');
    const selSgr = richToAnsi(`[${theme().selected}]`)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(new RegExp(`${selSgr}\\s*miner`).test(raw()), 'selected SGR wraps "miner"');
  });
});

describe('[2] a plain click leaves no selection', () => {
  it('press+release with no motion clears the selection (a click, not a drag)', () => {
    mouse('press', PORTS, 3, 0);
    mouse('release', PORTS, 3, 0);
    assert(!selView.activeSelection(), 'no active selection after a bare click');
  });
});

describe('[3] right-click offers "Copy selection" for the active selection', () => {
  it('after a drag, the context menu includes Copy selection', () => {
    mouse('press', PORTS, 0, 0);
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    const b = bounds(PORTS);
    sm.capture(() => input.handleMouse('right', (b.x + 1) + 1, (b.y + 1) + 1));
    const items = (getModel().modal.menu.items || []).map((r) => r && r[0]);
    assert(items.some((l) => /Copy selection/.test(l)), `menu has Copy selection: ${JSON.stringify(items)}`);
    require('../../dispatch/control/dispatch').applyMsg({ type: 'menu_close' });
    const own = selView.activeSelection();
    if (own) dispatchMsg(route.wrap(own.paneId, { type: 'select_cancel' }));
  });
});

describe('[5] two active selections — the gesture stays on the armed pane', () => {
  // More than one pane can hold an active selection by design (a keyboard
  // visual-mode selection + a persisted mouse one, or a hidden tab re-owning
  // on switch-back). Regression: the scan-first pick used to skip select_begin
  // on the dragged pane and settle/copy the STALE pane's selection instead.
  const WIRES = paneIdOf('fabric-wires');
  it('a persisted selection elsewhere neither blocks the drag nor hijacks the copy', () => {
    dispatchMsg(route.wrap(WIRES, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(WIRES, { type: 'select_extend', line: 0, col: 3 }));
    assert(selView.selectionFor(WIRES), 'wires selection seeded');
    mouse('press', PORTS, 0, 0);
    assert(!selView.selectionFor(WIRES), 'press cancelled the OTHER pane\'s selection too');
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    const own = selView.activeSelection();
    assert(own && own.paneId === PORTS, `the drag began+settled on ports: ${JSON.stringify(own)}`);
    eq(getModel().register.history[0], 'miner', 'the DRAGGED text was copied, not the stale selection');
  });
});

describe('[6] group switch clears EVERY active selection', () => {
  const WIRES = paneIdOf('fabric-wires');
  it('two actives → reset_group_context → none survive', () => {
    dispatchMsg(route.wrap(PORTS, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(PORTS, { type: 'select_extend', line: 0, col: 4 }));
    dispatchMsg(route.wrap(WIRES, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(WIRES, { type: 'select_extend', line: 0, col: 3 }));
    eq(selView.activeSelections().length, 2, 'two panes hold active selections');
    require('../../dispatch/control/dispatch').applyMsg({ type: 'reset_group_context', owners: {} });
    eq(selView.activeSelections().length, 0, 'the select_cancel_all sweep cancelled them all');
  });
  it('a hidden tab\'s persisted selection is cleared too (registry sweep)', () => {
    // Seed a selection on the ACTIVE content instance, then hide it behind a
    // freshly minted tab — per-tab persistence keeps slice.select on the hidden
    // instance (scenario [7]). The group switch must reach it ANYWAY: the
    // per-pane scan sees only active instances, and a surviving hidden
    // selection would re-own over whatever content the new group loads into
    // that instance on switch-back (review 2026-08-01, MED).
    const target = route.resolveTarget('viewer');
    const vs = api.getInstanceSlice(target);
    vs.lines = ['alpha beta'];
    vs.scroll = 0;
    dispatchMsg(route.wrap(target, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(target, { type: 'select_extend', line: 0, col: 4 }));
    require('../../panel/content-tab').addContentTab(
      getModel().currentGroup, 'doc-hidden-sweep', 'Doc', ['other line']);
    assert(route.resolveTarget('viewer') !== target, 'the seeded instance is hidden now');
    assert(api.getInstanceSlice(target).select?.active, 'hidden tab holds a persisted selection');
    require('../../dispatch/control/dispatch').applyMsg({ type: 'reset_group_context', owners: {} });
    assert(!api.getInstanceSlice(target).select?.active, 'the registry sweep cleared the hidden selection');
    eq(selView.allSelections().length, 0, 'no instance anywhere still holds one');
    // Restore the original tab as active so later scenarios ([7]) see the
    // pre-mint content instance.
    const viewerPane = route.resolveViewerPaneId();
    const pane = navState.allPanels().find((x) => x.paneId === viewerPane);
    const back = (pane.tabs || []).find((t) => t.type === 'info') || (pane.tabs || [])[0];
    dispatchMsg(route.wrap('layout', { type: 'set_active_tab', paneId: viewerPane, tabPoolId: back.poolId }));
  });
});

describe('[4] the config gate disables selection', () => {
  it('global selection:false → a drag produces no selection', () => {
    getModel().config.selection = false;
    mouse('press', PORTS, 0, 0);
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    assert(!selView.activeSelection(), 'no selection when globally disabled');
  });
  it('a per-pane select:true override re-enables it while global is off', () => {
    const p = navState.allPanels().find((x) => x.paneId === PORTS);
    p.select = true;
    mouse('press', PORTS, 0, 0);
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    assert(selView.activeSelection(), 'per-pane override wins over the global default');
    p.select = undefined;
    getModel().config.selection = true;
  });
});

describe('[7] per-tab persistence — a content tab keeps its selection across a tab switch', () => {
  // THE property the unified per-instance model buys (docs/pane-selection.md):
  // every tab is its own instance, so a hidden tab's `slice.select` survives —
  // without owning the app-wide selection — and re-owns on switch-back.
  it('hidden tab keeps but does not own; switch-back re-owns', () => {
    for (const own of selView.activeSelections()) {                 // clean slate after [4]
      dispatchMsg(route.wrap(own.paneId, { type: 'select_cancel' }));
    }
    const viewerPane = route.resolveViewerPaneId();
    const target = route.resolveTarget('viewer');                   // active content instance
    const vs = api.getInstanceSlice(target);
    vs.lines = ['alpha beta', 'gamma delta'];
    vs.scroll = 0;
    dispatchMsg(route.wrap(target, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(target, { type: 'select_extend', line: 0, col: 4 }));
    eq(selView.activeSelection()?.paneId, viewerPane, 'content pane owns the selection');
    eq(selView.selectedText(), 'alpha', 'selected text resolves from the instance buffer');

    // Mint a second content tab — it becomes the pane's active tab.
    require('../../panel/content-tab').addContentTab(
      getModel().currentGroup, 'doc-x', 'Doc X', ['doc line 1']);
    assert(route.resolveTarget('viewer') !== target, 'the minted doc tab is active now');
    assert(api.getInstanceSlice(target).select?.active, 'hidden tab keeps its selection on its slice');
    assert(!selView.activeSelection(), 'but the hidden tab does NOT own the app-wide selection');

    // Switch back to the original tab → its persisted selection re-owns.
    const pane = navState.allPanels().find((x) => x.paneId === viewerPane);
    const back = (pane.tabs || []).find((t) => t.type === 'info') || (pane.tabs || [])[0];
    dispatchMsg(route.wrap('layout', { type: 'set_active_tab', paneId: viewerPane, tabPoolId: back.poolId }));
    eq(selView.activeSelection()?.paneId, viewerPane, 'switch-back re-owns the persisted selection');
    eq(selView.selectedText(), 'alpha', 'and its text is intact');
  });
});

describe('[8] Copy selection is POINTER-scoped under multi-active selections', () => {
  // Two active selections (by design): a focused-pane one on ports + a
  // persisted one on wires. Right-clicking OVER the wires highlight must copy
  // the wires text — the focused-first global scan used to win, copying a
  // selection the pointer wasn't even on (review 2026-08-01, MED).
  const WIRES = paneIdOf('fabric-wires');
  it('right-click over the non-focused pane\'s highlight copies THAT text', () => {
    mouse('press', PORTS, 0, 0);                 // focuses ports; sweeps priors
    mouse('motion', PORTS, 4, 0);
    mouse('release', PORTS, 4, 0);
    assert(selView.selectionFor(PORTS), 'ports (focused) holds a selection');
    dispatchMsg(route.wrap(WIRES, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
    dispatchMsg(route.wrap(WIRES, { type: 'select_extend', line: 0, col: 3 }));
    const wiresText = selView.selectedTextFor(WIRES);
    assert(wiresText && wiresText !== selView.selectedTextFor(PORTS), 'two distinct active selections');

    const b = bounds(WIRES);
    sm.capture(() => input.handleMouse('right', (b.x + 1 + 1) + 1, (b.y + 1) + 1));
    const menu = getModel().modal.menu;
    const ci = (menu.items || []).findIndex((r) => r && r[0] === 'Copy selection');
    assert(ci >= 0, `menu offers Copy selection (saw: ${JSON.stringify((menu.items || []).map((r) => r && r[0]))})`);
    const box = require('../../leaves/render/draw').overlayBox(
      { linesLen: menu.items.length, anchor: menu.anchor, maxWidth: 44 });
    sm.capture(() => input.handleMouse('press', box.offX + 3, box.offY + 1 + ci + 1));
    eq(getModel().register.history[0], wiresText, 'the POINTER pane\'s selection was copied');
    for (const own of selView.allSelections()) {
      dispatchMsg(route.wrap(own.instId, { type: 'select_cancel' }));
    }
  });
});

report();
