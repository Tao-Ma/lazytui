/**
 * U1 — the tab-container interface (leaves/wm/tab-container).
 * See docs/one-tab-system.md. Run: node js/test/test-tab-container.js
 *
 * U2f — the viewer Component (and its flat content-tab strip) is gone, so the
 * former `containerFor('viewer'/'viewerB')` backing + the `_flatTabs`/`_viewerRows`
 * parity blocks retired with it. The sole survivor is the `'instance'` backing:
 * a slot's `pane.tabs[]` + `activeTabId`, with the pool supplying each tab's
 * label/kind. `switchTab` names the `set_active_tab` layout Msg; `perTabState`
 * is a documented stub (a position tab's view-state is its mounted instance's
 * own slice, which a pure leaf can't reach).
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const tc = require('../leaves/wm/tab-container');

// --- instance backing (position/slot tabs) -------------------------------

function multiTabPane() {
  return {
    pane: {
      paneId: 'pane-docker', activeTabId: 'docker',
      tabs: [{ id: 'docker', poolId: 'docker' }, { id: 'logs', poolId: 'logs' }],
    },
    pool: {
      docker: { id: 'docker', type: 'docker', title: 'Docker' },
      logs: { id: 'logs', type: 'viewer', title: 'Logs' },
    },
  };
}

describe('[tab-container] instance backing', () => {
  it('listTabs — one row per pane.tabs[i], label/kind from the pool', () => {
    const { pane, pool } = multiTabPane();
    const rows = tc.listTabs(tc.containerFor('instance', { pane, pool }));
    eq(rows.length, 2);
    eq(rows[0].key, 'docker'); eq(rows[0].label, 'Docker'); eq(rows[0].kind, 'docker');
    assert(rows[0].active, 'active on activeTabId');
    eq(rows[1].key, 'logs'); eq(rows[1].label, 'Logs'); eq(rows[1].kind, 'viewer');
    assert(!rows[1].active);
  });

  it('label falls back to poolId when no pool supplied', () => {
    const { pane } = multiTabPane();
    eq(tc.listTabs(tc.containerFor('instance', { pane }))[1].label, 'logs');
  });

  it('activeTab returns the active row', () => {
    const { pane, pool } = multiTabPane();
    eq(tc.activeTab(tc.containerFor('instance', { pane, pool })).key, 'docker');
  });

  it('switchTab names the set_active_tab Msg on layout', () => {
    const { pane, pool } = multiTabPane();
    const sw = tc.switchTab(tc.containerFor('instance', { pane, pool }), 'logs');
    eq(sw.target, 'layout');
    eq(JSON.stringify(sw.msg), JSON.stringify({ type: 'set_active_tab', paneId: 'pane-docker', tabPoolId: 'logs' }));
  });

  it('switchTab is null for already-active / unknown', () => {
    const { pane, pool } = multiTabPane();
    const c = tc.containerFor('instance', { pane, pool });
    eq(tc.switchTab(c, 'docker'), null, 'already active');
    eq(tc.switchTab(c, 'ghost'), null, 'unknown poolId');
    eq(tc.switchTab(c, null), null, 'no key');
  });

  it('perTabState is a stub (reads fallback, writes inert)', () => {
    // A position tab's view-state is its mounted instance's own slice (addressed
    // by instance id) — a pure leaf can't reach it, so reads return the fallback
    // and writes are inert (null).
    const ps = tc.perTabState(tc.containerFor('instance', multiTabPane()), 'docker');
    eq(ps.field('scroll', 7), 7, 'reads return the fallback');
    eq(ps.withField('scroll', 1), null, 'writes are inert');
    eq(ps.withFields({ scroll: 1 }), null, 'multi-writes inert');
    eq(ps.drop(), null, 'drop inert');
    eq(ps.entry(), null);
  });
});

describe('[tab-container] frozen-input safe (pure return-new)', () => {
  it('listTabs does not mutate a frozen pane/pool', () => {
    const { pane, pool } = multiTabPane();
    expectNoMutation('listTabs',
      () => tc.listTabs(tc.containerFor('instance', { pane, pool })), pane);
  });
});

report();
