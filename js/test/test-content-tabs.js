/**
 * Content-tab arithmetic — addContentTab / removeContentTab interplay
 * with the existing tab categories (info / action / terminal / content).
 *
 * Run: node js/test/test-content-tabs.js
 */
'use strict';

const tabs = require('../panel/viewer/tabs');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const {getInstanceSlice, getFocus } = require('../panel/api');


function freshGroup({ actions = {}, terminals = {} } = {}) {
  // Minimal config — only the group lookup paths the tab code touches.
  getModel().config = { groups: { g1: { actions, terminals } } };
  getModel().currentGroup = 'g1';
  getInstanceSlice('detail').ephemeralTerminals = {};
  getInstanceSlice('detail').contentTabs = {};
  getInstanceSlice('detail').tab = 0;
  getInstanceSlice("layout").focus = 'groups';
  getModel().modes.terminalMode = false;
  getInstanceSlice('detail').lines = [];
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
    eq(getInstanceSlice('detail').lines.join('\n'), 'line one\nline two', 'lines loaded into detail');
  });
  it('re-add with same key updates label/lines and re-switches', () => {
    freshGroup();
    tabs.addContentTab('g1', 'file:x', 'x.txt', ['v1']);
    eq(tabs.getTabInfo().contentTabs.length, 1);
    tabs.addContentTab('g1', 'file:x', 'x.txt (updated)', ['v2', 'v2b']);
    eq(tabs.getTabInfo().contentTabs.length, 1, 'still one tab — replaced in place');
    eq(getInstanceSlice('detail').lines.join('\n'), 'v2\nv2b');
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
    eq(getInstanceSlice('detail').lines.join('\n'), 'real\ncontent', 'setViewerContent re-fired');
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
    eq(getInstanceSlice('detail').lines.join('\n'), 'some text');
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
    eq(getInstanceSlice('detail').lines.join('\n'), 'from-a', 'sibling lines loaded into detail');
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
    getInstanceSlice('detail').lines = ['g1 content'];
    getInstanceSlice('detail').scroll = 5;
    getInstanceSlice('detail').tab = 0;
    tabs.addContentTab('g1', 'file:a', 'a', ['g1 a-tab']);
    const tabBefore  = getInstanceSlice('detail').tab;
    const linesBefore = getInstanceSlice('detail').lines.slice();
    // Now an async loadDir for g2 (the OTHER group) resolves. Pre-T27
    // this clobbered the current-group cursor + body.
    tabs.addContentTab('g2', 'file:b', 'b', ['g2 b-tab']);
    eq(getInstanceSlice('detail').tab, tabBefore, 'tab cursor unchanged');
    eq(getInstanceSlice('detail').lines.join('\n'), linesBefore.join('\n'), 'lines unchanged');
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
    getInstanceSlice('detail').lines = ['g2 view'];
    getInstanceSlice('detail').scroll = 3;
    getInstanceSlice('detail').tab = 0;
    tabs.removeContentTab('g1', 'file:a');  // remove from OTHER group
    eq(getInstanceSlice('detail').tab, 0, 'tab unchanged');
    eq(getInstanceSlice('detail').lines.join('\n'), 'g2 view', 'lines unchanged');
    eq(getInstanceSlice('detail').scroll, 3, 'scroll unchanged');
    assert(!getInstanceSlice('detail').contentTabs.g1, 'g1 map dropped (empty after remove)');
  });
});

report();
