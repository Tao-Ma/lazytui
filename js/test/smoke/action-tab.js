/**
 * Smoke — routed-stream action tab e2e lifecycle.
 *
 * The v0.6.2 action-tab arc fixed two user-visible failures:
 *   - "accidental click runs" — clicking the action tab in the strip
 *     re-ran the action instead of just activating the view.
 *   - "lost output on switch-back" — when the user switched off an
 *     action tab while it was streaming, output appended between
 *     leaving and returning was lost (producer was being killed on
 *     tab_switch). The Phase-3 fix kept the producer alive; the
 *     buffer accumulates background lines, and switching back
 *     restores them with scroll bottom-pinned.
 *
 * test-action-tab-buffer.js pins the reducer arms (stream_start,
 * viewer_append, tab_switch) at the unit level. This smoke drives
 * the same surface through the REAL dispatchMsg / runtime.update
 * routing, and asserts on the rendered frame at each handoff — the
 * signal a user actually sees.
 *
 * Run: node js/test/smoke/action-tab.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const api = sm.api;
const { getModel } = require('../../app/runtime');
const pt = require('../../leaves/pane-tabs');
const { displayedLines } = require('../_helpers/viewer-lines');

const VIEWER = 'detail';   // singleton viewer-kind id (route.resolveTarget('viewer') resolves here)

// --- Bundle threaders -----------------------------------------------
//
// Production threads bundle fields (currentGroup, actionTabIdx,
// activeActionTabKey, targetKey) into stream/tab Msgs through
// dispatch/stream.js. For an e2e smoke, we mirror that threading
// inline so the routed reducer arms receive the same shape.

function streamStart(tabKey, groupName, header) {
  const m = getModel();
  // Mirror dispatch/stream.js's bundle shape exactly: actionTabIdx is
  // only included when the stream's group matches the active group
  // (production gates the auto-jump on the same condition). Smoke
  // shouldn't thread a key production omits — a reducer arm branching
  // on `actionTabIdx === undefined` for cross-group would diverge.
  const out = {
    type: 'stream_start',
    header,
    tabKey,
    groupName,
    currentGroup: m.currentGroup,
  };
  if (groupName === m.currentGroup) {
    const slice = api.primarySliceOf(VIEWER);
    const info = pt.flatTabInfo(slice, m, groupName);
    out.actionTabIdx = info.actionTabs.findIndex(([k]) => k === tabKey);
  }
  return api.dispatchMsg(api.wrap(VIEWER, out));
}

function viewerAppend(tabKey, groupName, line) {
  const m = getModel();
  const slice = api.primarySliceOf(VIEWER);
  const active = pt.activeActionTabIn(slice, m, groupName);
  return api.dispatchMsg(api.wrap(VIEWER, {
    type: 'viewer_append',
    line,
    tabKey,
    groupName,
    currentGroup: m.currentGroup,
    activeActionTabKey: active ? active[0] : null,
  }));
}

function tabSwitch(idx) {
  const m = getModel();
  const slice = api.primarySliceOf(VIEWER);
  return api.dispatchMsg(api.wrap(VIEWER, {
    type: 'tab_switch',
    idx,
    targetKey: pt.resolveTabKey(idx, { ...slice, tab: idx }, m),
    currentGroup: m.currentGroup,
  }));
}

// --- Setup ------------------------------------------------------------

function setupActionTab() {
  sm.bootFresh({
    groups: {
      g1: {
        name: 'g1', label: 'G1',
        containers: [],
        actions: {
          'make-check':   { key: 'make-check',   label: 'Test',  script: 'true', tab: 'Test' },
          'other-action': { key: 'other-action', label: 'Other', script: 'true', tab: 'Other' },
        },
        children: [], parent: null, depth: 0, quick: false,
      },
    },
  });
  api.getInstanceSlice('layout').focus = 'pane-detail';
}

// --- [1] stream_start auto-jumps to the action tab + paints the header -

describe('[1] stream_start auto-jumps + header paints in the action tab', () => {
  it('after stream_start, the action tab is active and header is in lines', () => {
    setupActionTab();
    streamStart('make-check', 'g1', '$ make check');
    const slice = api.primarySliceOf(VIEWER);
    // Info=0, Transcript=1, make-check=2 (first action tab).
    eq(slice.tab, 2, 'auto-jumped to make-check (idx 2)');
    assert(displayedLines(slice).length === 1 && displayedLines(slice)[0].includes('make check'),
      `displayedLines(slice) should be [header]; got ${JSON.stringify(displayedLines(slice))}`);
    // Buffer seeded too — the source of truth for re-restore.
    const buf = slice.actionTabBuffers && slice.actionTabBuffers.g1 && slice.actionTabBuffers.g1['make-check'];
    assert(buf && buf.lines.length === 1, 'buffer seeded with header');
  });
});

// --- [2] live appends mirror to displayedLines(slice) while the action tab is active

describe('[2] live appends grow displayedLines(slice) while on the action tab', () => {
  it('two viewer_append calls land in displayedLines(slice) (mirror-on-active)', () => {
    setupActionTab();
    streamStart('make-check', 'g1', '$ make check');
    viewerAppend('make-check', 'g1', 'live-A');
    viewerAppend('make-check', 'g1', 'live-B');
    const s = api.primarySliceOf(VIEWER);
    eq(displayedLines(s).length, 3, '1 header + 2 appends');
    eq(displayedLines(s)[2], 'live-B', 'tail mirrors latest append');
    eq(s.actionTabBuffers.g1['make-check'].lines.length, 3, 'buffer in sync');
  });
});

// --- [3] switch away → background appends survive → switch back ------
//
// The Phase-3 invariant: switching off an action tab MUST NOT kill
// the producer. The buffer should keep growing while the user is
// elsewhere, and re-entry should restore the full live state.

describe('[3] background appends survive switch-away; switch-back restores live state', () => {
  it('off-tab appends grow buffer but not displayedLines(slice); back → full restore + bottom-pinned scroll', () => {
    setupActionTab();
    streamStart('make-check', 'g1', '$ make check');
    viewerAppend('make-check', 'g1', 'pre-1');
    viewerAppend('make-check', 'g1', 'pre-2');
    // Force a small viewport so bottom-pin is meaningful.
    api.primarySliceOf(VIEWER).innerH = 3;

    // Switch to Info (idx 0).
    tabSwitch(0);
    const onInfo = api.primarySliceOf(VIEWER);
    eq(onInfo.tab, 0, 'parked on Info');

    // Background appends — the producer is still alive.
    viewerAppend('make-check', 'g1', 'bg-1');
    viewerAppend('make-check', 'g1', 'bg-2');
    viewerAppend('make-check', 'g1', 'bg-3');

    const offTab = api.primarySliceOf(VIEWER);
    eq(offTab.actionTabBuffers.g1['make-check'].lines.length, 6,
      'buffer grew to 6 while user was off-tab (1 header + 2 pre + 3 bg)');
    assert(!offTab.lines.includes('bg-3'),
      'displayedLines(slice) does NOT mirror background appends while off-tab');

    // Switch back to make-check.
    tabSwitch(2);
    const back = api.primarySliceOf(VIEWER);
    eq(back.tab, 2, 'returned to make-check');
    eq(displayedLines(back).length, 6, 'all six lines restored from buffer');
    eq(displayedLines(back)[5], 'bg-3', 'latest background line is at the tail');
    // Pin innerH separately so the bottom-pin formula isn't tautological
    // (Math.max(0, lines - innerH) collapses to 0=0 when innerH >= lines).
    // The setup at line 150 set innerH=3; if tab_switch resets it,
    // catch that here rather than letting it mask the bottom-pin check.
    eq(back.innerH, 3, 'innerH preserved across tab_switch');
    eq(back.scroll, 3, 'scroll pinned to bottom (6 lines - innerH 3 = scroll 3)');
  });
});

// --- [4] live render reflects the restored buffer ---------------------
//
// Reducer correctness is unit-tested; smoke value is "did the right
// pixels land?" Render after the switch-back must contain the tail of
// the buffered output.

describe('[4] live render after switch-back paints the restored buffer', () => {
  it('post-switch-back frame contains a background-append marker', () => {
    setupActionTab();
    streamStart('make-check', 'g1', '$ make check');
    api.primarySliceOf(VIEWER).innerH = 5;
    tabSwitch(0);    // away
    viewerAppend('make-check', 'g1', 'BG-MARKER-LINE-XYZ');
    tabSwitch(2);    // back

    const frame = sm.capture(() => sm.render()).frame;
    assert(/BG-MARKER-LINE-XYZ/.test(frame),
      `restored frame should paint the background line; tail: ${JSON.stringify(frame.slice(-220))}`);
  });
});

// --- [5] tab_switch preserves the routed-action buffer ----------------
//
// Pins the slice-side half of the v0.6.2 Phase-3 invariant: the
// actionTabBuffers entry survives a tab_switch (a regression that
// nukes the buffer on switch — e.g. setting it to {} — fires here).
//
// The complementary half — that tab_switch does NOT emit a kill_proc
// Cmd (so the running PTY child stays alive) — is verified at the
// reducer level by `test-action-tab-buffer.js` [tab_switch] section,
// which inspects the Cmds returned by `viewer._update` directly. The
// smoke can't observe Cmds from outside the dispatch path without
// reproducing that machinery; the buffer-preservation check here is
// the user-visible consequence the unit test makes machinery for.

describe('[5] tab_switch preserves the actionTabBuffers entry', () => {
  it('buffer length + tail survive a switch off the action tab', () => {
    setupActionTab();
    streamStart('make-check', 'g1', '$ make check');
    viewerAppend('make-check', 'g1', 'pre');
    const bufBefore = api.primarySliceOf(VIEWER).actionTabBuffers.g1['make-check'].lines.slice();
    tabSwitch(0);
    const bufAfter = api.primarySliceOf(VIEWER).actionTabBuffers.g1['make-check'].lines;
    eq(bufAfter.length, bufBefore.length, 'buffer preserved across tab_switch');
    eq(bufAfter[bufAfter.length - 1], bufBefore[bufBefore.length - 1], 'tail unchanged');
  });
});

report();
