/**
 * Render idempotence — every plugin's render(panel, w, h, S) called twice
 * with the same inputs produces the same output. Discipline articulated in
 * docs/PRINCIPLES.md §11.
 *
 * The test exercises representative core plugin renderers (groups, actions,
 * detail, history). Docker + stats + config-status are
 * deliberately skipped here:
 *
 *   - docker.render reads a runtime status cache fed by container events;
 *     setting that up isn't render's concern.
 *   - stats.render lazy-subscribes to the hub on first call (idempotent
 *     but not pure — see PRINCIPLES.md §11). Verifying its idempotence
 *     needs hub setup; covered separately by test-stats.js.
 *   - config-status.render writes S.configStatusBranch on first call
 *     (idempotent lazy-init). Same story.
 *
 * Run: node js/test/test-render-idempotent.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');

const { recomputeGroups } = require('../app/state');
const { setTheme } = require('../render/themes');
const groups = require('../panel/navigator/groups');
const actions = require('../panel/navigator/actions');
const detail = require('../panel/viewer/viewer');
const history = require('../panel/navigator/history');

// --- Minimal state setup — just enough that every render under test can
// resolve its inputs without throwing. ---

function setupState() {
  setTheme('monokai');
  getModel().config = {
    project_dir: '.',
    files: [
      { path: 'a.txt', desc: 'first file', category: 'config' },
      { path: 'b.txt', desc: 'second file', category: 'secret' },
    ],
    groups: {
      'g1': {
        name: 'g1', label: 'Group 1', containers: [],
        actions: {
          'a1': { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false },
          'a2': { key: 'a2', label: 'Action 2', type: 'spawn', script: 'echo a2', tab: false },
        },
        children: [], parent: null, depth: 0, quick: false,
      },
      'g2': {
        name: 'g2', label: 'Group 2', containers: [],
        actions: {
          'b1': { key: 'b1', label: 'B', type: 'run', script: 'echo b', tab: false },
        },
        children: [], parent: null, depth: 0, quick: false,
      },
    },
  };
  getInstanceSlice('groups').expanded = new Set();
  getInstanceSlice('groups').tab = 'all';
  // Phase 4a — `ui.sel` / `ui.scroll` / `ui.multiSel` retired (each Navigator
  // owns its own `nav` slice). Only `ui.filters` survives at root.
  getModel().currentGroup = '';
  recomputeGroups();
  getModel().currentGroup = getInstanceSlice('groups').list[0].name;
  getInstanceSlice("layout").focus = 'groups';
  getInstanceSlice('detail').lines = ['[bold]Detail title[/]', '', 'body line 1', 'body line 2'];
  getInstanceSlice('detail').scroll = 0;
  getInstanceSlice('detail').tab = 0;
  // history Component holds its ring buffer in its own module (../history.js),
  // not on a shim field; no init needed here.
  getInstanceSlice("layout").arrange = {
    columns: [
      { width: 30, panels: [] },
      { panels: [] },
    ],
    detailHeightPct: 60,
  };
  getInstanceSlice('layout').paneBounds = {};
}

// Plugin panels export def via { panelType, def }; Component panels expose
// def via panelTypes[panelType]. Resolve uniformly here so the test doesn't
// need to track each panel's API shape.
function _resolveDef(mod, panelType) {
  if (mod.def) return mod.def;                                  // Plugin shape
  if (mod.panelTypes && mod.panelTypes[panelType]) return mod.panelTypes[panelType]; // Component shape
  throw new Error(`no def for ${panelType}`);
}
const cases = [
  { name: 'groups',       fn: _resolveDef(groups,      'groups').render,       panel: { type: 'groups',       title: 'Groups',    hotkey: '1' } },
  { name: 'actions',      fn: _resolveDef(actions,     'actions').render,      panel: { type: 'actions',      title: 'Actions',   hotkey: '7' } },
  { name: 'detail',       fn: _resolveDef(detail,      'detail').render,       panel: { type: 'detail',       title: 'Detail',    hotkey: '8', tabs: [{ label: 'Info' }] } },
  { name: 'history',      fn: _resolveDef(history,     'history').render,      panel: { type: 'history',      title: 'History',   hotkey: '3' } },
];

// All panels are Components now — render takes its own slice (resolved from
// the global Component registry; auto-registers via the S shim path if needed).
function _renderArg(name) {
  return require('../panel/api').getInstanceSlice(name);
}

describe('render idempotence — same state, twice', () => {
  setupState();
  for (const c of cases) {
    it(`${c.name}.render twice produces identical output`, () => {
      const arg = _renderArg(c.name);
      const r1 = c.fn(c.panel, 30, 10, arg);
      const r2 = c.fn(c.panel, 30, 10, arg);
      eq(r1, r2, `second ${c.name}.render output matches first`);
    });
  }
});

describe('render idempotence — focus toggled between calls', () => {
  setupState();
  for (const c of cases) {
    it(`${c.name}.render is deterministic per focus state`, () => {
      // Render twice while focused, then twice while unfocused. Each pair
      // should be internally identical (focus is the input state, not a
      // side effect render writes).
      const arg = _renderArg(c.name);
      getInstanceSlice("layout").focus = c.name;
      const focusedA = c.fn(c.panel, 30, 10, arg);
      const focusedB = c.fn(c.panel, 30, 10, arg);
      eq(focusedA, focusedB, `focused output stable for ${c.name}`);

      getInstanceSlice("layout").focus = 'somewhere-else';
      const unfocusedA = c.fn(c.panel, 30, 10, arg);
      const unfocusedB = c.fn(c.panel, 30, 10, arg);
      eq(unfocusedA, unfocusedB, `unfocused output stable for ${c.name}`);
    });
  }
});

report();
