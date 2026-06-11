/**
 * Smoke — multi-instance: two same-type panes are independent.
 *
 * This is the acceptance scenario for the v0.6.4 Theme A spine (Phase 5,
 * Arcs 1–3). It drives the SHIPPED demo config
 * `demo/dual-browser/tui.yml` (a two-pane file manager — Source/js beside
 * Docs/docs, opening into one shared preview) through the REAL pipeline —
 * parser → `initState` → per-pane mint — then asserts the property the
 * spine exists to deliver: two `files` panes, declared with distinct pool
 * ids and rooted at different directories, behave as fully independent
 * instances.
 *
 * Before the spine a second same-type pane collapsed onto the FIRST
 * pane's slice (the read path downcast paneId → panel-type → the kind's
 * primary, and `files` was internally panelType-keyed). The empirical
 * symptom — recorded 2026-06-10 — was that pane B (rooted at docs/)
 * rendered pane A's directory (js/) and shared its cursor/scroll/filter.
 * Each assertion below pins one axis of independence that was broken
 * then and is fixed now; a regression that re-collapses the read path
 * trips this gate instead of surfacing at a user's click.
 *
 * Coverage:
 *   [1] mint        — two distinct `files` instances + a shared viewer
 *   [2] identity    — each instance self-identifies (slice.paneId)
 *   [3] cwd         — refresh resolves each pane's OWN root (the collapse)
 *   [4] nav state   — cursor / scroll / filter / multiSel are per-pane
 *   [5] routing     — keys hit the focused pane; content targets the
 *                     one shared viewer from either pane
 *   [6] loaded rows — (async) the real directory listings differ
 *
 * The demo's roots are project-relative (js/, docs/), resolved against
 * the config's project_dir — exactly the production cwd path. The smoke
 * runs from the repo, so both dirs are always present and deterministic.
 *
 * Run: node js/test/smoke/multi-instance.js
 *      (or via the suite: node js/scripts/run-smoke.js multi-instance)
 */
'use strict';

const path = require('path');
// Requiring test-runner auto-registers layout/detail/groups.
const { describe, it, eq, assert, section, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const route = sm.route;
const api = sm.api;
const state = require('../../app/state');
const { parse } = require('../../parser/index');
const { getModel } = require('../../app/runtime');
const { initState } = require('../../app/state');

const DEMO = path.join(__dirname, '..', '..', '..', 'demo', 'dual-browser', 'tui.yml');

// --- Boot: register the files Component, then drive the demo config
//     through the real parser + mint. layout/detail/groups were
//     auto-registered when test-runner loaded; files is the one this
//     scenario needs and must attach before initState walks the arrange.

if (!api.getInstanceSlice('files')) {
  api.registerComponent(require('../../panel/navigator/files'));
}

const cfg = parse(DEMO);
getModel().config = cfg;
// project_dir (`../..` → repo root) is resolved by the parser; use that
// resolved value, exactly as state.js loadConfig does in production. The
// panes' project-relative roots (js/, docs/) resolve against it.
getModel().projectDir = cfg.project_dir;
initState();

// Resolve the placed panes from the arrange the mint just built, rather
// than hardcoding paneIds — the demo declares pool ids `src` / `docs`,
// which the framework widens to `pane-src` / `pane-docs`, but the
// scenario should follow whatever was placed.
function placedFilesPanes() {
  const out = [];
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const p of (col.panels || [])) {
      if (p && p.type === 'files' && p.paneId) out.push({ paneId: p.paneId, root: p.root });
    }
  }
  return out;
}

// The configured root is project-relative; resolve it the same way the
// files Component's `_resolveInitialCwd` does, so the cwd assertions in
// [3] compare against the real absolute path.
function expectedCwd(root) {
  return path.isAbsolute(root) ? root : path.resolve(cfg.project_dir, root);
}

const FILES = placedFilesPanes();
const A = FILES[0];                       // pane-src  (root js/)
const B = FILES[1];                       // pane-docs (root docs/)
const VIEWER = route.resolveTarget('viewer');

// --- [1] Mint: two distinct files instances + a viewer ------------------

describe('[1] the demo mints two independent files instances', () => {
  it('two `files` panes were placed, rooted at different dirs', () => {
    eq(FILES.length, 2, 'exactly two files panes placed');
    assert(A.root !== B.root, `roots differ (${A.root} vs ${B.root})`);
  });
  it('each pane has its OWN slice object (not aliased to a primary)', () => {
    const sa = api.getInstanceSlice(A.paneId);
    const sb = api.getInstanceSlice(B.paneId);
    assert(sa && sb, 'both slices exist');
    assert(sa !== sb, 'distinct slice objects (pre-spine they were the same)');
    assert(sa.browser !== sb.browser, 'distinct browser sub-slices');
  });
  it('a shared viewer is placed for content from either pane', () => {
    assert(VIEWER, `resolveTarget('viewer') resolved a target (${VIEWER})`);
  });
});

// --- [2] Identity: the slice self-identifies (Arc 2) --------------------

describe('[2] each instance self-identifies via slice.paneId', () => {
  it(`${A.paneId} stamps its own paneId`, () => {
    eq(api.getInstanceSlice(A.paneId).paneId, A.paneId, 'A self-identifies');
  });
  it(`${B.paneId} stamps its own paneId`, () => {
    eq(api.getInstanceSlice(B.paneId).paneId, B.paneId, 'B self-identifies');
  });
});

// --- [3] cwd: refresh resolves each pane's OWN root (the collapse fix) --
//
// `_kickLoad` sets browser.cwd synchronously in the reducer (the actual
// directory read is the async loadDir effect, asserted in [6]). Pre-
// spine both panes resolved the primary's pane config, so B's cwd would
// have been js/ — pane A's root.

describe('[3] refresh resolves each pane to its own root, not the primary', () => {
  api.dispatchMsg(api.wrap(A.paneId, { type: 'refresh', panel: 'files' }));
  api.dispatchMsg(api.wrap(B.paneId, { type: 'refresh', panel: 'files' }));
  it(`${A.paneId} cwd === ${A.root}/`, () => {
    eq(api.getInstanceSlice(A.paneId).browser.cwd, expectedCwd(A.root), 'A cwd is its own root');
  });
  it(`${B.paneId} cwd === ${B.root}/ (NOT ${A.root}/)`, () => {
    eq(api.getInstanceSlice(B.paneId).browser.cwd, expectedCwd(B.root), 'B cwd is its own root');
  });
});

// --- [4] nav state: cursor / scroll / filter / multiSel are per-pane ----

describe('[4] cursor, scroll, filter, and multi-select are per-pane', () => {
  it('cursor is independent', () => {
    state.setSel(A.paneId, 3);
    state.setSel(B.paneId, 0);
    eq(api.getSel(A.paneId), 3, 'A cursor = 3');
    eq(api.getSel(B.paneId), 0, 'B cursor = 0 (not A\'s 3)');
    state.setSel(B.paneId, 1);
    eq(api.getSel(A.paneId), 3, 'A unchanged by B write');
  });
  it('scroll is independent', () => {
    state.setScroll(A.paneId, 7);
    eq(api.getScroll(A.paneId), 7, 'A scroll = 7');
    eq(api.getScroll(B.paneId), 0, 'B scroll = 0');
  });
  it('committed filter is independent', () => {
    api.dispatchMsg(api.wrap(A.paneId, { type: 'set_filter', panel: 'files', text: 'conf' }));
    eq(api.getFilter(A.paneId), 'conf', 'A filter committed');
    eq(api.getFilter(B.paneId), '', 'B filter still empty');
  });
  it('multi-select set is independent', () => {
    state.toggleMultiSel(A.paneId, 'x');
    state.toggleMultiSel(A.paneId, 'y');
    state.toggleMultiSel(B.paneId, 'z');
    eq(state.multiSelCount(A.paneId), 2, 'A has 2 selected');
    eq(state.multiSelCount(B.paneId), 1, 'B has 1 selected');
    assert(state.isMultiSel(A.paneId, 'x'), 'A holds x');
    assert(!state.isMultiSel(B.paneId, 'x'), 'B does NOT hold x');
  });
});

// --- [5] routing: keys → focused pane; content → the one viewer ---------
//
// Phase 1 routed keystrokes to the focused paneId; Phase 3/N13 made
// content from any files pane target the single shared viewer. With
// focus on A or B, the focus comparator must report `files`, and the
// viewer target must be the same detail pane either way.

describe('[5] focus routes to the focused pane; viewer is shared', () => {
  const layout = api.getInstanceSlice('layout');
  const origFocus = layout.focus;
  for (const pane of [A, B]) {
    it(`focus=${pane.paneId}: comparator reports 'files'`, () => {
      layout.focus = pane.paneId;
      eq(route.instanceKind(route.getFocus()), 'files',
        'focused pane resolves to the files kind (was the v0.6.3 bug class)');
    });
    it(`focus=${pane.paneId}: viewer target is the shared viewer`, () => {
      layout.focus = pane.paneId;
      eq(route.resolveTarget('viewer'), VIEWER,
        'content from either files pane targets the one viewer');
    });
  }
  layout.focus = origFocus;
});

// --- [6] loaded rows: the real directory listings differ (async) --------
//
// loadDir is an off-tick (setImmediate) effect, so the rows land after
// a turn of the event loop. Drain it, then prove the two panes hold
// genuinely different listings — the end-to-end form of the collapse
// fix that a user would see on screen.

(async () => {
  // Re-kick both loads, then let the setImmediate loadDir effects run.
  api.dispatchMsg(api.wrap(A.paneId, { type: 'refresh', panel: 'files' }));
  api.dispatchMsg(api.wrap(B.paneId, { type: 'refresh', panel: 'files' }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  section('[6] the real directory listings differ');

  // getItems applies each pane's own committed filter. A still carries
  // the 'conf' filter from [4]; clear it so this compares raw listings.
  api.dispatchMsg(api.wrap(A.paneId, { type: 'set_filter', panel: 'files', text: '' }));

  const itemsA = api.getItems(A.paneId).map((i) => i.name);
  const itemsB = api.getItems(B.paneId).map((i) => i.name);

  assert(itemsA.length > 0, `A (${A.root}) loaded rows (${itemsA.length})`);
  assert(itemsB.length > 0, `B (${B.root}) loaded rows (${itemsB.length})`);
  assert(JSON.stringify(itemsA) !== JSON.stringify(itemsB),
    'A and B hold different listings (pre-spine they were identical)');

  report();
})().catch((err) => { console.error(err); process.exit(1); });
