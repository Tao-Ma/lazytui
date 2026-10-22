/**
 * Groups navigator — a single mouse click SELECTS the clicked group row (sets
 * model.currentGroup), so every currentGroup-scoped pane (notably the Actions
 * navigator, a pure projection of getMergedActions(currentGroup)) follows a
 * click, matching keyboard Enter.
 *
 * Regression guard for a report that a single click only moved the cursor
 * (never firing nav_select), so clicking a leaf group never activated it. The
 * real click path already routes press → intent.selectAt → dispatch.navSelect →
 * `nav_select` → (groups branch) `groups_selected` → set_current_group
 * (input.js body arm + reducer.js nav_select arm). This pins that wiring
 * end-to-end through the real render + hit-test geometry — the groups-click path
 * had NO test before.
 *
 * Geometry: handleMouse takes 1-based SGR coords (mx = x - 1); the body hit-test
 * (_rowIndexAt) then drops the top border, so list item `i` sits under a click
 * at y = b.y + 2 + i.
 *
 * Why one boot for the whole describe (not per-it): repeated bootFresh re-mints
 * the per-pane instances, and every OTHER re-mint leaves nav_select routing to a
 * stale instance (a test-harness re-mint parity artifact — NOT an app behavior;
 * the real app boots once). So we boot once and walk the interaction in order,
 * which is also the faithful real-app model (one boot, many clicks). Do not
 * convert this to a per-it boot() or it will flake.
 *
 * Run: node js/test/test-groups-click.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const navState = require('../panel/nav-state');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');
const { getModel } = require('../model/store');

// A config.groups node in parser-output shape (map keyed by group path).
const G = (name, label, o) => ({
  name, label, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false, ...o,
});

// Nested tree mirroring the bug report: Config (parent) › Branch sync (leaf,
// carries its own actions) + Gitea data (leaf).
const GROUPS = {
  config: G('config', 'Config', { children: ['config.branch', 'config.gitea'] }),
  'config.branch': G('config.branch', 'Branch sync', {
    parent: 'config', depth: 1,
    actions: {
      save: { label: 'Save', script: 'echo s' },
      load: { label: 'Load', script: 'echo l' },
      'check-stale': { label: 'Check stale', script: 'echo c' },
    },
  }),
  'config.gitea': G('config.gitea', 'Gitea data', { parent: 'config', depth: 1 }),
};

const groupsPane = { id: 'groups', type: 'groups', title: 'Groups' };
const detailPane = { id: 'd', type: 'detail', title: 'Out' };

function gPane() {
  const ls = api.getInstanceSlice('layout');
  const p = mpool.allPanesInColumns(ls.arrange).find((x) => x.type === 'groups');
  return { paneId: p.paneId, b: geo.visibleBoundsFor(ls, p.paneId, route.resolveViewerPaneId()) };
}

// Click the body of visible list row `idx` in the groups pane.
function clickRow(idx) {
  const { b } = gPane();
  sm.capture(() => sm.handleMouse('press', b.x + 3, b.y + 2 + idx));
}

describe('[groups-click] a single click selects the clicked group row', () => {
  // One boot for the whole block (see header note) — paint a frame (publishes
  // select-view for the hit-test), expand the parent so the leaves are visible,
  // repaint. bootFresh anchors currentGroup to the first group key ('config').
  sm.bootFresh({
    groups: GROUPS,
    layout: { pool: { groups: groupsPane, d: detailPane },
              columns: [{ panels: [groupsPane] }, { panels: [detailPane] }] },
  });
  sm.resize(120, 30);
  sm.capture(() => sm.render());
  sm.capture(() => navState.expandGroup('config'));
  sm.capture(() => sm.render());
  const { paneId } = gPane();

  it('expands to leaves and currentGroup starts at the parent', () => {
    eq(api.getItems(paneId).map((g) => g.name), ['config', 'config.branch', 'config.gitea'], 'tree flattened after expand');
    eq(getModel().currentGroup, 'config', 'currentGroup anchored at the parent');
  });

  it('single-clicking a LEAF row sets currentGroup to that leaf', () => {
    clickRow(1);                                         // "Branch sync" (config.branch)
    eq(getModel().currentGroup, 'config.branch', 'currentGroup followed the click');
    eq(navState.getSel(paneId), 1, 'cursor moved onto the clicked row');
  });

  it('the Actions projection (getMergedActions) follows the click', () => {
    // currentGroup is config.branch from the prior click.
    eq(Object.keys(api.getMergedActions(getModel().currentGroup)), ['save', 'load', 'check-stale'],
       'Actions pane would render the leaf-group actions');
  });

  it('clicking a second leaf switches currentGroup again', () => {
    clickRow(2);                                         // config.gitea
    eq(getModel().currentGroup, 'config.gitea', 'currentGroup switched to the second leaf');
  });

  it('clicking a BRANCH row body selects it without collapsing the tree', () => {
    clickRow(0);                                         // click the "Config" branch row body
    eq(getModel().currentGroup, 'config', 'branch body-click selects the branch');
    eq(api.getItems(paneId).map((g) => g.name), ['config', 'config.branch', 'config.gitea'],
       'tree stays expanded — body-click selects, only the ▾/▸ marker toggles');
  });
});

report();
