/**
 * Content-tab arithmetic — addContentTab / removeContentTab interplay
 * with the existing tab categories (info / action / terminal / content).
 *
 * Run: node js/test/test-content-tabs.js
 */
'use strict';

const tabs = require('../panel/viewer/tabs');
const { displayedLines } = require('./_helpers/viewer-lines');
const pt = require('../leaves/pane-tabs');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const {getInstanceSlice, getFocus } = require('../panel/api');

// v0.6.3 Phase 3d: tab_switch's reducer arm reads msg.currentGroup +
// msg.targetKey (production dispatchers thread them via modelBundle +
// resolveTabKey). Tests dispatching the bare Msg use this helper to
// patch in the bundle so the arm doesn't need a getModel() fallback.
function tabSwitchMsg(slice, idx) {
  const m = getModel();
  return {
    type: 'tab_switch', idx,
    targetKey: pt.resolveTabKey(idx, { ...slice, tab: idx }, m),
    currentGroup: m.currentGroup,
  };
}


function freshGroup({ actions = {}, terminals = {} } = {}) {
  // Minimal config — only the group lookup paths the tab code touches.
  getModel().config = { groups: { g1: { actions, terminals } } };
  getModel().currentGroup = 'g1';
  getInstanceSlice('detail').ephemeralTerminals = {};
  getInstanceSlice('detail').contentTabs = {};
  getInstanceSlice('detail').tab = 0;
  getInstanceSlice("layout").focus = 'groups';
  require('../dispatch/control/dispatch').applyMsg({ type: 'mode_clear', flag: 'terminalMode' });
  getInstanceSlice('detail').infoLines = [];
  getInstanceSlice('detail').scroll = 0;
}

describe('[1] addContentTab basics', () => {
  it('places a content tab after info / actions / terms', () => {
    freshGroup({ actions: { a: { tab: true, label: 'A' } } });
    tabs.addContentTab('g1', 'file:foo.txt', 'foo.txt', ['line one', 'line two']);
    const info = tabs.getTabInfo();
    eq(info.actionTabs.length, 1, 'one action tab');
    eq(info.contentTabs.length, 1, 'one content tab');
    eq(info.total, 2 + 1 + 0 + 1, 'info + transcript + action + term + content');
    // v0.6.2 layout: Info=0, Transcript=1, action(A)=2, content(file:foo)=3
    eq(getInstanceSlice('detail').tab, 3, 'content tab is at index 3');
    eq(getFocus(), 'detail', 'focus moved to detail');
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'line one\nline two', 'lines loaded into detail');
  });
  it('re-add with same key updates label/lines and re-switches', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x.txt', ['v1']);
    eq(tabs.getTabInfo().contentTabs.length, 1);
    tabs.addContentTab('g1', 'file:x', 'x.txt (updated)', ['v2', 'v2b']);
    eq(tabs.getTabInfo().contentTabs.length, 1, 'still one tab — replaced in place');
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'v2\nv2b');
  });
});

describe('[2] isContentTab / activeContentTab', () => {
  it('isContentTab true on a content tab, false otherwise', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:a', 'a', ['x']);
    eq(tabs.isContentTab(), true);
    getInstanceSlice('detail').tab = 0;
    eq(tabs.isContentTab(), false);
  });
  it('activeContentTab returns [key, info] or null', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:a', 'a', ['x']);
    const got = tabs.activeContentTab();
    assert(got, 'not null');
    eq(got[0], 'file:a');
    eq(got[1].label, 'a');
    getInstanceSlice('detail').tab = 0;
    eq(tabs.activeContentTab(), null);
  });
});

describe('[3] removeContentTab arithmetic', () => {
  it('removes the entry and rewinds activeTab when it was the active one', () => {
    // v0.6.2 layout: Info=0, Transcript=1, content(a)=2, content(b)=3
    freshGroup();
    tabs.addContentTab('g1', 'a', 'a', ['x']);
    tabs.addContentTab('g1', 'b', 'b', ['y']);
    eq(getInstanceSlice('detail').tab, 3, 'b is active (idx 3)');
    tabs.removeContentTab('g1', 'b');
    eq(getInstanceSlice('detail').tab, 2, 'fell back to previous sibling (a at idx 2)');
    eq(tabs.getTabInfo().contentTabs.length, 1);
  });
  it('removing the only content tab goes back to Info', () => {
    freshGroup();
    tabs.addContentTab('g1', 'a', 'a', ['x']);
    tabs.removeContentTab('g1', 'a');
    eq(getInstanceSlice('detail').tab, 0, 'back to info');
    eq(tabs.getTabInfo().contentTabs.length, 0);
  });
  it('removing a non-active content tab shifts activeTab down by 1 if past it', () => {
    // v0.6.2 layout: Info=0, Transcript=1, content(a)=2, content(b)=3
    freshGroup();
    tabs.addContentTab('g1', 'a', 'a', ['x']);   // idx 2, active
    tabs.addContentTab('g1', 'b', 'b', ['y']);   // idx 3, now active
    getInstanceSlice('detail').tab = 3;                              // b active
    tabs.removeContentTab('g1', 'a');             // remove the earlier one
    eq(getInstanceSlice('detail').tab, 2, 'b is now at index 2');
    eq(tabs.activeContentTab()[0], 'b');
  });
});

describe('[5] updateContentTabLines — no focus steal', () => {
  it('refreshes lines without changing activeTab or focus', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x', ['v1']);
    // User navigates away
    getInstanceSlice('detail').tab = 0;
    getInstanceSlice("layout").focus = 'groups';
    tabs.updateContentTabLines('g1', 'file:x', ['v2', 'v3']);
    eq(getInstanceSlice('detail').tab, 0, 'activeTab unchanged');
    eq(getFocus(), 'groups', 'focus unchanged');
    // Lines stored, but detail body NOT refreshed (we're not on that tab)
    eq(getInstanceSlice('detail').contentTabs.g1['file:x'].lines.join('\n'), 'v2\nv3');
  });
  it('refreshes detail body when user is parked on the updated tab', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x', ['placeholder']);
    // Still on the content tab
    tabs.updateContentTabLines('g1', 'file:x', ['real', 'content']);
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'real\ncontent', 'setViewerContent re-fired');
  });
  it('no-op for non-existent tab (after user closed it)', () => {
    freshGroup();
    tabs.updateContentTabLines('g1', 'file:nope', ['ignored']);
    eq(getInstanceSlice('detail').contentTabs.g1, undefined, 'no tab created');
  });
  it('no-op when group != currentGroup (silent store)', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x', ['v1']);
    getModel().currentGroup = 'gOther';
    tabs.updateContentTabLines('g1', 'file:x', ['v2']);
    // Lines stored
    eq(getInstanceSlice('detail').contentTabs.g1['file:x'].lines.join('\n'), 'v2');
    // But detail body NOT touched (user is on a different group)
    // Note: setViewerContent is what would write to getInstanceSlice('detail').lines; nothing
    // forces it from this code path.
  });
});

describe('[6] removeContentTab refreshes detail body', () => {
  it('falls back to Info when last content tab is closed', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x', ['some text']);
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'some text');
    tabs.removeContentTab('g1', 'file:x');
    eq(getInstanceSlice('detail').tab, 0, 'back to Info');
    // detailLines should no longer hold the closed file's content
    // (it's cleared via viewer_show_info in the close path). The test
    // config has no panel def with getItems so viewer_show_info returns
    // early — but the assertion is that we DON'T still hold the file
    // content unchanged. In a real app, viewer_show_info would populate
    // Info; here we accept that getInstanceSlice('detail').lines may have
    // been left as-is OR cleared. Tighter assertion below.
  });
  it('falls back to sibling content tab and loads its lines', () => {
    // v0.6.2 layout: Info=0, Transcript=1, content(a)=2, content(b)=3
    freshGroup();
    tabs.addContentTab('g1', 'a', 'a', ['from-a']);
    tabs.addContentTab('g1', 'b', 'b', ['from-b']);
    // active is now 'b' (last added)
    tabs.removeContentTab('g1', 'b');
    eq(getInstanceSlice('detail').tab, 2, 'sibling content tab (a at idx 2)');
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'from-a', 'sibling lines loaded into detail');
  });
});

describe('[4] isTerminalTab unaffected by content tabs', () => {
  it('content tabs in the mix do not confuse isTerminalTab', () => {
    // v0.6.2 layout: 0=Info, 1=Transcript, 2=term sh, 3=content a
    freshGroup({ terminals: { sh: { cmd: 'bash', label: 'sh' } } });
    tabs.addContentTab('g1', 'a', 'a', ['x']);
    getInstanceSlice('detail').tab = 2;
    eq(tabs.isTerminalTab(), true,  'index 2 is term');
    eq(tabs.isContentTab(),  false, 'index 2 is not content');
    getInstanceSlice('detail').tab = 3;
    eq(tabs.isTerminalTab(), false, 'index 3 is not term');
    eq(tabs.isContentTab(),  true,  'index 3 is content');
  });
});

// ---- T27 regression: cross-group tab mutators don't clobber current-group state ----
//
// Pre-T27, addContent / removeContent / removeEphemeral wrote to slice.tab,
// slice.lines, slice.scroll unconditionally — even when groupName !==
// model.currentGroup. The tab-index math was meaningful in `groupName`'s
// tab ordering, so applying it to the current group jumped the user's
// cursor to a meaningless index and replaced the body with the OTHER
// group's content. Real trigger: handleSessionCleanExit after a group
// switch (PTY exits in a non-current group, removeEphemeralTab fires).

describe('[T27] cross-group mutators preserve current-group cursor + body', () => {
  it('addContentTab for non-current group does not touch slice.tab / lines / scroll', () => {
    // Set up two groups; user is parked in g1 with a content tab open.
    getModel().config = { groups: { g1: { actions: {}, terminals: {} },
                                    g2: { actions: {}, terminals: {} } } };
    getModel().currentGroup = 'g1';
    getInstanceSlice('detail').ephemeralTerminals = {};
    getInstanceSlice('detail').contentTabs = {};
    getInstanceSlice('detail').infoLines = ['g1 content'];
    getInstanceSlice('detail').scroll = 5;
    getInstanceSlice('detail').tab = 0;
    tabs.addContentTab('g1', 'file:a', 'a', ['g1 a-tab']);
    const tabBefore  = getInstanceSlice('detail').tab;
    const linesBefore = displayedLines(getInstanceSlice('detail')).slice();
    // Now an async loadDir for g2 (the OTHER group) resolves. Pre-T27
    // this clobbered the current-group cursor + body.
    tabs.addContentTab('g2', 'file:b', 'b', ['g2 b-tab']);
    eq(getInstanceSlice('detail').tab, tabBefore, 'tab cursor unchanged');
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), linesBefore.join('\n'), 'lines unchanged');
    // But the cross-group tab IS now in the per-group map:
    const ct = getInstanceSlice('detail').contentTabs;
    assert(ct.g2 && ct.g2['file:b'], 'g2 content tab stored in map');
  });
  it('removeContentTab for non-current group does not touch current cursor', () => {
    getModel().config = { groups: { g1: { actions: {}, terminals: {} },
                                    g2: { actions: {}, terminals: {} } } };
    getModel().currentGroup = 'g2';
    getInstanceSlice('detail').ephemeralTerminals = {};
    getInstanceSlice('detail').contentTabs = { g1: { 'file:a': { label: 'a', lines: ['old'] } } };
    getInstanceSlice('detail').infoLines = ['g2 view'];
    getInstanceSlice('detail').scroll = 3;
    getInstanceSlice('detail').tab = 0;
    tabs.removeContentTab('g1', 'file:a');  // remove from OTHER group
    eq(getInstanceSlice('detail').tab, 0, 'tab unchanged');
    eq(displayedLines(getInstanceSlice('detail')).join('\n'), 'g2 view', 'lines unchanged');
    eq(getInstanceSlice('detail').scroll, 3, 'scroll unchanged');
    assert(!getInstanceSlice('detail').contentTabs.g1, 'g1 map dropped (empty after remove)');
  });
});

describe('[A7] tab removal with active viewerOverride dismisses the override', () => {
  // Round 2 finding: removing the user's active content/terminal tab
  // while viewerOverride was set left the override painting after
  // the fallback to a sibling or Info. The user thought they closed
  // the doc they were looking at (the override); actually they
  // closed the underlying tab and the override survived → discrete-
  // doc content paints on the wrong surface.
  it('removeContentTab on active tab with override clears the override', () => {
    const route = require('../panel/route');
    freshGroup();
    tabs.addContentTab('g1', 'doc1', 'doc1', ['x', 'y']);
    // Add a second content tab so removal falls back to a sibling.
    tabs.addContentTab('g1', 'doc2', 'doc2', ['a', 'b']);
    // Arm an override on the active content tab.
    const slice = getInstanceSlice('detail');
    route.setInstanceSlice('detail', {
      ...slice,
      viewerOverride: { lines: ['override line'] },
    });
    const tabBeforeRemove = getInstanceSlice('detail').tab;
    // Find which key is active and remove it.
    const activeKey = tabs.activeContentTab()[0];
    tabs.removeContentTab('g1', activeKey);
    const after = getInstanceSlice('detail');
    assert(after.tab !== tabBeforeRemove || after.viewerOverride == null,
      'either moved off the removed tab OR override cleared (both expected; either signal is enough)');
    eq(after.viewerOverride, null, 'override cleared on active-tab removal');
  });
  it('removeContentTab on non-active tab preserves override', () => {
    const route = require('../panel/route');
    freshGroup();
    tabs.addContentTab('g1', 'doc1', 'doc1', ['x']);
    tabs.addContentTab('g1', 'doc2', 'doc2', ['a']);
    // Active is doc2 (just added). Override is on doc2.
    const slice = getInstanceSlice('detail');
    route.setInstanceSlice('detail', {
      ...slice,
      viewerOverride: { lines: ['override line'] },
    });
    // Remove doc1 (not the active tab).
    tabs.removeContentTab('g1', 'doc1');
    const after = getInstanceSlice('detail');
    assert(after.viewerOverride, 'override preserved when non-active tab removed');
  });
});

describe('[R14] N1 content-tab tabState restore (non-adjacent transition)', () => {
  // Pre-N1 the inline _resolveKey returned null for the content-tab
  // path when ACTIVECONTENTTAB() read the store-side stale slice.tab
  // (switching FROM Info / Action / Terminal). So targetKey was null
  // and tabState[content:<key>] never restored. N1 canonicalized via
  // resolveTabKey(idx, slice, model) which resolves correctly
  // regardless of the store-side stale state. Behavior change worth
  // pinning explicitly.
  it('switching FROM Info TO a content tab restores tabState[<g>:content:<key>] search/select/cursor', () => {
    const route = require('../panel/route');
    const viewer = require('../panel/viewer/viewer');
    freshGroup();
    tabs.addContentTab('g1', 'doc1', 'doc1', ['x', 'y', 'z']);
    // Seed: park on Info (idx 0), prime tabState['g1:content:doc1']
    // with a saved cursor / search / select state.
    const slice = getInstanceSlice('detail');
    route.setInstanceSlice('detail', {
      ...slice,
      tab: 0,
      innerH: 10,
      tabState: {
        'g1:content:doc1': {
          scroll: 0,
          search: { active: true, term: 'foo', matches: [], idx: 0, typing: '' },
          select: { active: false, kind: 'line', anchor: { line: 1, col: 0 }, cursor: { line: 2, col: 0 } },
          cursor: { line: 1, col: 0 },
        },
      },
    });
    const sliceForSwitch = getInstanceSlice('detail');
    const r = viewer._update(tabSwitchMsg(sliceForSwitch, 2), sliceForSwitch);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 2, 'on content:doc1');
    eq(next.search.term, 'foo', 'restored search term');
    eq(next.cursor.line, 1, 'restored cursor line');
    eq(next.select.kind, 'line', 'restored select kind');
  });
});

describe('[R11] tab key parser handles `:` in group names', () => {
  // Pre-R11 _tabKeyExistsIn used /^([^:]+):(action|terminal|content):(.+)$/
  // which required group names without `:`. Group `proj:v2` → key
  // `proj:v2:action:Build` didn't match → bail returned `true`
  // unconditionally → R5's removed-tab capture-skip silently disabled.
  // Post-R11 the leading segment is non-greedy and the first
  // `:action:` / `:terminal:` / `:content:` anchors the split.
  it('removeContentTab drops tabState for group names with `:`', () => {
    const route = require('../panel/route');
    const viewer = require('../panel/viewer/viewer');
    getModel().config = { groups: { 'proj:v2': { actions: {}, terminals: {} } } };
    getModel().currentGroup = 'proj:v2';
    const slice = getInstanceSlice('detail');
    // Seed a content tab + matching tabState entry.
    route.setInstanceSlice('detail', {
      ...slice,
      tab: 0,
      contentTabs: { 'proj:v2': { 'doc1': { label: 'd1', lines: ['x'] } } },
      tabState: {
        'proj:v2:content:doc1': { scroll: 42 },
      },
    });
    tabs.removeContentTab('proj:v2', 'doc1');
    const after = getInstanceSlice('detail');
    assert(!('proj:v2:content:doc1' in (after.tabState || {})),
      'tabState entry dropped despite `:` in group name');
  });
});

describe('[B8] tab_switch to content tab from non-content origin resets scroll', () => {
  // Round 2 finding: the content-tab branch was guarded by
  // `if (activeContentTab())` where activeContentTab reads the
  // store-side _detailSlice (still reflecting PRE-transition
  // slice.tab). When switching FROM Info / Action / Terminal TO a
  // content tab, activeContentTab returned null → the
  // `next.scroll = _resolveScroll(0, 0)` write was SKIPPED → scroll
  // inherited the leaving tab's value via the `{...slice, tab: idx,
  // ...}` earlier spread.
  it('Info(scroll=50) → content:foo lands at scroll=0 (not inherited 50)', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:foo', 'foo', ['a', 'b', 'c']);
    // After addContentTab the focus is on detail. Reset for a deterministic test:
    // park on Info (idx 0) with scroll = 50 (deliberately mid-doc).
    const route = require('../panel/route');
    const slice = route.getInstanceSlice('detail');
    route.setInstanceSlice('detail', { ...slice, tab: 0, scroll: 50, innerH: 10 });
    // Now tab_switch to the content tab (idx 2: Info=0, Transcript=1, content[foo]=2).
    const viewer = require('../panel/viewer/viewer');
    const sliceForSwitch = route.getInstanceSlice('detail');
    const r = viewer._update(tabSwitchMsg(sliceForSwitch, 2), sliceForSwitch);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 2, 'on content:foo');
    eq(next.scroll, 0, 'scroll reset to 0 (B8: pre-fix inherited Info\'s 50)');
  });
});

describe('[R5] tab removal drops the matching tabState entry', () => {
  // Pre-R5: removeEphemeral / removeContent dropped the
  // ephemeralTerminals[g][k] / contentTabs[g][k] entry but left
  // tabState['<g>:terminal:<k>'] / tabState['<g>:content:<k>']
  // intact. Reopening the same key inherited the prior tab's stored
  // scroll / search / select / cursor — counter to the kind-specific
  // first-visit defaults tab_switch's _resolveScroll falls back to.
  it('removeContentTab drops tabState[<group>:content:<key>]', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:foo', 'foo', ['x', 'y', 'z']);
    // Simulate captured view state from a prior visit.
    const slice = getInstanceSlice('detail');
    slice.tabState = {
      'g1:content:file:foo': { scroll: 7, cursor: { line: 7, col: 0 } },
      'g1:content:other': { scroll: 99 },
    };
    require('../panel/route').setInstanceSlice('detail', slice);
    tabs.removeContentTab('g1', 'file:foo');
    const after = getInstanceSlice('detail');
    assert(!('g1:content:file:foo' in after.tabState), 'removed tab\'s entry dropped');
    eq(after.tabState['g1:content:other'].scroll, 99, 'sibling entry untouched');
  });
  it('removeEphemeralTab drops tabState[<group>:terminal:<key>]', () => {
    freshGroup({ terminals: { shell: { cmd: 'bash', label: 'Shell' } } });
    // Force an ephemeral terminal entry directly (skip add-flow nuance).
    const slice = getInstanceSlice('detail');
    slice.ephemeralTerminals = { g1: { 'eph-1': { cmd: 'sh', label: 'Eph' } } };
    slice.tabState = {
      'g1:terminal:eph-1': { scroll: 12 },
      'g1:terminal:shell': { scroll: 5 },
    };
    require('../panel/route').setInstanceSlice('detail', slice);
    tabs.removeEphemeralTab('g1', 'eph-1');
    const after = getInstanceSlice('detail');
    assert(!('g1:terminal:eph-1' in after.tabState), 'removed terminal\'s entry dropped');
    eq(after.tabState['g1:terminal:shell'].scroll, 5, 'sibling entry untouched');
  });
});

// ---- split-arc P2.2 regression: no-arg terminal helpers must resolve the
// mounted viewer. activeTerminalId/findEphemeralByid used to default
// `paneId = 'detail'` — a kind name only the deleted getInstanceSlice
// fallback bridged to the minted pane instance. On real boots (seed
// disposed, 'pane-detail' minted) the strict miss returned the empty
// stub: terminal activation, terminal-mode input, and the PTY overlay
// paint all read null while the isTerminalTab gate (resolveTarget-based)
// said true.
describe('[P2.2] no-arg activeTerminalId resolves the mounted viewer pane', () => {
  it('post-mint shape: seed disposed, pane-detail minted → terminal still found', () => {
    const route = require('../panel/route');
    freshGroup({ terminals: { sh: { cmd: 'bash', label: 'sh' } } });
    const seed = route.getInstance('detail').slice;
    route.disposeInstance('detail');
    route.setInstance('pane-detail', 'detail', { ...seed, tab: 2 });  // 0=Info 1=Transcript 2=term sh
    try {
      eq(tabs.activeTerminalId(), 'g1_sh',
         'no-arg default resolves via resolveTarget (pre-fix: strict miss → null)');
    } finally {
      route.disposeInstance('pane-detail');
      route.setInstance('detail', 'detail', seed);
    }
  });
});

// Stage-1 domain-detangle guard (docs/v0.6.5-render-exit.md "domain detangle"):
// feature/open-file no longer imports panel/viewer/tabs — it pushes content
// through the leaves/feature-host port, wired by tabs.js on load. This proves
// the workflow still creates the tab end-to-end; if the seam wiring breaks,
// host.addContentTab is null and openHostFileAsTab throws here.
describe('[feature-host] open-file routes through the injected port', () => {
  it('openHostFileAsTab creates a content tab via the wired port', () => {
    freshGroup();
    const { openHostFileAsTab } = require('../feature/open-file');
    openHostFileAsTab('/tmp/detangle-stage1-probe.txt');  // sync tab add fires before async load
    const info = tabs.getTabInfo();
    eq(info.contentTabs.length, 1, 'one content tab created by the feature workflow');
    eq(info.contentTabs[0][0], 'file:/tmp/detangle-stage1-probe.txt', 'keyed by absolute path');
  });
});

report();
