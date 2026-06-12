/**
 * Smoke — tab lifecycle (open → focus → switch → close → state cleanup).
 *
 * The v0.6.3 "[x] tab close — click hit-zone + stale content cleanup"
 * bug was the user-facing symptom of a class of cleanup mistakes: a
 * tab close path that left the closed tab's content lingering in
 * `detail.lines` (so the sibling-fallback or Info-fallback rendered
 * the WRONG body). Other shapes in the same class:
 *
 *   - tabState entry surviving a close (R5)
 *   - viewerOverride surviving a close (A7)
 *   - active-tab cursor pointing past the new tab count (T27)
 *
 * Existing unit tests in test-content-tabs.js cover these at the
 * reducer level. This smoke drives them end-to-end (real handleKey /
 * applyMsg / render path) so a regression in a higher-level dispatcher
 * — the kind the unit tests miss — fires here.
 *
 * Run: node js/test/smoke/lifecycle.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const { displayedLines } = require('../_helpers/viewer-lines');
const sm = require('./_helpers/smoke');
const api = sm.api;
const tabs = sm.tabs;

// Helper: snapshot detail-slice state worth asserting on.
function snapshotDetail() {
  const d = api.getInstanceSlice('detail');
  return {
    tab: d.tab,
    lines: displayedLines(d).join('\n'),
    contentTabKeys: Object.keys((d.contentTabs && d.contentTabs[require('../../app/runtime').getModel().currentGroup]) || {}),
    tabStateKeys: Object.keys(d.tabState || {}),
    viewerOverride: d.viewerOverride,
  };
}

// --- [1] Open → switch → close (the user-facing v0.6.3 bug shape) ------
//
// Open two content tabs. Switch to the FIRST (so the close target is
// not the most-recent one). Close the first. Verify: detail.lines is
// the surviving sibling's content, not the closed tab's stale text.

describe('[1] close active content tab → body shows sibling, NOT closed-tab stale text', () => {
  it('two tabs open, close the active first → body shows second tab', () => {
    sm.bootFresh();
    tabs.addContentTab('g1', 'doc-A', 'A.txt', ['I am A', 'A line 2']);
    tabs.addContentTab('g1', 'doc-B', 'B.txt', ['I am B', 'B line 2']);
    // After both adds, active tab is doc-B (last-added wins).
    // Switch back to doc-A so the close target IS active.
    const detail = api.getInstanceSlice('detail');
    const { activeContentTab } = tabs;
    // doc-A is at the earlier content index. Switch via direct slice
    // poke (production switches via tab_switch Msg — covered separately).
    // Find doc-A's index via getTabInfo's contentTabs order.
    // contentTabs is an array of [key, {label, lines}] tuples.
    const info = tabs.getTabInfo();
    const idxOfA = info.contentTabs.findIndex(t => t[0] === 'doc-A');
    assert(idxOfA >= 0, 'doc-A is in the contentTabs list');
    // Content tabs come AFTER fixed slots (info=0, transcript=1, plus
    // any action/term tabs). Convert content-list index to absolute.
    const baseIdx = info.total - info.contentTabs.length;
    detail.tab = baseIdx + idxOfA;
    // Re-load doc-A's lines (production tab_switch does this; we set
    // up the body to mimic the post-switch state).
    detail.lines = info.contentTabs[idxOfA][1].lines.slice();
    eq(activeContentTab()[0], 'doc-A', 'parked on doc-A');
    eq(displayedLines(detail).join('\n'), 'I am A\nA line 2', 'body shows A');

    // Close doc-A — the v0.6.3 bug class: body must not retain A's
    // text after the active tab vanishes.
    tabs.removeContentTab('g1', 'doc-A');

    const after = snapshotDetail();
    // Sibling fallback should switch to doc-B and load its lines.
    assert(!after.contentTabKeys.includes('doc-A'), 'doc-A entry removed from contentTabs map');
    assert(after.contentTabKeys.includes('doc-B'), 'doc-B survives');
    assert(!after.lines.includes('I am A'), `body MUST NOT include closed-tab stale text (got: ${JSON.stringify(after.lines.slice(0, 80))})`);
    assert(after.lines.includes('I am B'), 'body shows the surviving sibling');
  });
});

// --- [2] Close last content tab → fall back to Info, body cleared ------

describe('[2] close only content tab → fallback to Info, no stale body', () => {
  it('opens a single tab → close it → tab=0 (Info), body is not the closed tab text', () => {
    sm.bootFresh();
    tabs.addContentTab('g1', 'only-doc', 'only.txt', ['ONLY-DOC-MARKER', 'line 2']);
    eq(displayedLines(api.getInstanceSlice('detail')).join('\n'), 'ONLY-DOC-MARKER\nline 2', 'body loaded');
    // Before closing: verify addContentTab actually auto-jumped to the
    // new content tab. Without this check the post-close `tab === 0`
    // assertion is ambiguous — bootFresh seeds tab=0, so an addContentTab
    // auto-jump regression (tab stuck at 0 throughout) would mask the
    // close-handler fallback the test was meant to catch.
    const beforeTab = api.getInstanceSlice('detail').tab;
    assert(beforeTab > 0, `addContentTab must auto-jump off Info (idx 0); got tab=${beforeTab}`);

    tabs.removeContentTab('g1', 'only-doc');
    const after = snapshotDetail();
    eq(after.tab, 0, 'fell back to Info (idx 0)');
    assert(!after.lines.includes('ONLY-DOC-MARKER'),
      `body MUST NOT carry closed-tab marker after fallback (got: ${JSON.stringify(after.lines.slice(0, 80))})`);
  });
});

// --- [3] Close drops the matching tabState entry (R5 invariant) --------

describe('[3] close drops tabState entry for the closed tab', () => {
  it('reopening same key starts fresh — no inherited scroll/cursor/search', () => {
    sm.bootFresh();
    tabs.addContentTab('g1', 'file:notes', 'notes.txt', ['n1', 'n2', 'n3']);
    // Prime tabState as if the user had scrolled + searched.
    const slice = api.getInstanceSlice('detail');
    slice.tabState = {
      ...(slice.tabState || {}),
      'g1:content:file:notes': { scroll: 42, cursor: { line: 2, col: 0 } },
    };

    tabs.removeContentTab('g1', 'file:notes');
    const after = api.getInstanceSlice('detail');
    assert(!('g1:content:file:notes' in (after.tabState || {})),
      `tabState entry for closed tab MUST be dropped (had: ${JSON.stringify(Object.keys(after.tabState || {}))})`);
  });
});

// --- [4] Close with viewerOverride armed clears the override (A7) -------

describe('[4] close active tab with viewerOverride → override clears', () => {
  it('history-replay-style override does not survive its host tab being closed', () => {
    sm.bootFresh();
    tabs.addContentTab('g1', 'doc1', 'doc1', ['x', 'y']);
    tabs.addContentTab('g1', 'doc2', 'doc2', ['a', 'b']);
    // Active is doc2 (last added). Arm an override on it.
    sm.route.setInstanceSlice('detail', {
      ...api.getInstanceSlice('detail'),
      viewerOverride: { lines: ['override line'] },
    });
    const activeKey = tabs.activeContentTab()[0];
    tabs.removeContentTab('g1', activeKey);
    const after = api.getInstanceSlice('detail');
    eq(after.viewerOverride, null, 'override cleared on active-tab close');
  });
});

// --- [5] Cross-group close does not clobber current-group state (T27) ---

describe('[5] cross-group remove preserves current-group cursor + body', () => {
  it('removeContentTab for OTHER group does not touch current detail.tab/lines/scroll', () => {
    sm.bootFresh({
      groups: {
        g1: { name: 'g1', label: 'G1', containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false },
        g2: { name: 'g2', label: 'G2', containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false },
      },
    });
    require('../../app/runtime').getModel().currentGroup = 'g1';
    tabs.addContentTab('g1', 'a', 'a.txt', ['g1-a-content']);
    const detail = api.getInstanceSlice('detail');
    const before = { tab: detail.tab, lines: displayedLines(detail).slice(), scroll: detail.scroll };
    // Async loadDir for g2 resolves while user is parked in g1.
    tabs.addContentTab('g2', 'b', 'b.txt', ['g2-b-content']);
    // Now close g2's tab — must not touch the g1-parked viewer.
    tabs.removeContentTab('g2', 'b');
    eq(detail.tab, before.tab, 'tab cursor unchanged by cross-group remove');
    eq(displayedLines(detail).join('\n'), before.lines.join('\n'), 'body unchanged by cross-group remove');
    eq(detail.scroll, before.scroll, 'scroll unchanged by cross-group remove');
  });
});

// --- [6] Open → render → close → render: full pipeline check ------------
//
// Drive the REAL render() at each step. This is the e2e signal: if any
// of the cleanup wiring inside the close path regresses (the v0.6.3
// bug class), the rendered frame after close will still contain the
// closed tab's marker.

describe('[6] live render after close does not paint closed-tab content', () => {
  it('addContentTab → render shows marker; close → render no longer shows marker', () => {
    sm.bootFresh();
    tabs.addContentTab('g1', 'doc-z', 'Z.txt', ['ZZ-CLOSED-MARKER-ZZ']);
    // Park focus on detail so the viewer paints prominently.
    api.getInstanceSlice('layout').focus = 'pane-detail';
    const before = sm.capture(() => sm.render()).frame;
    assert(/ZZ-CLOSED-MARKER-ZZ/.test(before), 'marker visible before close');

    tabs.removeContentTab('g1', 'doc-z');
    const after = sm.capture(() => sm.render()).frame;
    assert(!/ZZ-CLOSED-MARKER-ZZ/.test(after),
      `marker MUST NOT appear in rendered frame after close. ` +
      `Tail: ${JSON.stringify(after.slice(-200))}`);
  });
});

report();
