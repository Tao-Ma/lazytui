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
const { rebuildLayoutFromConfig } = require('../leaves/wm/arrange');
const mpool = require('../leaves/wm/pool');
const mpane = require('../leaves/wm/pane');
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
  // U2f — a CONTENT slot (`role:'content'`) is no longer a length-1 singleton:
  // rebuildLayoutFromConfig seeds it with two transient tabs (Info ACTIVE by
  // default, Transcript) and NO `detail` tab (that Component was deleted). Its
  // legacy identity (`pane.id`/`type`/`title`) stays the STABLE slot identity
  // ('detail'/'detail'/'Detail'), decoupled from the active tab's kind, and
  // `activeTabId` is `info-<paneId>`. Assert that seeded shape here; every other
  // pane stays the Phase-1 singleton.
  if (p.role === 'content') {
    assertContentSlotShape(p, where);
    return;
  }
  assert(Array.isArray(p.tabs) && p.tabs.length === 1, `${where}: tabs is length-1 array (Phase 1)`);
  assert(typeof p.activeTabId === 'string' && p.activeTabId === p.tabs[0].id,
    `${where}: activeTabId === tabs[0].id`);
  eq(p.tabs[0].id, p.id, `${where}: tab.id === panel.id (Phase 1 singleton)`);
  eq(p.tabs[0].poolId, p.id, `${where}: tab.poolId === panel.id (Phase 1 singleton)`);
  // Legacy Panel fields preserved
  assert(typeof p.id === 'string', `${where}: legacy id present`);
  assert(typeof p.type === 'string', `${where}: legacy type present`);
  assert(typeof p.columnIndex === 'number', `${where}: columnIndex present`);
}

// The seeded content slot (U2f): role='content' is the stable slot marker. tabs =
// [info-<paneId> (active), transcript-<paneId>] — NO `detail` tab. The legacy
// identity (id/type/title) is the STABLE slot identity ('detail'/'detail'/'Detail'),
// preserved by pane._rebuildLegacyFields across tab switches — it does NOT mirror
// the active tab's kind. activeTabId = info-<paneId>.
function assertContentSlotShape(p, where) {
  eq(p.role, 'content', `${where}: content slot identity is role`);
  const infoId = `info-${p.paneId}`;
  const transId = `transcript-${p.paneId}`;
  assert(Array.isArray(p.tabs) && p.tabs.length === 2,
    `${where}: content slot has 2 seeded tabs [info, transcript] (got ${p.tabs && p.tabs.length})`);
  eq(p.tabs.map(t => t.poolId).join(','), `${infoId},${transId}`,
    `${where}: seeded tab poolIds in order`);
  eq(p.activeTabId, infoId, `${where}: Info is the default active tab`);
  eq(p.type, 'detail', `${where}: legacy type is the STABLE slot identity, not the active tab kind`);
  eq(p.id, 'detail', `${where}: legacy id is the STABLE slot identity`);
  assert(typeof p.columnIndex === 'number', `${where}: columnIndex present`);
}

describe('[parser] buildPlacedPanel + defaultLayout addDefault produce panes', () => {
  it('explicit layout produces panes', () => {
    const p = tmpYaml(`${TRIVIAL}
panels:
  groups:  { type: groups }
  actions: { type: actions }
  detail:  { type: detail }
layout:
  columns:
    - panels:
        - groups
    - panels:
        - actions
        - detail
`);
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    for (const pane of arrange.columns[0].panels)  assertPaneShape(pane, `col0/${pane.type}`);
    for (const pane of arrange.columns[1].panels)  assertPaneShape(pane, `col1/${pane.type}`);
  });

  it('default layout (no layout: block) produces panes', () => {
    const p = tmpYaml(TRIVIAL);
    const cfg = parse(p);
    const arrange = rebuildLayoutFromConfig(cfg);
    assert(arrange.columns[0].panels.length >= 1, 'has at least one pane in first column');
    assert(arrange.columns[1].panels.length >= 2, 'has at least two panes in last column');
    for (const pane of arrange.columns[0].panels)  assertPaneShape(pane, `default/col0/${pane.type}`);
    for (const pane of arrange.columns[1].panels)  assertPaneShape(pane, `default/col1/${pane.type}`);
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
    for (const pane of arrange.columns[0].panels)  assertPaneShape(pane, `fallback/col0/${pane.type}`);
    for (const pane of arrange.columns[1].panels)  assertPaneShape(pane, `fallback/col1/${pane.type}`);
  });
});

describe('[leaves/pool] placementFromPoolEntry produces a pane', () => {
  it('placement carries paneId / tabs / activeTabId', () => {
    const entry = { id: 'notes', type: 'notes', title: 'Notes', config: { source: 'inline' } };
    const placement = mpool.placementFromPoolEntry(entry, 0);
    assertPaneShape(placement, 'placementFromPoolEntry');
    eq(placement.columnIndex, 0, 'columnIndex threaded');
    eq(placement.source, 'inline', 'config spread preserved');
  });
});

describe('[panel/layout] pool_show inserts a pane', () => {
  it('inserts a pane shape into the first column', () => {
    // Hand-build a layout slice with a hidden pool entry.
    const arrange = {
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [] },
        { panels: [
          mpane.wrapAsPane({ id: 'detail', type: 'detail', title: 'Detail', hotkey: '8', columnIndex: 1 },
            mpane.newPaneId('detail')),
        ] },
      ],
      pool: {
        notes: { id: 'notes', type: 'notes', title: 'Notes', config: {} },
        detail: { id: 'detail', type: 'detail', title: 'Detail', config: {} },
      },
    };
    const slice = { ...layout.init(), arrange };
    const result = layout.update({ type: 'pool_show', id: 'notes', columnIndex: 0, index: 0 }, slice);
    const next = Array.isArray(result) ? result[0] : result;
    const inserted = next.arrange.columns[0].panels[0];
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
});

report();
