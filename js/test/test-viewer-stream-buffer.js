/**
 * v0.6.2 — viewer-stream buffer (unrouted accumulator).
 *
 *   slice.viewerStreamBuffer = { lines, cap: 1000 } — singleton
 *   accumulator across unrouted commands. The Transcript tab (last
 *   in the strip) is the display home; tab_switch into Transcript
 *   restores from the buffer (bottom-pin); empty buffer paints a
 *   `(no transcript yet)` placeholder. Info is pure selection-info
 *   and has no relationship to the buffer.
 *
 * Pins:
 *   - stream_start (no tabKey) appends header to buffer; auto-jumps
 *     to Transcript; previous buffer content survives (NOT cleared).
 *   - viewer_append (no tabKey) appends to buffer; mirrors to
 *     slice.lines IFF on Transcript.
 *   - cap drops oldest when length > cap; scroll adjusts.
 *   - tab_switch into Transcript with non-empty buffer restores
 *     from it (bottom-pin); empty buffer → placeholder.
 *   - tab_switch into Info clears + dispatches viewer_show_info
 *     (Cmd routes to the focused Navigator's getInfo).
 *   - viewer_show_info has ONE guard now (off-Info bail); the
 *     pre-v0.6.2 unroutedStreaming + buffer-non-empty guards
 *     retired since Info no longer hosts the buffer.
 *
 * Run: node js/test/test-viewer-stream-buffer.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const viewer = require('../panel/viewer/viewer');
const pt = require('../leaves/pane-tabs');
const { setModel, getModel } = require('../app/runtime');

setModel({
  currentGroup: 'g',
  modes: {},
  config: { groups: { g: { label: 'G', actions: {} } } },
});

function applyUpdate(s, msg) {
  // v0.6.3 Phase 3d: thread targetKey + currentGroup into tab_switch.
  if (msg && msg.type === 'tab_switch' && msg.targetKey == null) {
    const m = getModel();
    msg = {
      ...msg,
      targetKey: pt.resolveTabKey(msg.idx, { ...s, tab: msg.idx }, m),
      currentGroup: m.currentGroup,
    };
  }
  // v0.6.3 Phase D1: thread viewer_set_content bundle.
  if (msg && msg.type === 'viewer_set_content' && msg.fromTabKey === undefined) {
    const m = getModel();
    const patched = {
      ...msg,
      currentGroup: m.currentGroup,
      fromTabKey: pt.resolveTabKey((s.tab | 0), s, m),
    };
    if (typeof msg.tab === 'number') {
      patched.total = pt.flatTabInfo(s, m, m.currentGroup).total;
    }
    msg = patched;
  }
  // Phase D1: stream_start routed branch threads currentGroup +
  // actionTabIdx.
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

// v0.6.2 — viewerStreamBuffer's display home moved from Info (tab 0)
// to a dedicated Transcript tab (idx = total - 1; with no per-group
// tabs in this test's setup, total=2 → transcriptIdx=1).

describe('[viewer_append unrouted] appends to viewerStreamBuffer; mirrors on Transcript', () => {
  it('on Transcript tab → buffer grows + slice.lines mirrors', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_append', line: 'a' }).next;
    s = applyUpdate(s, { type: 'viewer_append', line: 'b' }).next;
    eq(s.viewerStreamBuffer.lines.length, 2, 'buffer = 2');
    eq(s.lines.length, 2, 'slice.lines mirrors on Transcript');
    eq(s.lines[1], 'b');
  });
  it('off-Transcript tab → buffer grows + slice.lines untouched', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5, lines: ['info-content'] };
    s = applyUpdate(s, { type: 'viewer_append', line: 'background-1' }).next;
    eq(s.viewerStreamBuffer.lines.length, 1, 'buffer captured 1');
    eq(s.lines.length, 1, 'slice.lines untouched');
    eq(s.lines[0], 'info-content', 'foreign tab content preserved');
  });
});

describe('[viewer_append unrouted] ring-buffer cap', () => {
  it('drops oldest when length > cap', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    // Override cap for a fast test (10 instead of 1000).
    s = { ...s, viewerStreamBuffer: { lines: [], cap: 10 } };
    for (let i = 0; i < 15; i++) {
      s = applyUpdate(s, { type: 'viewer_append', line: `line-${i}` }).next;
    }
    eq(s.viewerStreamBuffer.lines.length, 10, 'capped at 10');
    eq(s.viewerStreamBuffer.lines[0], 'line-5', 'oldest 5 dropped');
    eq(s.viewerStreamBuffer.lines[9], 'line-14', 'newest preserved');
    eq(s.lines.length, 10, 'slice.lines also capped (mirrored on Transcript)');
  });
});

describe('[stream_start unrouted] auto-jumps to Transcript; preserves prior buffer', () => {
  it('appends header to existing buffer (does NOT clear)', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    // Pre-seed buffer with a prior run.
    s = applyUpdate(s, { type: 'viewer_append', line: 'prior-line' }).next;
    eq(s.viewerStreamBuffer.lines.length, 1);
    // New stream_start.
    const r = applyUpdate(s, { type: 'stream_start', header: '$ new-cmd' });
    s = r.next;
    eq(s.viewerStreamBuffer.lines.length, 2, 'buffer has prior + header');
    eq(s.viewerStreamBuffer.lines[0], 'prior-line');
    eq(s.viewerStreamBuffer.lines[1], '$ new-cmd');
  });
  it('auto-jumps to Transcript when on a different tab + emits terminal_exit', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5, lines: ['info-content'] };
    const r = applyUpdate(s, { type: 'stream_start', header: '$ cmd' });
    s = r.next;
    eq(s.tab, 1, 'auto-jumped to Transcript (idx 1)');
    eq(s.lines.length, 1, 'lines now from buffer (just the header)');
    eq(s.lines[0], '$ cmd');
    assert(r.cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted');
  });
});

describe('[viewer_append_lines unrouted] event-log accumulator (spawn/background status)', () => {
  // v0.6.2 — spawn / background launch + cmdline-verb outcomes were
  // re-routed from setViewerContent (replace) to appendViewerLines
  // (accumulate). They join the unrouted transcript in
  // viewerStreamBuffer and mirror to slice.lines only when the user
  // is on the Transcript tab. Multi-spawn doesn't lose history.
  it('two consecutive spawn-status appends accumulate in the buffer', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['[dim]$ logs[/]', '[yellow]Spawned in new tmux window.[/]'],
    }).next;
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['[dim]$ psql[/]', '[yellow]Spawned in new tmux window.[/]'],
    }).next;
    eq(s.viewerStreamBuffer.lines.length, 4, 'both spawn messages retained');
    eq(s.viewerStreamBuffer.lines[0], '[dim]$ logs[/]', 'first spawn preserved');
    eq(s.viewerStreamBuffer.lines[2], '[dim]$ psql[/]', 'second spawn after the first');
    eq(s.lines.length, 4, 'mirrored to slice.lines on Transcript');
  });
  it('spawn-status while on a non-Transcript tab leaves that tab untouched', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5, lines: ['info-content'] };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['[dim]$ logs[/]', '[yellow]Spawned.[/]'],
    }).next;
    eq(s.viewerStreamBuffer.lines.length, 2, 'buffer captured the spawn');
    eq(s.lines.length, 1, 'foreign tab lines untouched');
    eq(s.lines[0], 'info-content', 'tab content survives');
  });
  it('tab_switch to Transcript restores accumulated spawn history', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    // Two spawns while on Transcript — buffer + slice.lines both grow.
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['[dim]$ logs[/]', 'sp1'],
    }).next;
    // User switches to Info (tab 0).
    s = { ...s, tab: 0, lines: ['some-info'] };
    // A new spawn fires while user is off-Transcript.
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['[dim]$ psql[/]', 'sp2'],
    }).next;
    eq(s.lines[0], 'some-info', 'off-Transcript tab not touched by spawn');
    eq(s.viewerStreamBuffer.lines.length, 4, 'buffer has both spawns');
    // User switches to Transcript — should see the full history.
    const r = applyUpdate(s, { type: 'tab_switch', idx: 1 });
    eq(r.next.lines.length, 4, 'slice.lines restored from buffer');
    eq(r.next.lines[0], '[dim]$ logs[/]', 'first spawn first');
    eq(r.next.lines[2], '[dim]$ psql[/]', 'second spawn second');
  });
});

describe('[viewer_show_info] — only off-Info guard remains', () => {
  // v0.6.2 — Info is now PURE selection-info (Transcript hosts the
  // unrouted accumulator). Pre-fix had three guards (off-Info,
  // unroutedStreaming, buffer-non-empty); only off-Info survives.
  it('non-Info tab → bails (no clobber of other tab content)', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['transcript-content'] };
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    eq(r.next, s, 'no-op on non-Info tab');
  });
  it('on Info with non-empty buffer → proceeds (no buffer short-circuit)', () => {
    // Pre-fix this would have been a no-op. Now Info is independent
    // of the buffer; show_info proceeds to focus lookup. The test
    // setup has no Component/panel-def registered, so the no-panel-
    // def fallback returns the input slice unchanged — the
    // important pin is that the buffer is NOT consulted.
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_append', line: 'transcript-line' }).next;
    assert(s.viewerStreamBuffer.lines.length > 0, 'buffer non-empty (precondition)');
    // Switch to Info; show_info should not short-circuit on the buffer.
    s = { ...s, tab: 0, lines: [] };
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    eq(r.next, s, 'no-panel-def fallback (input slice returned), buffer guard absent');
  });
});

describe('[T3c per-tab search] tab remembers its search state across switches', () => {
  it('search state survives a tab switch round-trip', () => {
    // Park on Transcript with content. Enter and commit a search.
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['foo', 'BAR', 'baz', 'BAR again', 'qux'],
    }).next;
    s = applyUpdate(s, { type: 'viewer_search_enter' }).next;
    s = applyUpdate(s, { type: 'viewer_search_key', seq: 'B' }).next;
    s = applyUpdate(s, { type: 'viewer_search_key', seq: 'A' }).next;
    s = applyUpdate(s, { type: 'viewer_search_key', seq: 'R' }).next;
    s = applyUpdate(s, { type: 'viewer_search_commit' }).next;
    eq(s.search.active, true, 'search committed');
    eq(s.search.term, 'BAR', 'term set');
    eq(s.search.matches.length, 2, 'two matches');
    // Switch to Info, then back to Transcript.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.search.active, false, 'Info search starts fresh (default empty)');
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.search.active, true, 'Transcript search restored');
    eq(s.search.term, 'BAR', 'term restored');
    eq(s.search.matches.length, 2, 'matches restored');
  });
  it('first-visit tab gets a fresh empty search', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    // No prior interactions on this tab. tab_switch to it sets a
    // clean search state.
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.search.active, false);
    eq(s.search.term, '');
    eq(s.search.matches.length, 0);
  });
});

describe('[T3d per-tab select] tab remembers its visual selection across switches', () => {
  it('select state survives tab switch round-trip', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['a', 'b', 'c', 'd', 'e'],
    }).next;
    // Begin a selection on Transcript at (1,0)→(3,0).
    s = applyUpdate(s, { type: 'select_begin', line: 1, col: 0, kind: 'char' }).next;
    s = applyUpdate(s, { type: 'select_extend', line: 3, col: 0 }).next;
    eq(s.select.active, true, 'select active');
    eq(s.select.anchor.line, 1, 'anchor at line 1');
    eq(s.select.cursor.line, 3, 'cursor at line 3');
    // Switch to Info, then back.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.select.active, false, 'Info has fresh default select');
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.select.active, true, 'Transcript select restored');
    eq(s.select.anchor.line, 1);
    eq(s.select.cursor.line, 3);
  });
});

describe('[T3e per-tab cursor] tab remembers its cursor position across switches', () => {
  it('cursor state survives tab switch round-trip', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['line0', 'line1', 'line2', 'line3', 'line4'],
    }).next;
    // Begin select to move the cursor as a side effect (the
    // _beginSelect helper writes cursor too).
    s = applyUpdate(s, { type: 'select_begin', line: 2, col: 3, kind: 'char' }).next;
    eq(s.cursor.line, 2, 'cursor at line 2');
    eq(s.cursor.col, 3, 'cursor at col 3');
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.cursor.line, 0, 'Info has fresh default cursor');
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.cursor.line, 2, 'Transcript cursor restored');
    eq(s.cursor.col, 3);
  });
});

describe('[T3f-fix per-tab capture on stream_start bypass]', () => {
  // T3f as initially shipped captured FROM-tab state only in
  // tab_switch — bypass paths (stream_start auto-jump, viewer_set_tab)
  // lost that state. T3f-fix moves the capture to the finalizer,
  // detecting slice.tab change in any reducer arm. This pins the
  // bypass-case behavior.
  it('stream_start auto-jump (bypassing tab_switch) captures from-tab state', () => {
    // User on Transcript, scrolled to a specific position.
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    }).next;
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    eq(s.scroll, 0, 'on Transcript at scroll 0');
    // Now an UNROUTED stream_start fires — auto-jumps to Transcript
    // (we're already on Transcript, so no transition). Use a routed
    // one to action tab idx 2 instead — that's a true bypass.
    // No actions configured here, so the routed branch falls through.
    // Easier: directly fire viewer_set_tab as the bypass primitive.
    s = applyUpdate(s, { type: 'viewer_set_tab', tab: 0 }).next;
    eq(s.tab, 0, 'now on Info via the viewer_set_tab bypass');
    // Despite NOT going through tab_switch, the finalizer should have
    // captured Transcript's view state.
    eq(s.tabState.transcript.scroll, 0, 'from-tab scroll captured even via bypass');
    eq(s.tabState.transcript.bottomSticky, false, 'sticky captured (was at top)');
    // Round-trip back via tab_switch — Transcript scroll restored.
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.scroll, 0, 'Transcript scroll restored after bypass + round-trip');
  });
});

describe('[T3b per-tab scroll] tab remembers its scroll across switches', () => {
  // The fragility T3 is solving: pre-T3, slice.scroll was shared by
  // all tabs. Scrolling Build to line 500, switching to Info, switching
  // back to Build = scroll reset (tab_switch arm bottom-pinned).
  // Post-T3 each tab remembers its scroll independently. T3f makes
  // tab_switch the sole sync point (lazy persistence) — no per-Msg
  // tabState mirroring.
  it('Transcript user-scrolled position survives a tab switch', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }).next;
    eq(s.scroll, Math.max(0, 7 - 3), 'bottom-pinned post-append');
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    eq(s.scroll, 0, 'scrolled to top');
    // T3f: tabState.transcript is written when we switch AWAY (not
    // per-Msg). End-to-end behavior is what matters — switch + back
    // restores the user's scroll position.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.tabState.transcript.scroll, 0, 'switch-out captured Transcript scroll');
    eq(s.tabState.transcript.bottomSticky, false, 'sticky disarmed (was at top, not bottom)');
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.scroll, 0, 'scroll restored to user-scrolled position (not bottom-pinned)');
  });
  it('Transcript bottom-stuck position re-snaps to new tail after background appends', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['a', 'b', 'c'],
    }).next;
    eq(s.scroll, 0, 'bottom of 3 lines with innerH 3 is scroll 0');
    // Switch off — tab_switch captures bottomSticky=true (scroll was
    // at maxScroll). Background growth simulated by direct buffer poke.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.tabState.transcript.bottomSticky, true, 'sticky armed on switch-out');
    s = {
      ...s,
      viewerStreamBuffer: { lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], cap: 1000 },
    };
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.scroll, Math.max(0, 7 - 3), 're-snapped to new bottom (sticky honored)');
  });
});

describe('[tab_switch] Info vs Transcript routing', () => {
  it('switch to Info parks on tab 0 + emits viewer_show_info', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['transcript-content'] };
    const { next, cmds } = applyUpdate(s, { type: 'tab_switch', idx: 0 });
    eq(next.tab, 0, 'tab=0 (Info)');
    eq(next.scroll, 0, 'scroll reset');
    // v0.6.2 N2 — slice.lines is finalizer-derived. For Info, the
    // finalizer's _infoFromFocus reads the focused Navigator's
    // getInfo; this unit test doesn't set up a focused def, so the
    // viewerLines fallback returns slice.lines (the seeded value).
    // The actual clear arrives via the viewer_show_info Cmd
    // dispatched below (production: cascades and resolves
    // _infoFromFocus → real Info content).
    assert(
      cmds.some(c => c.type === 'msg' && c.msg && c.msg.msg && c.msg.msg.type === 'viewer_show_info'),
      'viewer_show_info Cmd dispatched (focused-panel refresh)'
    );
  });
  it('switch to Transcript with empty buffer shows placeholder', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5, lines: ['info-content'] };
    const { next } = applyUpdate(s, { type: 'tab_switch', idx: 1 });
    eq(next.tab, 1, 'tab=1 (Transcript)');
    eq(next.lines.length, 1, 'placeholder line');
    assert(next.lines[0].includes('no transcript yet'), 'placeholder text');
  });
  it('switch to Transcript with non-empty buffer restores from it', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    // Seed buffer.
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['a', 'b', 'c', 'd', 'e'],
    }).next;
    // Switch to Info, then back to Transcript.
    s = { ...s, tab: 0, lines: [] };
    const { next } = applyUpdate(s, { type: 'tab_switch', idx: 1 });
    eq(next.tab, 1);
    eq(next.lines.length, 5, 'restored from buffer');
    eq(next.scroll, Math.max(0, 5 - 3), 'bottom-pin scroll');
  });
});

describe('[B2 viewer_set_tab inbound restore] producer-initiated set-tab restores tabState[toKey]', () => {
  // Pre-B2: viewer_set_tab wrote only `{...slice, tab}` — slice.scroll/
  // search/select/cursor retained the LEAVING tab's values. After
  // setActiveTab(N), the user landed on tab N with stale per-tab view
  // state. Post-B2: viewer_set_tab restores tabState[toKey] same as
  // tab_switch (minus the cascade effects), unless viewerOverride is
  // active (override owns the view state).
  it('Transcript→Info via viewer_set_tab restores Info\'s stored scroll', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    // Land on Transcript at top, prime tabState['info'] = {scroll: 7}.
    s = { ...s, tabState: { info: { scroll: 7 } } };
    s = applyUpdate(s, { type: 'viewer_append_lines', lines: ['a','b','c','d','e','f','g','h','i','j'] }).next;
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    eq(s.scroll, 0, 'Transcript at top');
    // Producer set-tab to Info.
    s = applyUpdate(s, { type: 'viewer_set_tab', tab: 0 }).next;
    eq(s.tab, 0, 'on Info');
    eq(s.scroll, 7, 'Info\'s stored scroll restored, not Transcript\'s 0');
  });
  it('viewer_set_tab with active override preserves slice.scroll (override owns view state)', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    // On Transcript at the bottom; tabState['info'] already has scroll: 42.
    s = { ...s, tabState: { info: { scroll: 42 } } };
    s = applyUpdate(s, { type: 'viewer_append_lines', lines: ['a','b','c','d','e'] }).next;
    eq(s.scroll, Math.max(0, 5 - 3), 'Transcript bottom-pinned');
    // Producer writes override (viewer_set_content commits scroll: 0)
    // then issues viewer_set_tab. The combined effect: stay on the
    // override's scroll: 0, NOT restore tabState['info'].scroll=42.
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['override line 1', 'override line 2'] }).next;
    eq(s.scroll, 0, 'override-writer set scroll: 0');
    s = applyUpdate(s, { type: 'viewer_set_tab', tab: 0 }).next;
    eq(s.tab, 0, 'on Info');
    eq(s.scroll, 0, 'override-bound scroll preserved (NOT clobbered by tabState[\'info\'].scroll=42)');
    assert(s.viewerOverride && s.viewerOverride.lines.length === 2, 'override still active');
  });
  it('finalizer skips FROM-capture when leaving slice had viewerOverride active', () => {
    // Without this guard, a producer doing viewer_set_content (scroll:0)
    // then viewer_set_tab(0) would write tabState['g:action:foo']={scroll:0}
    // over the user's real saved Build scroll. Test: be on action:foo at
    // scroll 100, override fires, set-tab to Info — tabState['g:action:foo']
    // must keep its saved scroll, not the override's 0.
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: { build: { label: 'Build', tab: 'Build', script: 'make' } } } } },
    });
    let s = { ...viewer._init(), tab: 2, innerH: 3, scroll: 100, lines: ['x','y','z'] };
    s = { ...s, tabState: { 'g:action:build': { scroll: 100 } } };
    // Producer writes override (scroll → 0, viewerOverride set).
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['note1', 'note2'] }).next;
    eq(s.scroll, 0, 'override committed scroll: 0');
    assert(s.viewerOverride, 'override active');
    // Producer's viewer_set_tab(0). Finalizer detects tab transition (2→0)
    // but originalSlice.viewerOverride was active — skip FROM-capture.
    const beforeAction = s.tabState['g:action:build'];
    s = applyUpdate(s, { type: 'viewer_set_tab', tab: 0 }).next;
    eq(s.tab, 0, 'on Info');
    eq(s.tabState['g:action:build'].scroll, 100, 'tabState[g:action:build] PRESERVED (not clobbered by override-bound 0)');
    eq(beforeAction.scroll, 100, 'sanity: was 100 before');
  });
});

describe('[B4 group-qualified tabState keys] two groups sharing an action name don\'t collide', () => {
  // Pre-B4 keys were 'action:<key>'. Two groups both having a `test`
  // action would share tabState['action:test'] — group A's view state
  // restored when the user landed on group B's `test` tab. Post-B4
  // keys are '<group>:action:<key>', so the two are addressed
  // independently. Info / Transcript stay unprefixed.
  it('action tab in group A vs group B store + restore independently', () => {
    setModel({
      currentGroup: 'g1',
      modes: {},
      config: { groups: {
        g1: { label: 'G1', actions: { test: { label: 'Test', tab: 'Test', script: 'echo a' } } },
        g2: { label: 'G2', actions: { test: { label: 'Test', tab: 'Test', script: 'echo b' } } },
      } },
    });
    // Land on g1's `test` tab (idx 2). Route a stream into g1.test's
    // buffer so the action tab has content (viewer_scroll clamps to 0
    // otherwise — viewerLines returns empty for an unseeded action tab).
    let s = { ...viewer._init(), tab: 2, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      tabKey: 'test', groupName: 'g1',
      lines: Array.from({length: 80}, (_, i) => `g1-line-${i}`),
    }).next;
    // Set a known scroll (the routed append doesn't bottom-pin since
    // it's not the user's active source... actually it does for active
    // tab — scroll back to a deterministic position).
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    s = applyUpdate(s, { type: 'viewer_scroll', delta: 30 }).next;
    eq(s.scroll, 30, 'g1.test scrolled to 30');
    // Leave g1.test via tab_switch — finalizer captures.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.tabState['g1:action:test'].scroll, 30, 'g1:action:test captured at 30');
    assert(!('action:test' in s.tabState), 'unprefixed action:test NOT used (would be collision)');
    // Switch groups to g2; viewer_reset_chrome fires.
    setModel({ ...require('../app/runtime').getModel(), currentGroup: 'g2' });
    s = applyUpdate(s, { type: 'viewer_reset_chrome' }).next;
    // Seed g2's `test` buffer (same idx 2 in the strip, but DIFFERENT key).
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      tabKey: 'test', groupName: 'g2',
      lines: Array.from({length: 80}, (_, i) => `g2-line-${i}`),
    }).next;
    s = applyUpdate(s, { type: 'tab_switch', idx: 2 }).next;
    eq(s.tab, 2, 'on g2.test');
    // First visit to g2.test — no stored state in tabState['g2:action:test'].
    // Must NOT have inherited g1.test's scroll=30 (would be true if keys collided).
    // Now scroll g2.test to a different position, capture on leave.
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    s = applyUpdate(s, { type: 'viewer_scroll', delta: 60 }).next;
    eq(s.scroll, 60, 'g2.test scrolled to 60');
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    // Both g1's and g2's saved positions coexist.
    eq(s.tabState['g1:action:test'].scroll, 30, 'g1:action:test preserved across group switch');
    eq(s.tabState['g2:action:test'].scroll, 60, 'g2:action:test recorded independently');
  });
  it('R4: stream_start auto-jump drops tabState for the reset buffer', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: { build: { label: 'Build', tab: 'Build', script: 'make' } } } } },
    });
    // Seed: user previously visited Build, captured search matches
    // referencing line 80 of the (then-)buffer's content.
    let s = { ...viewer._init(), tab: 0, innerH: 3 };
    s = {
      ...s,
      tabState: {
        'g:action:build': {
          scroll: 80,
          search: { active: true, term: 'foo', matches: [{ line: 80, col: 0 }], idx: 0, typing: '' },
        },
      },
    };
    // Fresh stream_start re-runs Build → buffer resets to [header].
    const r = applyUpdate(s, { type: 'stream_start', tabKey: 'build', groupName: 'g', header: '$ make' });
    eq(r.next.tab, 2, 'auto-jumped to Build');
    assert(!('g:action:build' in r.next.tabState), 'tabState[g:action:build] dropped (matches reference pre-reset positions)');
    eq(r.next.search.active, false, 'slice.search reset on auto-jump landing');
    eq(r.next.scroll, 0, 'scroll reset');
  });
  it('R4: stream_start cross-group drops the target\'s tabState even without auto-jump', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: {
        g:  { label: 'G',  actions: {} },
        g2: { label: 'G2', actions: { build: { label: 'Build', tab: 'Build', script: 'make' } } },
      } },
    });
    let s = { ...viewer._init(), tab: 0, innerH: 3 };
    s = {
      ...s,
      tabState: {
        'g2:action:build': { scroll: 50, search: { active: true, term: 'x', matches: [{ line: 50, col: 0 }], idx: 0, typing: '' } },
      },
    };
    const r = applyUpdate(s, { type: 'stream_start', tabKey: 'build', groupName: 'g2', header: '$ make' });
    eq(r.next.tab, 0, 'no auto-jump (cross-group)');
    assert(!('g2:action:build' in r.next.tabState), 'tabState dropped for cross-group target too');
  });
  it('B5: group-switch cascade emits viewer_reset_chrome BEFORE set_current_group', () => {
    // Round 2 adversarial finding: the finalizer's FROM-tab key
    // resolution reads getModel().currentGroup. If set_current_group
    // runs first, currentGroup is the NEW group by the time
    // viewer_reset_chrome's finalizer captures — so the FROM-tab state
    // lands under the WRONG group's key (poisoning the new group AND
    // losing the old group's saved state).
    // Fix: emit viewer_reset_chrome FIRST so currentGroup still holds
    // the OLD value at finalizer-time.
    const groups = require('../panel/navigator/groups');
    setModel({
      currentGroup: 'g1',
      modes: {},
      config: { groups: {
        g1: { label: 'G1', actions: {}, items: [{ name: 'a' }, { name: 'b' }] },
        g2: { label: 'G2', actions: {}, items: [{ name: 'c' }] },
      } },
    });
    // The groups Component's groups_selected emits the cascade. Build a
    // slice with two group rows + simulate moving to index 1.
    const initialSlice = groups.init();
    // Recompute to populate slice.list (the groups Component's
    // groups_recompute Msg).
    const rec = groups._update({ type: 'groups_recompute' }, initialSlice);
    const slice = Array.isArray(rec) ? rec[0] : rec;
    // Dispatch groups_selected with the new index.
    const res = groups._update({ type: 'groups_selected', index: 1 }, slice);
    const cmds = Array.isArray(res) ? res[1] : [];
    // Find the indices of the three relevant Cmds in the cascade.
    const resetChromeIdx = cmds.findIndex(c =>
      c.type === 'msg' && c.msg && c.msg.msg && c.msg.msg.type === 'viewer_reset_chrome');
    const setGroupIdx = cmds.findIndex(c =>
      c.type === 'msg' && c.msg && c.msg.type === 'set_current_group');
    const resetCtxIdx = cmds.findIndex(c =>
      c.type === 'msg' && c.msg && c.msg.type === 'reset_group_context');
    assert(resetChromeIdx >= 0, 'viewer_reset_chrome Cmd present');
    assert(setGroupIdx >= 0, 'set_current_group Cmd present');
    assert(resetCtxIdx >= 0, 'reset_group_context Cmd present');
    assert(resetChromeIdx < setGroupIdx,
      `viewer_reset_chrome (idx ${resetChromeIdx}) MUST be before set_current_group (idx ${setGroupIdx}) — B5 contract`);
    assert(setGroupIdx < resetCtxIdx,
      `set_current_group (idx ${setGroupIdx}) before reset_group_context (idx ${resetCtxIdx}) — existing order`);
  });
  it('Info and Transcript are unprefixed (group-independent)', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, { type: 'viewer_append_lines', lines: ['a','b','c','d','e'] }).next;
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    eq(s.tabState.transcript.scroll, 0, 'transcript key is unprefixed');
    assert(!('g:transcript' in s.tabState), 'no group-prefixed transcript');
  });
});

describe('[R6c viewer_set_content msg.tab] override + tab landing in one Msg', () => {
  // Pre-R6 history.replay dispatched viewer_set_content + viewer_set_tab
  // as two imperative side effects. Post-R6 the optional msg.tab on
  // viewer_set_content lets the producer commit both in one reducer
  // pass.
  it('msg.tab set: writes both override and tab in one Msg', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 3, innerH: 3 };
    const r = applyUpdate(s, { type: 'viewer_set_content', lines: ['doc line 1', 'doc line 2'], tab: 0 });
    eq(r.next.tab, 0, 'tab updated by msg.tab');
    assert(r.next.viewerOverride && r.next.viewerOverride.lines.length === 2, 'override set');
    eq(r.next.scroll, 0, 'scroll reset');
  });
  it('msg.tab omitted: tab unchanged (backward-compat)', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 3, innerH: 3 };
    const r = applyUpdate(s, { type: 'viewer_set_content', lines: ['doc'] });
    eq(r.next.tab, 3, 'tab preserved when msg.tab omitted');
    assert(r.next.viewerOverride, 'override set');
  });
  it('B6: msg.tab omitted captures pre-override view-state into tabState[currentKey]', () => {
    // Round 2 adversarial finding: when viewer_set_content fires
    // without msg.tab, slice.tab doesn't change → no transition →
    // finalizer skips capture → the user's pre-override
    // {scroll, search, select, cursor} on the current tab is
    // silently destroyed (clobbered to scroll: 0 / search cleared
    // by the in-place override-arm).
    // Fix: arm captures into tabState BEFORE clobbering, gated by
    // !slice.viewerOverride (first-arming only) && msg.tab absent
    // (transition path handled by the finalizer).
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: { build: { label: 'Build', tab: 'Build', script: 'echo b' } } } } },
    });
    let s = {
      ...viewer._init(),
      tab: 2,
      scroll: 30,
      innerH: 5,
      search: { active: true, term: 'foo', matches: [{line:30,col:0}], idx:0, typing:'' },
    };
    // Producer fires viewer_set_content WITHOUT msg.tab (e.g.
    // same-group background job's info card, config-status diff,
    // ?-help on a non-Info tab).
    const r = applyUpdate(s, { type: 'viewer_set_content', lines: ['override line'] });
    eq(r.next.tab, 2, 'tab unchanged (no msg.tab)');
    eq(r.next.scroll, 0, 'scroll clobbered (override-arming write)');
    eq(r.next.search.active, false, 'search cleared');
    assert(r.next.viewerOverride, 'override set');
    // The critical assertion: pre-override state was captured.
    assert(r.next.tabState && r.next.tabState['g:action:build'],
      'pre-override state captured into tabState[g:action:build]');
    eq(r.next.tabState['g:action:build'].scroll, 30,
      'pre-override scroll=30 preserved');
    eq(r.next.tabState['g:action:build'].search.term, 'foo',
      'pre-override search "foo" preserved');
  });
  it('R13: viewer_set_content rejects negative / out-of-range msg.tab', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },  // total = 2
    });
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    // Negative tab is silently dropped (slice.tab preserved).
    const r1 = applyUpdate(s, { type: 'viewer_set_content', lines: ['x'], tab: -5 });
    eq(r1.next.tab, 1, 'negative tab rejected, slice.tab preserved');
    assert(r1.next.viewerOverride, 'override still set');
    // Out-of-range positive tab is also dropped.
    const r2 = applyUpdate(s, { type: 'viewer_set_content', lines: ['x'], tab: 99 });
    eq(r2.next.tab, 1, 'out-of-range tab rejected');
  });
  it('R13: viewer_set_tab rejects negative / out-of-range msg.tab', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },  // total = 2
    });
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    const r1 = applyUpdate(s, { type: 'viewer_set_tab', tab: -1 });
    eq(r1.next.tab, 1, 'negative tab rejected — slice unchanged');
    assert(r1.next === s || r1.next.tab === 1, 'no-op on out-of-range');
    const r2 = applyUpdate(s, { type: 'viewer_set_tab', tab: 99 });
    eq(r2.next.tab, 1, 'out-of-range positive tab rejected');
  });
  it('B6: subsequent viewer_set_content (override already active) does NOT re-capture', () => {
    // When the override is rewritten (e.g., next history.replay
    // immediately following the first), originalSlice.viewerOverride
    // is already set — capturing again would clobber the first
    // capture's pre-override state with the override-bound scroll: 0.
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: { build: { label: 'Build', tab: 'Build', script: 'echo b' } } } } },
    });
    // First arming: capture the pre-override state.
    let s = { ...viewer._init(), tab: 2, scroll: 30, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['doc 1'] }).next;
    eq(s.tabState['g:action:build'].scroll, 30, 'first arming captured scroll=30');
    // Second arming: override already set. Must NOT overwrite tabState.
    const r = applyUpdate(s, { type: 'viewer_set_content', lines: ['doc 2'] });
    eq(r.next.tabState['g:action:build'].scroll, 30,
      'second arming preserves the pre-override capture (no double-capture clobber)');
  });
});

describe('[B3 viewerOverride clear] tab-transitioning arms drop the stale override', () => {
  // Pre-B3, only tab_switch cleared slice.viewerOverride. Three other
  // arms also mutate slice.tab but skipped the clear:
  //   - stream_start routed (auto-jump to action tab)
  //   - stream_start unrouted (auto-jump to Transcript)
  //   - viewer_reset_chrome (group switch resets tab to 0)
  // Visible repro: open Running overlay, activate a background job
  // (writes override via setViewerContent), then trigger any routed
  // action — the stream auto-jumps to the action tab but the user
  // keeps seeing the background-job info card painted from
  // viewerOverride while bytes silently fill an off-screen
  // actionTabBuffers entry.
  it('stream_start routed auto-jump clears viewerOverride', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: { build: { label: 'Build', tab: 'Build', script: 'make' } } } } },
    });
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['override line'] }).next;
    assert(s.viewerOverride, 'override armed');
    const r = applyUpdate(s, { type: 'stream_start', tabKey: 'build', groupName: 'g', header: '$ make' });
    eq(r.next.tab, 2, 'auto-jumped to action tab idx 2');
    eq(r.next.viewerOverride, null, 'override cleared by routed auto-jump');
  });
  it('stream_start routed cross-group (no auto-jump) preserves viewerOverride', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: {
        g:  { label: 'G',  actions: {} },
        g2: { label: 'G2', actions: { build: { label: 'Build', tab: 'Build', script: 'make' } } },
      } },
    });
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['override'] }).next;
    // Stream targets g2 while currentGroup is g — no auto-jump.
    const r = applyUpdate(s, { type: 'stream_start', tabKey: 'build', groupName: 'g2', header: '$ make' });
    eq(r.next.tab, 0, 'no transition (cross-group)');
    assert(r.next.viewerOverride, 'override survives — no auto-jump means no dismissal');
  });
  it('stream_start unrouted auto-jump to Transcript clears viewerOverride', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['override'] }).next;
    assert(s.viewerOverride, 'override armed');
    const r = applyUpdate(s, { type: 'stream_start', header: '$ docker ps' });
    eq(r.next.tab, 1, 'auto-jumped to Transcript');
    eq(r.next.viewerOverride, null, 'override cleared by unrouted auto-jump');
  });
  it('B7: stream_start unrouted auto-jump resets slice.{search, select, cursor}', () => {
    // Round 2 finding: the routed branch resets these fields on the
    // auto-jump landing (R4 — landing on fresh buffer); the unrouted
    // branch was the asymmetric oversight. Pre-B7 the FROM-tab's
    // search-matches / visual-mode anchors painted highlights and
    // selection rectangle on Transcript content using wrong-content
    // line/col positions.
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    // User on a content tab with active visual select + search.
    let s = {
      ...viewer._init(),
      tab: 2, innerH: 5,
      search: { active: true, term: 'err', matches: [{line:3,col:0,len:3}], idx:0, typing:'' },
      select: { active: true, kind: 'char', anchor: {line:3,col:0}, cursor: {line:5,col:4} },
      cursor: { line: 5, col: 4 },
    };
    const r = applyUpdate(s, { type: 'stream_start', header: '$ docker ps' });
    eq(r.next.tab, 1, 'auto-jumped to Transcript');
    eq(r.next.search.active, false, 'search reset');
    eq(r.next.search.matches.length, 0, 'matches cleared');
    eq(r.next.select.active, false, 'select reset');
    eq(r.next.cursor.line, 0, 'cursor reset to {0,0}');
  });
  it('A5 (supersedes earlier B3 contract): stream_start unrouted while ALREADY on Transcript CLEARS override', () => {
    // Pre-A5: B3's no-transition branch preserved the override on the
    // assumption "user can dismiss explicitly." But viewerLines
    // consults viewerOverride FIRST, so the new stream's bytes
    // accumulated invisibly behind the override — UX trap. Post-A5:
    // the stream is the takeover gesture; override yields. Symmetric
    // with the auto-jump branch above.
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 1, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['override'] }).next;
    const r = applyUpdate(s, { type: 'stream_start', header: '$ docker ps' });
    eq(r.next.tab, 1, 'still on Transcript (no transition)');
    eq(r.next.viewerOverride, null, 'override cleared by stream takeover');
  });
  it('viewer_reset_chrome (group switch) clears viewerOverride', () => {
    setModel({
      currentGroup: 'g',
      modes: {},
      config: { groups: { g: { label: 'G', actions: {} } } },
    });
    let s = { ...viewer._init(), tab: 2, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_set_content', lines: ['per-group override'] }).next;
    assert(s.viewerOverride, 'override armed');
    const r = applyUpdate(s, { type: 'viewer_reset_chrome' });
    // viewer_reset_chrome returns either a slice OR [slice, effects]
    // depending on whether tabListMode was set; in this scenario it's not.
    const next = Array.isArray(r.next) ? r.next[0] : r.next;
    eq(next.tab, 0, 'tab reset to Info');
    eq(next.viewerOverride, null, 'group-switch dismisses the override');
  });
});

report();
