/**
 * Render idempotence — every plugin's render(panel, w, h, S) called twice
 * with the same inputs produces the same output. Discipline articulated in
 * docs/PRINCIPLES.md §11.
 *
 * The test exercises representative core plugin renderers (groups, actions,
 * detail, file-manager, history). Docker + stats + config-status are
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
const { S, recomputeGroups } = require('../state');
const { setTheme } = require('../themes');
const groups = require('../plugins/core/groups');
const actions = require('../plugins/core/actions');
const detail = require('../plugins/core/detail');
const files = require('../plugins/core/files');  // array-mod; file-manager alias is files[1]
const fileManager = files.find(e => e.panelType === 'file-manager');
const history = require('../plugins/core/history');

// --- Minimal state setup — just enough that every render under test can
// resolve its inputs without throwing. ---

function setupState() {
  setTheme('monokai');
  S.config = {
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
  S.expandedGroups = new Set();
  S.groupsTab = 'all';
  S.sel = { groups: 0, actions: 0, 'file-manager': 0, history: 0, detail: 0 };
  S.scroll = { groups: 0, actions: 0, 'file-manager': 0, history: 0 };
  S.multiSel = {};
  S.filters = {};
  S.currentGroup = '';
  recomputeGroups();
  S.currentGroup = S.groups[0].name;
  S.focus = 'groups';
  S.lastRunAction = '';
  S.detailLines = ['[bold]Detail title[/]', '', 'body line 1', 'body line 2'];
  S.detailScroll = 0;
  S.activeTab = 0;
  S.history = [];
  S.layout = {
    leftWidth: 30,
    leftPanels: [],
    rightPanels: [],
    detailHeightPct: 60,
  };
  S.panelHeights = {};
  S.panelBounds = {};
}

// Plugins export their render via def.render (mode: 'list' / 'content' / ...).
const cases = [
  { name: 'groups',       fn: groups.def.render,      panel: { type: 'groups',       title: 'Groups',    hotkey: '1' } },
  { name: 'actions',      fn: actions.def.render,     panel: { type: 'actions',      title: 'Actions',   hotkey: '7' } },
  { name: 'detail',       fn: detail.def.render,      panel: { type: 'detail',       title: 'Detail',    hotkey: '8', tabs: [{ label: 'Info' }] } },
  { name: 'file-manager', fn: fileManager.def.render, panel: { type: 'file-manager', title: 'Files',     hotkey: '2' } },
  { name: 'history',      fn: history.def.render,     panel: { type: 'history',      title: 'History',   hotkey: '3' } },
];

describe('render idempotence — same state, twice', () => {
  setupState();
  for (const c of cases) {
    it(`${c.name}.render twice produces identical output`, () => {
      const r1 = c.fn(c.panel, 30, 10, S);
      const r2 = c.fn(c.panel, 30, 10, S);
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
      S.focus = c.name;
      const focusedA = c.fn(c.panel, 30, 10, S);
      const focusedB = c.fn(c.panel, 30, 10, S);
      eq(focusedA, focusedB, `focused output stable for ${c.name}`);

      S.focus = 'somewhere-else';
      const unfocusedA = c.fn(c.panel, 30, 10, S);
      const unfocusedB = c.fn(c.panel, 30, 10, S);
      eq(unfocusedA, unfocusedB, `unfocused output stable for ${c.name}`);
    });
  }
});

report();
