/**
 * U1 — the tab-container interface (leaves/wm/tab-container).
 * See docs/one-tab-system.md. Run: node js/test/test-tab-container.js
 *
 * Step 1 covers the VIEWER backing: listTabs must back pane-menu._flatTabs
 * field-for-field, the model-path and from-bundle forms must agree, switchTab
 * names the right tab_switch Msg, and perTabState round-trips through the
 * tab-state store. (Step 2 adds the instance backing below.)
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../app/runtime');
const tc = require('../leaves/wm/tab-container');
const pt = require('../leaves/wm/pane-tabs');
const ts = require('../leaves/wm/tab-state');
const layout = require('../panel/layout');

// A local copy of overlay/pane-menu.js#_flatTabs (the shape step 3 replaces
// with tc.listTabs). The parity test asserts listTabs → this shape byte-for-byte
// so the pane-menu conversion is provably behaviour-preserving.
function flatTabsRef(slice, m, g) {
  const info = pt.flatTabInfo(slice, m, g);
  const out = [
    { section: 'tab', tabIdx: 0, label: 'Info', kind: '' },
    { section: 'tab', tabIdx: 1, label: 'Transcript', kind: '' },
  ];
  // U2c P2 — action tabs retired; U2d P2b — terminals retired (they're `terminal`
  // panes). Content follows Info+Transcript directly, starting at idx 2.
  info.contentTabs.forEach(([key, c], i) => {
    let k = 'content';
    if (key.startsWith('docker:')) k = 'docker';
    else if (key.startsWith('file:')) k = 'file';
    out.push({
      section: 'tab', tabIdx: 2 + i,
      label: c.label || key, kind: k, closeable: true, closeKind: 'content', closeKey: key,
    });
  });
  return out;
}

// Map a neutral tc.listTabs row back to the pane-menu section-row shape.
function toSectionRow(r) {
  const row = { section: 'tab', tabIdx: r.idx, label: r.label, kind: r.kind };
  if ('closeable' in r) { row.closeable = r.closeable; row.closeKind = r.closeKind; row.closeKey = r.closeKey; }
  return row;
}

// A viewer slice exercising the content-tab kind. (U2c P2 — action tabs retired;
// U2d P2b — terminals retired, so the strip is Info/Transcript/content.)
function viewerSlice(g, tab) {
  return {
    tab: tab | 0,
    infoLines: ['info-a', 'info-b'],
    contentTabs: { [g]: { log: { label: 'log', lines: ['l1', 'l2'] } } },
    viewerStreamBuffer: { lines: [], cap: 1000 },
  };
}

describe('[tab-container] viewer listTabs backs pane-menu._flatTabs', () => {
  it('maps field-for-field (Info/Transcript/content-kind)', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const slice = viewerSlice(g, 0);
    const got = tc.listTabs(tc.containerFor('viewer', { slice, model: m })).map(toSectionRow);
    eq(JSON.stringify(got), JSON.stringify(flatTabsRef(slice, m, g)), 'listTabs → _flatTabs shape');
  });

  it('carries the stable key + active flag on each row', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const rows = tc.listTabs(tc.containerFor('viewer', { slice: viewerSlice(g, 1), model: m }));
    eq(rows[0].key, 'info');
    eq(rows[1].key, 'transcript');
    assert(rows[1].active, 'row at slice.tab is active');
    assert(!rows[0].active, 'other rows not active');
    const content = rows.find(r => r.closeKind === 'content');
    eq(content.key, `${g}:content:log`, 'content row carries the resolved key');
  });
});

describe('[tab-container] viewer model-path ≡ from-bundle', () => {
  it('listTabs is identical across every tab idx', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const bundle = pt.viewerModelBundle(m, g);
    const total = pt.flatTabInfo(viewerSlice(g, 0), m, g).total;
    for (let tab = 0; tab <= total + 1; tab++) {
      const slice = viewerSlice(g, tab);
      const model = tc.listTabs(tc.containerFor('viewer', { slice, model: m }));
      const bund = tc.listTabs(tc.containerFor('viewerB', { slice, bundle }));
      eq(JSON.stringify(bund), JSON.stringify(model), `parity @ tab ${tab}`);
    }
  });
});

describe('[tab-container] activeTab', () => {
  it('returns the row at slice.tab', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const at = tc.activeTab(tc.containerFor('viewer', { slice: viewerSlice(g, 1), model: m }));
    eq(at.idx, 1);
    eq(at.key, 'transcript');
  });
});

describe('[tab-container] viewer switchTab names the tab_switch Msg', () => {
  it('targets the paneId + carries idx/targetKey/currentGroup', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const slice = viewerSlice(g, 0);
    const c = tc.containerFor('viewer', { slice, model: m, paneId: 'pane-logs' });
    const key = `${g}:content:log`;
    const rows = tc.listTabs(c);
    const idx = rows.find(r => r.key === key).idx;
    const sw = tc.switchTab(c, key);
    eq(sw.target, 'pane-logs', 'wrap target is the viewer paneId');
    eq(sw.msg.type, 'tab_switch');
    eq(sw.msg.idx, idx);
    eq(sw.msg.targetKey, key);
    eq(sw.msg.currentGroup, g);
  });

  it('null on already-active / unknown key', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const c = tc.containerFor('viewer', { slice: viewerSlice(g, 0), model: m, paneId: 'p' });
    eq(tc.switchTab(c, 'info'), null, 'idx 0 is already active');
    eq(tc.switchTab(c, `${g}:content:nope`), null, 'unknown key');
    eq(tc.switchTab(c, null), null, 'no key');
  });
});

describe('[tab-container] perTabState round-trips through tab-state', () => {
  it('field/withField/withFields/drop/entry match the store directly', () => {
    const slice = { tabState: { k: { scroll: 3, cursor: 2 } } };
    const ps = tc.perTabState(tc.containerFor('viewer', { slice }), 'k');
    eq(ps.field('scroll', 7), ts.field(slice, 'k', 'scroll', 7), 'read parity');
    eq(ps.field('missing', 7), 7, 'fallback when unset');
    eq(JSON.stringify(ps.withField('scroll', 9)), JSON.stringify(ts.withField(slice, 'k', 'scroll', 9)), 'withField parity');
    eq(JSON.stringify(ps.withFields({ scroll: 1, sel: null })),
       JSON.stringify(ts.withFields(slice, 'k', { scroll: 1, sel: null })), 'withFields parity');
    eq(JSON.stringify(ps.drop()), JSON.stringify(ts.dropEntry(slice, 'k')), 'drop parity');
    eq(ps.entry(), slice.tabState.k, 'entry returns the raw store entry');
  });

  it('presence-not-truthiness (stored 0 wins over fallback)', () => {
    const slice = { tabState: { k: { scroll: 0 } } };
    eq(tc.perTabState(tc.containerFor('viewer', { slice }), 'k').field('scroll', 7), 0);
  });

  it('withField returns a fresh slice (immutable)', () => {
    const slice = { tabState: { k: { scroll: 1 } } };
    const next = tc.perTabState(tc.containerFor('viewer', { slice }), 'k').withField('scroll', 2);
    assert(next !== slice && next.tabState !== slice.tabState, 'fresh slice + store');
    eq(slice.tabState.k.scroll, 1, 'original untouched');
  });
});

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
  });

  it('perTabState is a stub (field → fallback, writes inert)', () => {
    const ps = tc.perTabState(tc.containerFor('instance', multiTabPane()), 'docker');
    eq(ps.field('scroll', 7), 7, 'reads return the fallback');
    eq(ps.withField('scroll', 1), null, 'writes are inert until U2b');
    eq(ps.entry(), null);
  });
});

describe('[tab-container] frozen-input safe (pure return-new)', () => {
  it('listTabs / perTabState do not mutate a frozen slice', () => {
    sm.bootFresh();
    const m = getModel();
    const g = m.currentGroup;
    const slice = viewerSlice(g, 0);
    expectNoMutation('listTabs', () => tc.listTabs(tc.containerFor('viewer', { slice, model: m })), slice);
    const tstate = { tabState: { k: { scroll: 1 } } };
    expectNoMutation('perTabState.withField',
      () => tc.perTabState(tc.containerFor('viewer', { slice: tstate }), 'k').withField('scroll', 5), tstate);
  });
});

report();
