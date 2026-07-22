/**
 * Smoke — content-tab lifecycle (open → focus → switch → close → cleanup).
 *
 * The v0.6.3 "[x] tab close — click hit-zone + stale content cleanup"
 * bug was the user-facing symptom of a class of cleanup mistakes: a
 * tab close path that left the closed tab's content lingering in the
 * viewer body (so the sibling-fallback or Info-fallback rendered the
 * WRONG body). Other shapes in the same class: per-tab view-state
 * surviving a close (R5), a discrete override surviving a close (A7),
 * an active-tab cursor pointing past the new tab count (T27).
 *
 * U2e P1b — the viewer's inner `contentTabs` machinery is dissolved.
 * Opening content = a minted `text-view` POSITION-tab in the content
 * SLOT (feature/content-tab.js → poolId `content-<key>`, content via
 * `tv_set_lines`); closing = `remove_tab` (the position-tab close, what
 * `x` drives on a focused content tab). Info + Transcript are PERMANENT
 * seeded tabs — closing the last CONTENT tab falls back to whatever tab
 * remains active (Info by default), not a flat "tab 0". Each content tab
 * is its OWN instance, so per-tab view-state cleanup is now instance
 * DISPOSAL (reconcile drops an orphaned tab-instance), not a `tabState`
 * map entry on one shared slice.
 *
 * (The retired reducer-level `contentTabs`-facade coverage moved to
 * `test-content-tab-mint.js`.) This smoke drives the lifecycle end-to-end
 * (real applyMsg / mint / render path) so a regression in a higher-level
 * dispatcher — the kind unit tests miss — fires here.
 *
 * Run: node js/test/smoke/lifecycle.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const { displayedLines } = require('../_helpers/viewer-lines');
const sm = require('./_helpers/smoke');
const api = sm.api;
const route = sm.route;

// U2e P1b — the seeded content slot mints `info` + `text-view` (Transcript,
// and each opened content tab) instances, so those Components MUST be
// registered before bootFresh's initState or the mint loop skips them.
if (!api.getComponent('info')) api.registerComponent(require('../../panel/info/info'));
if (!api.getComponent('text-view')) api.registerComponent(require('../../panel/text-view/text-view'));

const feature = require('../../panel/content-tab');
const mpane = require('../../leaves/wm/pane');
const mpool = require('../../leaves/wm/pool');

// --- P1b content-slot helpers --------------------------------------------

const layoutSlice = () => api.getInstanceSlice('layout');
function slotPaneId() { return route.resolveViewerPaneId(); }
function slotPane() {
  return mpool.findPaneLocation(layoutSlice().arrange, p => p.paneId === slotPaneId()).pane;
}
// The slot's currently ACTIVE instance slice (info / text-view / transcript).
function activeSlice() { return api.getInstanceSlice(slotPaneId()); }
// The slot's poolIds in strip order (the `detail` anchor is index 0, then the
// seeded Info/Transcript, then any opened content tabs).
function slotPoolIds() { return (slotPane().tabs || []).map(t => t.poolId); }
function contentPoolIds() { return slotPoolIds().filter(id => id.startsWith('content-')); }
// Activate a slot tab by pool id (the production set_active_tab path).
function activateTab(poolId) {
  api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: slotPaneId(), tabPoolId: poolId }));
}
// Close a content tab (the production `remove_tab` — what `x` drives on a
// focused content text-view tab).
function closeTab(poolId) {
  api.dispatchMsg(api.wrap('layout', { type: 'remove_tab', paneId: slotPaneId(), tabPoolId: poolId }));
}
// Open content into the slot (mints a text-view position-tab + loads it).
function open(key, label, lines) { feature.addContentTab('g1', key, label, lines); }
// The pool id of whatever tab is CURRENTLY active on the slot.
function activePoolId() { return mpane.poolIdOf(route.activeInstanceOf(slotPaneId())); }

// --- [1] Open → switch → close (the user-facing v0.6.3 bug shape) ------
//
// Open two content tabs. Switch to the FIRST (so the close target is not
// the most-recent one). Close the first. Verify: the slot's active body is
// the surviving sibling's content, not the closed tab's stale text.

describe('[1] close active content tab → body shows sibling, NOT closed-tab stale text', () => {
  it('two tabs open, close the active first → body shows second tab', () => {
    sm.bootFresh();
    open('doc-A', 'A.txt', ['I am A', 'A line 2']);
    open('doc-B', 'B.txt', ['I am B', 'B line 2']);
    // After both opens, active tab is doc-B (last-opened wins — mint activates).
    const poolA = feature._poolId('doc-A');
    const poolB = feature._poolId('doc-B');
    assert(contentPoolIds().includes(poolA), 'doc-A is in the content tab list');
    assert(contentPoolIds().includes(poolB), 'doc-B is in the content tab list');

    // Switch back to doc-A so the close target IS active.
    activateTab(poolA);
    eq(activePoolId(), poolA, 'parked on doc-A');
    eq(displayedLines(activeSlice()).join('\n'), 'I am A\nA line 2', 'body shows A');

    // Close doc-A — the v0.6.3 bug class: the body must not retain A's text
    // after the active tab vanishes.
    closeTab(poolA);

    assert(!contentPoolIds().includes(poolA), 'doc-A entry removed from the slot');
    assert(contentPoolIds().includes(poolB), 'doc-B survives');
    // remove_tab re-activates the previous tab (doc-B here); its body is B's.
    const body = displayedLines(activeSlice()).join('\n');
    assert(!body.includes('I am A'), `body MUST NOT include closed-tab stale text (got: ${JSON.stringify(body.slice(0, 80))})`);
    assert(body.includes('I am B'), 'body shows the surviving sibling');
  });
});

// --- [2] Close last content tab → fall back to Info, body cleared ------

describe('[2] close only content tab → fallback to Info, no stale body', () => {
  it('opens a single tab → close it → active tab is Info, body is not the closed tab text', () => {
    sm.bootFresh();
    open('only-doc', 'only.txt', ['ONLY-DOC-MARKER', 'line 2']);
    const poolId = feature._poolId('only-doc');
    eq(displayedLines(activeSlice()).join('\n'), 'ONLY-DOC-MARKER\nline 2', 'body loaded');
    // Before closing: verify open auto-jumped to the new content tab (the mint
    // activates it). Without this check the post-close fallback assertion is
    // ambiguous — Info is active at boot, so an open-that-didn't-activate
    // regression would mask the close-handler fallback the test catches.
    assert(activePoolId() === poolId, `open must auto-activate the content tab; active=${activePoolId()}`);

    closeTab(poolId);
    // Falls back to the tab immediately BEFORE the closed content tab
    // (mpane.removeTab re-activates nextTabs[min(idx, len-1)]). The content
    // tab sat last, so the fallback is the PERMANENT Transcript tab — a
    // permanent seeded default, NOT a flat "tab 0" and NOT the hidden detail
    // anchor. The load-bearing invariant: the fallback is a permanent tab and
    // the closed content body does not linger.
    const infoPool = `info-${slotPaneId()}`;
    const transPool = `transcript-${slotPaneId()}`;
    const fellBackTo = activePoolId();
    assert(fellBackTo === infoPool || fellBackTo === transPool,
      `fell back to a PERMANENT seeded tab (Info/Transcript); got ${fellBackTo}`);
    eq(fellBackTo, transPool, 'specifically the Transcript tab (the one just before the closed content tab)');
    const body = displayedLines(activeSlice()).join('\n');
    assert(!body.includes('ONLY-DOC-MARKER'),
      `body MUST NOT carry closed-tab marker after fallback (got: ${JSON.stringify(body.slice(0, 80))})`);
  });
});

// --- [3] Close disposes the content tab's instance (per-tab cleanup) ----
//
// R5 was "tabState entry survives a close". Post-P1b each content tab is
// its OWN instance carrying its own scroll/search/cursor, so the cleanup
// is instance DISPOSAL: closing drops the tab-instance, and reopening the
// same key mints a FRESH one (no inherited scroll/cursor/search).

describe('[3] close disposes the tab instance → reopen starts fresh', () => {
  it('reopening same key starts fresh — no inherited scroll/cursor/search', () => {
    sm.bootFresh();
    open('file:notes', 'notes.txt', ['n1', 'n2', 'n3']);
    const poolId = feature._poolId('file:notes');
    const instId = mpane.newPaneId(poolId);
    // Prime this tab's per-instance view-state as if the user had scrolled.
    route.setInstanceSlice(instId, { ...api.getInstanceSlice(instId), scroll: 42, cursor: { line: 2, col: 0 } });
    assert(api.getInstanceSlice(instId).scroll === 42, 'scroll primed');

    closeTab(poolId);
    // The reconcile (run by the dispatch finalizer) disposes the orphaned
    // tab-instance — its per-tab view-state is gone, not lingering.
    assert(!route.getInstance(instId), 'closed tab`s instance disposed (no lingering view-state)');

    // Reopen the SAME key → a fresh instance with default scroll/cursor.
    open('file:notes', 'notes.txt', ['n1', 'n2', 'n3']);
    const reopened = api.getInstanceSlice(mpane.newPaneId(poolId));
    assert(reopened, 'reopened tab minted a fresh instance');
    eq(reopened.scroll, 0, 'fresh scroll (no inherited 42)');
    eq(reopened.cursor, { line: 0, col: 0 }, 'fresh cursor');
  });
});

// --- [4] Close active content tab → clean fallback (no stale body) ------
//
// A7 was "viewerOverride survives a close". The detail-anchor override slot
// is gone post-P1b — a content tab is a plain text-view instance with no
// override. The invariant that survives: closing the ACTIVE content tab
// leaves the fallback tab showing its OWN content, closed instance disposed.

describe('[4] close active content tab → fallback shows its own content, closed instance gone', () => {
  it('closing the active tab of two does not strand the closed tab`s body', () => {
    sm.bootFresh();
    open('doc1', 'doc1', ['x', 'y']);
    open('doc2', 'doc2', ['a', 'b']);
    // Active is doc2 (last opened).
    const pool2 = feature._poolId('doc2');
    const inst2 = mpane.newPaneId(pool2);
    eq(activePoolId(), pool2, 'doc2 active');

    closeTab(pool2);
    assert(!route.getInstance(inst2), 'closed active tab`s instance disposed');
    // Fallback re-activated doc1; its body is doc1's, not doc2's.
    const body = displayedLines(activeSlice()).join('\n');
    assert(body.includes('x'), 'fallback shows doc1`s own content');
    assert(!body.includes('a'), 'no stale doc2 body');
  });
});

// --- [5] Content tabs persist across group switches (no per-group state) -
//
// T27 was "cross-group remove clobbers current-group state". Post-P1b a
// content text-view tab is a SLOT position-tab (like a terminal) — it
// PERSISTS across groups and is NOT group-scoped. So removing an UNRELATED
// (background) content tab leaves the active tab + its body untouched.

describe('[5] removing an unrelated content tab preserves the active tab + body', () => {
  it('closing a background content tab does not touch the active tab`s body/scroll', () => {
    sm.bootFresh();
    require('../../app/runtime').getModel().currentGroup = 'g1';
    open('a', 'a.txt', ['g1-a-content']);
    open('b', 'b.txt', ['g2-b-content']);
    // Active is 'b' (last opened). Park on 'a' as the "current" tab.
    const poolA = feature._poolId('a');
    const poolB = feature._poolId('b');
    activateTab(poolA);
    const before = {
      active: activePoolId(),
      lines: displayedLines(activeSlice()).slice(),
      scroll: activeSlice().scroll,
    };
    // Close the background tab 'b' — must not disturb the parked-on 'a'.
    closeTab(poolB);
    eq(activePoolId(), before.active, 'active tab unchanged by background remove');
    eq(displayedLines(activeSlice()).join('\n'), before.lines.join('\n'), 'body unchanged by background remove');
    eq(activeSlice().scroll, before.scroll, 'scroll unchanged by background remove');
  });
});

// --- [6] Open → render → close → render: full pipeline check ------------
//
// Drive the REAL render() at each step. This is the e2e signal: if any
// cleanup wiring in the close path regresses (the v0.6.3 bug class), the
// rendered frame after close will still contain the closed tab's marker.

describe('[6] live render after close does not paint closed-tab content', () => {
  it('open → render shows marker; close → render no longer shows marker', () => {
    sm.bootFresh();
    open('doc-z', 'Z.txt', ['ZZ-CLOSED-MARKER-ZZ']);
    // Park focus on the content slot so the viewer paints prominently.
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: slotPaneId() }));
    const poolId = feature._poolId('doc-z');
    const before = sm.capture(() => sm.render()).frame;
    assert(/ZZ-CLOSED-MARKER-ZZ/.test(before), 'marker visible before close');

    closeTab(poolId);
    const after = sm.capture(() => sm.render()).frame;
    assert(!/ZZ-CLOSED-MARKER-ZZ/.test(after),
      `marker MUST NOT appear in rendered frame after close. ` +
      `Tail: ${JSON.stringify(after.slice(-200))}`);
  });
});

report();
