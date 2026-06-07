/**
 * v0.6.2 — plugin-synthesized `tab: true` actions must surface in the
 * tab system.
 *
 * Pins the bug fix for the postgres-demo `pg:status` symptom: an
 * action contributed by a Component's `groupActions(group, name,
 * config, model)` that carries `tab: true` was invisible to
 * `flatTabInfo.actionTabs` (pre-fix only read YAML actions
 * directly) — and so:
 *   - the tab strip didn't show it
 *   - `stream_start` auto-jump found idx=-1 and skipped the jump
 *   - `viewer_append`'s active-tab mirror gate (via
 *     activeActionTabIn → flatTabInfo) never matched, leaving output
 *     stranded in `slice.actionTabBuffers` with no visible surface
 *
 * The fix (panel/api.getMergedActions + pane-tabs.js _mergedFor) makes
 * the merged set the single source of truth for every reader.
 *
 * Run: node js/test/test-plugin-tab.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const api = require('../panel/api');
const viewer = require('../panel/viewer/viewer');
const pt = require('../leaves/pane-tabs');
const { setModel, getModel } = require('../app/runtime');

// Synthetic Component that contributes a tab:true action when the
// group declares `compose-ish: true`. Mirrors the shape of the
// docker plugin's auto-`status` (the live source of the bug).
const fakePlugin = {
  name: 'fake-tabber',
  init: () => ({}),
  update: (_msg, slice) => slice,
  groupActions: (group, _name, _config, _model) => {
    if (!group || !group['compose-ish']) return {};
    return {
      'plugin-status': {
        type: 'run', label: 'Status', script: 'echo plugin', tab: true,
      },
    };
  },
};

setModel({
  currentGroup: 'g',
  modes: {},
  config: {
    groups: {
      g: {
        label: 'G',
        'compose-ish': true,
        actions: {
          'yaml-build': { label: 'Build', script: 'echo build', tab: true },
          'yaml-no-tab': { label: 'NoTab', script: 'echo notab' },
        },
      },
    },
  },
});

api.registerComponent(require('../panel/layout'));
api.registerComponent(fakePlugin);
// Register viewer so the reducer paths that touch viewer.slice work.
api.registerComponent(require('../panel/viewer/viewer'));

function applyUpdate(s, msg) {
  // v0.6.3 Phase D1: stream_start routed branch threads currentGroup
  // + actionTabIdx; tests dispatching the bare Msg get the bundle
  // patched here so the reducer stays pure of getModel().
  if (msg && msg.type === 'stream_start'
      && msg.tabKey && msg.groupName && msg.currentGroup == null) {
    const m = getModel();
    const bundle = { currentGroup: m.currentGroup };
    if (msg.groupName === m.currentGroup) {
      const info = pt.flatTabInfo(s, m, msg.groupName);
      bundle.actionTabIdx = info.actionTabs.findIndex(([k]) => k === msg.tabKey);
    }
    msg = { ...msg, ...bundle };
  }
  const r = viewer._update(msg, s);
  return Array.isArray(r) ? { next: r[0], cmds: r[1] || [] } : { next: r, cmds: [] };
}

describe('[merge] getMergedActions yields plugin + YAML', () => {
  it('plugin action and YAML action both appear', () => {
    const merged = api.getMergedActions('g');
    const keys = Object.keys(merged).sort();
    eq(keys.join(','), 'plugin-status,yaml-build,yaml-no-tab', 'all three present');
  });
  it('YAML wins on collision', () => {
    // Add a collision: YAML declares `plugin-status` too.
    const m = getModel();
    m.config.groups.g.actions['plugin-status'] = {
      label: 'OVERRIDE', script: 'echo yaml', tab: false,
    };
    const merged = api.getMergedActions('g');
    eq(merged['plugin-status'].label, 'OVERRIDE', 'YAML override wins');
    eq(merged['plugin-status'].tab, false, 'YAML override drops tab flag');
    delete m.config.groups.g.actions['plugin-status'];
  });
});

describe('[flatTabInfo] plugin tab:true appears in actionTabs', () => {
  it('actionTabs contains both plugin-status and yaml-build', () => {
    const slice = viewer._init();
    const info = pt.flatTabInfo(slice, getModel(), 'g');
    const keys = info.actionTabs.map(([k]) => k).sort();
    eq(keys.join(','), 'plugin-status,yaml-build', 'both tabbed actions present');
  });
  it('actionTabCount counts both', () => {
    eq(pt.actionTabCount(getModel(), 'g'), 2, 'count = 2');
  });
});

describe('[stream_start] routed Msg with plugin tabKey auto-jumps', () => {
  it('seeds plugin buffer, jumps to plugin tab idx, emits terminal_exit', () => {
    const s0 = { ...viewer._init(), tab: 0 };
    const { next, cmds } = applyUpdate(s0, {
      type: 'stream_start',
      header: '[dim]$ plugin-status[/]',
      tabKey: 'plugin-status',
      groupName: 'g',
    });
    // actionTabs ordering: plugin entries come first (plugin merge
    // precedes YAML spread), so plugin-status is idx 0. v0.6.2 — action
    // tabs start at idx 2 (Info=0, Transcript=1).
    const info = pt.flatTabInfo(s0, getModel(), 'g');
    const expectedIdx = info.actionTabs.findIndex(([k]) => k === 'plugin-status');
    eq(next.tab, 2 + expectedIdx, 'tab jumped to plugin-status idx');
    eq(next.actionTabBuffers.g['plugin-status'].lines.length, 1, 'plugin buffer seeded');
    assert(cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted');
  });
});

describe('[viewer_append] mirror-on-active works for the plugin tab', () => {
  it('append while on plugin tab mirrors to slice.lines', () => {
    const info = pt.flatTabInfo({}, getModel(), 'g');
    const pluginIdx = info.actionTabs.findIndex(([k]) => k === 'plugin-status');
    const s0 = {
      ...viewer._init(),
      tab: 2 + pluginIdx,
      lines: ['[dim]$ plugin-status[/]'],
      actionTabBuffers: { g: { 'plugin-status': { lines: ['[dim]$ plugin-status[/]'] } } },
    };
    const { next } = applyUpdate(s0, {
      type: 'viewer_append', line: 'hello', tabKey: 'plugin-status', groupName: 'g',
    });
    eq(next.actionTabBuffers.g['plugin-status'].lines.length, 2, 'plugin buffer grew');
    eq(next.lines.length, 2, 'slice.lines mirrored');
    eq(next.lines[1], 'hello', 'mirrored line text');
  });
});

report();
