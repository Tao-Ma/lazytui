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
const { setModel } = require('../app/runtime');

setModel({
  currentGroup: 'g',
  modes: {},
  config: { groups: { g: { label: 'G', actions: {} } } },
});

function applyUpdate(s, msg) {
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

describe('[T3b per-tab scroll] tab remembers its scroll across switches', () => {
  // The fragility T3 is solving: pre-T3, slice.scroll was shared by
  // all tabs. Scrolling Build to line 500, switching to Info, switching
  // back to Build = scroll reset (tab_switch arm bottom-pinned).
  // Post-T3 each tab remembers its scroll independently.
  it('Transcript user-scrolled position survives a tab switch', () => {
    // Start on Transcript with a populated buffer.
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }).next;
    // Initially bottom-pinned (sticky on append).
    eq(s.scroll, Math.max(0, 7 - 3), 'bottom-pinned post-append');
    // User scrolls up.
    s = applyUpdate(s, { type: 'viewer_scroll', to: 'top' }).next;
    eq(s.scroll, 0, 'scrolled to top');
    eq(s.tabState.transcript.scroll, 0, 'per-tab scroll stored');
    eq(s.tabState.transcript.bottomSticky, false, 'sticky disarmed (not at bottom)');
    // Switch to Info, then back to Transcript.
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.scroll, 0, 'scroll restored to user-scrolled position (not bottom-pinned)');
  });
  it('Transcript bottom-stuck position re-snaps to new tail after background appends', () => {
    // User was at bottom of a 3-line buffer; switches away; buffer grows
    // to 7 lines; switches back. Should snap to the new bottom, not
    // restore the literal scroll (0, which is no longer the bottom).
    let s = { ...viewer._init(), tab: 1, innerH: 3 };
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['a', 'b', 'c'],
    }).next;
    eq(s.scroll, 0, 'bottom of 3 lines with innerH 3 is scroll 0');
    eq(s.tabState.transcript.bottomSticky, true, 'sticky armed (was at bottom)');
    // Switch off; simulate background growth via direct buffer poke
    // (matches off-tab append semantics — buffer grows, tabState is
    // unchanged because the active branch didn't fire).
    s = applyUpdate(s, { type: 'tab_switch', idx: 0 }).next;
    s = {
      ...s,
      viewerStreamBuffer: { lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], cap: 1000 },
    };
    // Switch back — sticky should re-snap to the new bottom.
    s = applyUpdate(s, { type: 'tab_switch', idx: 1 }).next;
    eq(s.scroll, Math.max(0, 7 - 3), 're-snapped to new bottom (sticky honored)');
  });
});

describe('[tab_switch] Info vs Transcript routing', () => {
  it('switch to Info clears lines and emits viewer_show_info', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['transcript-content'] };
    const { next, cmds } = applyUpdate(s, { type: 'tab_switch', idx: 0 });
    eq(next.tab, 0, 'tab=0 (Info)');
    eq(next.lines.length, 0, 'lines cleared');
    eq(next.scroll, 0, 'scroll reset');
    // Cmd is `{ type:'msg', msg: { to:'detail', msg: { type:'viewer_show_info' } } }`
    // — wrap() envelopes the inner Msg with the pane id.
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

report();
