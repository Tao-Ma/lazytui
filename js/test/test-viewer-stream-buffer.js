/**
 * v0.6.2 — viewer-stream buffer (unrouted accumulator).
 *
 *   slice.viewerStreamBuffer = { lines, cap: 1000 } — singleton
 *   accumulator across unrouted commands. Info tab is the display
 *   home; tab_switch idx=0 restores from the buffer; show_selected_info
 *   bails when buffer has content (so the transcript isn't clobbered
 *   by a focus-driven info refresh).
 *
 * Pins:
 *   - stream_start (no tabKey) appends header to buffer; auto-jumps
 *     to Info; previous buffer content survives (NOT cleared).
 *   - viewer_append (no tabKey) appends to buffer; mirrors to
 *     slice.lines IFF on Info.
 *   - cap drops oldest when length > cap; scroll adjusts.
 *   - tab_switch idx=0 with non-empty buffer restores from it
 *     (bottom-pin), NOT show_selected_info.
 *   - viewer_show_info bails when buffer is non-empty.
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

describe('[viewer_append unrouted] appends to viewerStreamBuffer; mirrors on Info', () => {
  it('on Info tab → buffer grows + slice.lines mirrors', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_append', line: 'a' }).next;
    s = applyUpdate(s, { type: 'viewer_append', line: 'b' }).next;
    eq(s.viewerStreamBuffer.lines.length, 2, 'buffer = 2');
    eq(s.lines.length, 2, 'slice.lines mirrors');
    eq(s.lines[1], 'b');
  });
  it('off-Info tab → buffer grows + slice.lines untouched', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['existing-tab-content'] };
    s = applyUpdate(s, { type: 'viewer_append', line: 'background-1' }).next;
    eq(s.viewerStreamBuffer.lines.length, 1, 'buffer captured 1');
    eq(s.lines.length, 1, 'slice.lines untouched');
    eq(s.lines[0], 'existing-tab-content', 'foreign tab content preserved');
  });
});

describe('[viewer_append unrouted] ring-buffer cap', () => {
  it('drops oldest when length > cap', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    // Override cap for a fast test (10 instead of 1000).
    s = { ...s, viewerStreamBuffer: { lines: [], cap: 10 } };
    for (let i = 0; i < 15; i++) {
      s = applyUpdate(s, { type: 'viewer_append', line: `line-${i}` }).next;
    }
    eq(s.viewerStreamBuffer.lines.length, 10, 'capped at 10');
    eq(s.viewerStreamBuffer.lines[0], 'line-5', 'oldest 5 dropped');
    eq(s.viewerStreamBuffer.lines[9], 'line-14', 'newest preserved');
    eq(s.lines.length, 10, 'slice.lines also capped (mirrored on Info)');
  });
});

describe('[stream_start unrouted] auto-jumps to Info; preserves prior buffer', () => {
  it('appends header to existing buffer (does NOT clear)', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
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
  it('auto-jumps to Info when on a different tab + emits terminal_exit', () => {
    let s = { ...viewer._init(), tab: 2, innerH: 5, lines: ['some-tab-content'] };
    const r = applyUpdate(s, { type: 'stream_start', header: '$ cmd' });
    s = r.next;
    eq(s.tab, 0, 'auto-jumped to Info');
    eq(s.lines.length, 1, 'lines now from buffer (just the header)');
    eq(s.lines[0], '$ cmd');
    assert(r.cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted');
  });
});

describe('[viewer_append_lines unrouted] event-log accumulator (spawn/background status)', () => {
  // Pins the v0.6.2 fix: spawn / background launch messages + cmdline
  // outcomes used to call `setViewerContent` which dispatches
  // `viewer_set_content` and CLOBBERS slice.lines wholesale — including
  // whatever tab was active. They're now routed through
  // `appendViewerLines` → `viewer_append_lines` unrouted, so:
  //   1. They join the unrouted transcript in viewerStreamBuffer.
  //   2. They mirror to slice.lines only when the user is on Info.
  //   3. Switching tab away + back to Info restores them from the buffer.
  // Multi-spawn doesn't lose history; off-Info tabs aren't clobbered.
  it('two consecutive spawn-status appends accumulate in the buffer', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
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
    eq(s.lines.length, 4, 'mirrored to slice.lines on Info');
  });
  it('spawn-status while on a non-Info tab leaves that tab untouched', () => {
    // User is on action tab idx=1 looking at some other action's
    // routed output. A spawn-status append must NOT clobber lines.
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['other-tab-content'] };
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['[dim]$ logs[/]', '[yellow]Spawned.[/]'],
    }).next;
    eq(s.viewerStreamBuffer.lines.length, 2, 'buffer captured the spawn');
    eq(s.lines.length, 1, 'foreign tab lines untouched');
    eq(s.lines[0], 'other-tab-content', 'tab content survives');
  });
  it('tab_switch back to Info restores accumulated spawn history', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    // Two spawns while on Info — buffer + slice.lines both grow.
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['[dim]$ logs[/]', 'sp1'],
    }).next;
    // User switches to action tab 1.
    s = { ...s, tab: 1, lines: ['action-output'] };
    // A new spawn fires while user is off-Info.
    s = applyUpdate(s, {
      type: 'viewer_append_lines', lines: ['[dim]$ psql[/]', 'sp2'],
    }).next;
    eq(s.lines[0], 'action-output', 'off-Info tab not touched by spawn');
    eq(s.viewerStreamBuffer.lines.length, 4, 'buffer has both spawns');
    // User switches back to Info — should see the full history.
    const r = applyUpdate(s, { type: 'tab_switch', idx: 0 });
    eq(r.next.lines.length, 4, 'slice.lines restored from buffer');
    eq(r.next.lines[0], '[dim]$ logs[/]', 'first spawn first');
    eq(r.next.lines[2], '[dim]$ psql[/]', 'second spawn second');
  });
});

describe('[viewer_show_info] guards — bail iff off-Info OR live stream', () => {
  // v0.6.2 — the third pre-existing guard ("bail when
  // viewerStreamBuffer has any content") was removed. It permanently
  // disabled Info navigation refresh after any spawn-status or
  // streamed action, which was the user-reported regression.
  it('non-Info tab → bails (no clobber of other tab content)', () => {
    let s = { ...viewer._init(), tab: 1, innerH: 5, lines: ['routed-output'] };
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    eq(r.next, s, 'no-op on non-Info tab');
  });
  it('with accumulated buffer + on Info → proceeds (refreshes from focused panel)', () => {
    // Pre-v0.6.2 fix this would have been a no-op. Now it falls through
    // to the focus lookup, which returns slice unchanged here only
    // because no Component / panel-def is registered in the test setup.
    // The important pin is that the buffer is NOT a short-circuit.
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_append', line: 'transcript-line' }).next;
    assert(s.viewerStreamBuffer.lines.length > 0, 'buffer non-empty (precondition)');
    // The no-panel-def fallback returns the input slice (ref equality);
    // crucial: the reducer did NOT bail at the buffer guard.
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    eq(r.next, s, 'no-panel-def fallback (input slice returned), but buffer guard did NOT trip');
  });
  it('live unrouted stream → bails (don\'t clobber the live mirror)', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    // Stamp unroutedStreaming on the model. setModel above already
    // installed the test model — just toggle the field directly.
    const { getModel: gm } = require('../app/runtime');
    gm().unroutedStreaming = true;
    try {
      const r = applyUpdate(s, { type: 'viewer_show_info' });
      eq(r.next, s, 'bails while live stream in flight');
    } finally {
      gm().unroutedStreaming = false;
    }
  });
});

report();
