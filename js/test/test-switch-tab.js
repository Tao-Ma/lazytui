/**
 * v0.6.1 — `:switch-tab <pool-id>` cmdline verb + `set_active_tab`
 * layout-reducer Msg.
 *
 * Pins the runtime active-tab flip:
 *   - reducer rewrites legacy Panel fields (id/type/title/config + spread)
 *     from the new active tab's pool entry; preserves placement-only
 *     fields (paneId, tabs, hotkey, column, heightPct, collapsed).
 *   - refuses unknown pane / tab not in pane.tabs / unknown pool id.
 *   - idempotent no-op when target is already active.
 *
 *   node js/test/test-switch-tab.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const layout = require('../panel/layout');

// Build a layout slice with a multi-tab pane. The pane carries the
// wide-form fields the parser emits (paneId, tabs[], activeTabId) +
// the legacy Panel fields (id/type/title/config) mirroring the active
// tab's pool entry.
function buildMultiTabSlice() {
  const pool = {
    groups:  { id: 'groups',  type: 'groups',  title: 'Groups',  config: {} },
    docker:  { id: 'docker',  type: 'docker',  title: 'Docker',  config: { decorators: ['status'] } },
    logs:    { id: 'logs',    type: 'viewer',  title: 'Logs',    config: { source: 'stream' } },
    actions: { id: 'actions', type: 'actions', title: 'Actions', config: {} },
    detail:  { id: 'detail',  type: 'detail',  title: 'Detail',  config: {} },
  };
  const multiTabPane = {
    // legacy fields mirror the active tab (docker)
    id: 'docker', type: 'docker', title: 'Docker',
    hotkey: '1', columnIndex: 0,
    config: pool.docker.config,
    decorators: ['status'],   // spread from docker.config
    // pane fields
    paneId: 'pane-docker', tabs: [{ id: 'docker', poolId: 'docker' }, { id: 'logs', poolId: 'logs' }],
    activeTabId: 'docker',
    heightPct: 50,
  };
  const groupsPane = {
    id: 'groups', type: 'groups', title: 'Groups',
    hotkey: '2', columnIndex: 0,
    config: pool.groups.config,
    paneId: 'pane-groups', tabs: [{ id: 'groups', poolId: 'groups' }], activeTabId: 'groups',
  };
  const actionsPane = {
    id: 'actions', type: 'actions', title: 'Actions',
    hotkey: '7', columnIndex: 1,
    config: pool.actions.config,
    paneId: 'pane-actions', tabs: [{ id: 'actions', poolId: 'actions' }], activeTabId: 'actions',
  };
  const detailPane = {
    id: 'detail', type: 'detail', title: 'Detail',
    hotkey: '8', columnIndex: 1,
    config: pool.detail.config,
    paneId: 'pane-detail', tabs: [{ id: 'detail', poolId: 'detail' }], activeTabId: 'detail',
  };
  return {
    ...layout.init(),
    arrange: {
      detailHeightPct: 60,
      pool,
      columns: [
        { width: 30, panels: [multiTabPane, groupsPane] },
        { panels: [actionsPane, detailPane] },
      ],
    },
  };
}

describe('[set_active_tab] flips active tab + rewrites legacy fields', () => {
  it('switches docker → logs in a multi-tab pane', () => {
    const slice = buildMultiTabSlice();
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs',
    }, slice);
    const pane = next.arrange.columns[0].panels[0];
    eq(pane.activeTabId, 'logs',         'activeTabId points at logs');
    eq(pane.id,          'logs',          'legacy id mirrors new active');
    eq(pane.type,        'viewer',        'legacy type mirrors new active kind');
    eq(pane.title,       'Logs',          'legacy title mirrors new active');
    eq(pane.config.source, 'stream',      'config carries new active config');
    eq(pane.source,        'stream',      'config keys spread onto pane');
    assert(!('decorators' in pane),       'old active config keys cleared on rewrite');
    eq(pane.paneId,    'pane-docker',     'paneId preserved (placement identity)');
    eq(pane.hotkey,    '1',                'hotkey preserved');
    eq(pane.columnIndex, 0,                 'columnIndex preserved');
    eq(pane.heightPct, 50,                 'heightPct preserved');
    eq(pane.tabs.length, 2,                'tabs list preserved');
    assert(next.dirty,                     'arrange marked dirty');
  });

  it('idempotent — switching to already-active tab returns slice unchanged', () => {
    const slice = buildMultiTabSlice();
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'docker',
    }, slice);
    eq(next, slice, 'reference-equal no-op when target already active');
  });

  it('preserves the OTHER panes in the layout', () => {
    const slice = buildMultiTabSlice();
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs',
    }, slice);
    eq(next.arrange.columns[0].panels[1], slice.arrange.columns[0].panels[1],  'groups pane unchanged');
    eq(next.arrange.columns[1].panels[0], slice.arrange.columns[1].panels[0], 'actions pane unchanged');
    eq(next.arrange.columns[1].panels[1], slice.arrange.columns[1].panels[1], 'detail pane unchanged');
  });
});

describe('[set_active_tab] focus follow', () => {
  it('retargets focus + emits show_selected_info when switched pane is focused (by pane.id)', () => {
    const slice = { ...buildMultiTabSlice(), focus: 'docker' };  // focus on pane's active tab
    const result = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs',
    }, slice);
    assert(Array.isArray(result), 'returns [slice, cmds]');
    const [next, cmds] = result;
    eq(next.arrange.columns[0].panels[0].activeTabId, 'logs', 'pane switched');
    eq(next.focus, 'logs', 'focus retargeted inline to new active tab id (R4.7)');
    assert(cmds.some(c => c.type === 'show_selected_info'),
      'show_selected_info Cmd emitted');
  });
  it('retargets focus when focused by paneId (pane-tabs producer path)', () => {
    const slice = { ...buildMultiTabSlice(), focus: 'pane-docker' };
    const result = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs',
    }, slice);
    assert(Array.isArray(result), 'cmds present');
    const [next, cmds] = result;
    eq(next.focus, 'logs', 'focus retargeted via paneId path');
    assert(cmds.some(c => c.type === 'show_selected_info'),
      'show_selected_info Cmd emitted');
  });
  it('does NOT emit focus_set when another pane is focused', () => {
    const slice = { ...buildMultiTabSlice(), focus: 'groups' };
    const result = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs',
    }, slice);
    // Returned as bare slice (no cmds) — switching a non-focused pane
    // doesn't disturb the user's current focus.
    assert(!Array.isArray(result), 'returns bare slice (no focus follow needed)');
    eq(result.arrange.columns[0].panels[0].activeTabId, 'logs', 'switch still applied');
  });
});

describe('[set_active_tab] refusal paths', () => {
  it('unknown pane → no-op', () => {
    const slice = buildMultiTabSlice();
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-ghost', tabPoolId: 'logs',
    }, slice);
    eq(next, slice);
  });
  it('tab not in pane.tabs → no-op', () => {
    const slice = buildMultiTabSlice();
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'groups',
    }, slice);
    eq(next, slice);
  });
  it('unknown pool id → no-op', () => {
    const slice = buildMultiTabSlice();
    // forge a tab list entry that the pool doesn't define
    slice.arrange.columns[0].panels[0].tabs.push({ id: 'phantom', poolId: 'phantom' });
    const next = layout.update({
      type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'phantom',
    }, slice);
    eq(next, slice);
  });
  it('missing paneId / tabPoolId → no-op', () => {
    const slice = buildMultiTabSlice();
    eq(layout.update({ type: 'set_active_tab' }, slice), slice);
    eq(layout.update({ type: 'set_active_tab', paneId: 'pane-docker' }, slice), slice);
    eq(layout.update({ type: 'set_active_tab', tabPoolId: 'logs' }, slice), slice);
  });
});

describe('[end-to-end] parse multi-tab YAML → switch active tab', () => {
  it('parses {tabs: [a, b]} layout, switches activeTabId at runtime', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { parse } = require('../parser');
    const { rebuildLayoutFromConfig } = require('../leaves/arrange');
    const yaml = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
panels:
  docker: { type: docker, title: Docker }
  logs:   { type: viewer, title: Logs }
  groups: { type: groups, title: Groups }
  actions: { type: actions, title: Actions }
  detail:  { type: detail,  title: Detail }
layout:
  columns:
    - panels:
        - { tabs: [docker, logs] }
        - groups
    - panels:
        - actions
        - detail
`;
    const tmp = path.join(os.tmpdir(), `lazytui-switch-tab-${process.pid}.yml`);
    fs.writeFileSync(tmp, yaml);
    let cfg;
    try { cfg = parse(tmp); } finally { fs.unlinkSync(tmp); }
    const arrange = rebuildLayoutFromConfig(cfg);
    const initialPane = arrange.columns[0].panels[0];
    eq(initialPane.activeTabId, 'docker',  'starts on tabs[0] (no activeTab override)');
    eq(initialPane.type,        'docker',  'legacy type mirrors docker');

    const slice = { ...layout.init(), arrange };
    const next = layout.update({
      type: 'set_active_tab', paneId: initialPane.paneId, tabPoolId: 'logs',
    }, slice);
    const swappedPane = next.arrange.columns[0].panels[0];
    eq(swappedPane.activeTabId, 'logs',    'flipped to logs');
    eq(swappedPane.type,        'viewer',  'legacy type follows the kind switch');
    eq(swappedPane.title,       'Logs',     'title follows the switch');
  });

  it('round-trip — serializer emits the new activeTab on save', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { parse } = require('../parser');
    const { rebuildLayoutFromConfig } = require('../leaves/arrange');
    const { serializeLayout, writeLayoutToFile } = require('../feature/yaml-layout');
    const yaml = `groups:
  g: { label: G, actions: { a: { cmd: 'echo', label: A } } }
panels:
  docker: { type: docker, title: Docker }
  logs:   { type: viewer, title: Logs }
  actions: { type: actions, title: Actions }
  detail:  { type: detail,  title: Detail }
layout:
  columns:
    - panels:
        - { tabs: [docker, logs] }
    - panels:
        - actions
        - detail
`;
    const tmp = path.join(os.tmpdir(), `lazytui-switch-rt-${process.pid}.yml`);
    fs.writeFileSync(tmp, yaml);
    const cfg = parse(tmp);
    const arrange = rebuildLayoutFromConfig(cfg);
    const slice = { ...layout.init(), arrange };
    const next = layout.update({
      type: 'set_active_tab', paneId: arrange.columns[0].panels[0].paneId, tabPoolId: 'logs',
    }, slice);
    const out = serializeLayout(next.arrange);
    assert(out.includes('tabs: [docker, logs]'),     'tab order preserved');
    assert(out.includes('activeTab: logs'),           'new active tab serialized');
    // Write back to disk + re-parse → activeTabId survives.
    writeLayoutToFile(next.arrange, tmp);
    const cfg2 = parse(tmp);
    fs.unlinkSync(tmp);
    const arrange2 = rebuildLayoutFromConfig(cfg2);
    eq(arrange2.columns[0].panels[0].activeTabId, 'logs',    'activeTab round-trips');
  });
});

report();
