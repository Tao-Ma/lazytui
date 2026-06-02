/**
 * v0.6.1 Phase 1 — arrange entries are panes wrapping one tab.
 *
 * Pins the construction-site invariant: every panel produced by the
 * parser, by leaves/arrange.rebuildLayoutFromConfig (both branches), by
 * leaves/pool.placementFromPoolEntry, and by panel/layout's pool_show
 * Msg carries the Pane fields (paneId, tabs, activeTabId) alongside
 * the legacy Panel fields (id, type, hotkey, column, ...).
 *
 *   node js/test/test-pane-shape.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, eq, assert, report } = require('./test-runner');
const { parse } = require('../parser');
const { rebuildLayoutFromConfig } = require('../leaves/arrange');
const mpool = require('../leaves/pool');
const mpane = require('../leaves/pane');
const layout = require('../panel/layout');

let _tmpDir = null;
function tmpYaml(content, name = 'test.yml') {
  if (!_tmpDir) _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-pane-shape-'));
  const p = path.join(_tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const TRIVIAL = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
`;

function assertPaneShape(p, where) {
  // Pane fields
  assert(typeof p.paneId === 'string' && p.paneId.length > 0, `${where}: paneId is non-empty string`);
  assert(p.paneId.startsWith('pane-'), `${where}: paneId starts with 'pane-' (got ${p.paneId})`);
  assert(Array.isArray(p.tabs) && p.tabs.length === 1, `${where}: tabs is length-1 array (Phase 1)`);
  assert(typeof p.activeTabId === 'string' && p.activeTabId === p.tabs[0].id,
    `${where}: activeTabId === tabs[0].id`);
  eq(p.tabs[0].id, p.id, `${where}: tab.id === panel.id (Phase 1 singleton)`);
  eq(p.tabs[0].poolId, p.id, `${where}: tab.poolId === panel.id (Phase 1 singleton)`);
  // Legacy Panel fields preserved
  assert(typeof p.id === 'string', `${where}: legacy id present`);
  assert(typeof p.type === 'string', `${where}: legacy type present`);
  assert(typeof p.column === 'string', `${where}: column present`);
}

describe('[parser] buildPlacedPanel + defaultLayout addDefault produce panes', () => {
  it('explicit layout produces panes', () => {
    const p = tmpYaml(`${TRIVIAL}
panels:
  groups:  { type: groups }
  actions: { type: actions }
  detail:  { type: detail }
layout:
  left:
    panels:
      - groups
  right:
    panels:
      - actions
      - detail
`);
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    for (const pane of arrange.leftPanels)  assertPaneShape(pane, `left/${pane.type}`);
    for (const pane of arrange.rightPanels) assertPaneShape(pane, `right/${pane.type}`);
  });

  it('default layout (no layout: block) produces panes', () => {
    const p = tmpYaml(TRIVIAL);
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    assert(arrange.leftPanels.length >= 1, 'has at least one left pane');
    assert(arrange.rightPanels.length >= 2, 'has at least two right panes');
    for (const pane of arrange.leftPanels)  assertPaneShape(pane, `default/left/${pane.type}`);
    for (const pane of arrange.rightPanels) assertPaneShape(pane, `default/right/${pane.type}`);
  });
});

describe('[leaves/arrange] rebuildLayoutFromConfig no-layout JSON fallback produces panes', () => {
  it('JSON-style config with no layout: block', () => {
    // The fallback path expects config.groups and optionally config.files.
    // Bypass parser by passing a minimal hand-built config.
    const cfg = {
      groups: { g: { label: 'G', actions: { a: { cmd: 'echo', label: 'A' } } } },
      // no .layout — exercises the inner-else branch with the `push` helper
    };
    const arrange = rebuildLayoutFromConfig(cfg);
    for (const pane of arrange.leftPanels)  assertPaneShape(pane, `fallback/left/${pane.type}`);
    for (const pane of arrange.rightPanels) assertPaneShape(pane, `fallback/right/${pane.type}`);
  });
});

describe('[leaves/pool] placementFromPoolEntry produces a pane', () => {
  it('placement carries paneId / tabs / activeTabId', () => {
    const entry = { id: 'notes', type: 'notes', title: 'Notes', config: { source: 'inline' } };
    const placement = mpool.placementFromPoolEntry(entry, 'left');
    assertPaneShape(placement, 'placementFromPoolEntry');
    eq(placement.column, 'left', 'column threaded');
    eq(placement.source, 'inline', 'config spread preserved');
  });
});

describe('[panel/layout] pool_show inserts a pane', () => {
  it('inserts a pane shape into leftPanels', () => {
    // Hand-build a layout slice with a hidden pool entry.
    const arrange = {
      leftWidth: 30,
      detailHeightPct: 60,
      leftPanels: [],
      rightPanels: [
        mpane.wrapAsPane({ id: 'detail', type: 'detail', title: 'Detail', hotkey: '8', column: 'right' },
          mpane.newPaneId('detail')),
      ],
      pool: {
        notes: { id: 'notes', type: 'notes', title: 'Notes', config: {} },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const slice = { ...layout.init(), arrange };
    const result = layout.update({ type: 'pool_show', id: 'notes', column: 'left', index: 0 }, slice);
    const next = Array.isArray(result) ? result[0] : result;
    const inserted = next.arrange.leftPanels[0];
    assertPaneShape(inserted, 'pool_show');
    eq(inserted.id, 'notes', 'inserted pool id');
    eq(inserted.type, 'notes', 'inserted type');
  });
});

describe('[leaves/pane] helpers', () => {
  it('newPaneId formats as pane-<poolId>', () => {
    eq(mpane.newPaneId('groups'), 'pane-groups', 'simple');
    eq(mpane.newPaneId('my-custom'), 'pane-my-custom', 'with dashes');
  });

  it('firstTab returns the singleton tab', () => {
    const p = mpane.wrapAsPane({ id: 'g', type: 'groups' }, 'pane-g');
    const t = mpane.firstTab(p);
    eq(t.id, 'g', 'tab id');
    eq(t.poolId, 'g', 'pool id');
  });

  it('paneKind returns the pane type (Phase 1: reads .type directly)', () => {
    const p = mpane.wrapAsPane({ id: 'h', type: 'history' }, 'pane-h');
    eq(mpane.paneKind(p), 'history');
  });

  it('activePoolId returns the active tab pool id', () => {
    const p = mpane.wrapAsPane({ id: 'f', type: 'files' }, 'pane-f');
    eq(mpane.activePoolId(p), 'f');
  });

  it('firstTab / paneKind tolerate missing input (no throw, falsy return)', () => {
    assert(!mpane.firstTab(null), 'firstTab(null) is falsy');
    assert(!mpane.firstTab({}),   'firstTab({}) is falsy (no tabs field)');
    assert(!mpane.paneKind(null), 'paneKind(null) is falsy');
    assert(!mpane.activePoolId(null), 'activePoolId(null) is falsy');
    assert(!mpane.activePoolId({}),   'activePoolId({}) is falsy');
  });
});

report();
