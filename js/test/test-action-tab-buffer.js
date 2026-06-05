/**
 * v0.6.2 — per-action-tab streamed-output buffer.
 *
 * Pins the four-property contract of the routed stream path:
 *   - stream_start { tabKey, groupName } seeds the buffer + auto-jumps
 *     slice.tab AND emits terminal_exit (so terminalMode doesn't leak
 *     across the jump).
 *   - viewer_append { tabKey, groupName } appends to the buffer
 *     unconditionally; mirrors to slice.lines only when the active tab
 *     in the current group is that action's tab.
 *   - tab_switch into an action tab restores slice.lines from the
 *     buffer (or "[press Enter to run]" placeholder) AND pins scroll
 *     to the bottom so the bottom-stick mirror keeps tracking new
 *     lines after restore.
 *   - tab_switch no longer emits kill_proc — the producer stays alive
 *     while the user is off-tab; switching back picks up live state.
 *
 * Run: node js/test/test-action-tab-buffer.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const viewer = require('../panel/viewer/viewer');
const pt = require('../leaves/pane-tabs');
const { setModel, getModel } = require('../app/runtime');

setModel({
  currentGroup: 'g',
  modes: {},
  config: {
    groups: {
      g: {
        label: 'G',
        actions: {
          'make-check':   { label: 'Test',  script: 'make check', tab: 'Test' },
          'other-action': { label: 'Other', script: 'echo other', tab: 'Other' },
          'no-tab':       { label: 'NoTab', script: 'echo notab' },
        },
      },
    },
  },
});

function applyUpdate(s, msg) {
  const r = viewer._update(msg, s);
  return Array.isArray(r) ? { next: r[0], cmds: r[1] || [] } : { next: r, cmds: [] };
}

describe('[stream_start] routed seeds buffer + auto-jumps + emits terminal_exit', () => {
  it('seeds buffer, jumps to action tab idx, emits terminal_exit', () => {
    const s0 = { ...viewer._init(), tab: 0 };
    const { next, cmds } = applyUpdate(s0, {
      type: 'stream_start',
      header: '[dim]$ make-check[/]',
      tabKey: 'make-check',
      groupName: 'g',
    });
    eq(next.tab, 2, 'auto-jump to make-check tab (idx 2 — first action tab; Info=0, Transcript=1)');
    eq(next.lines.length, 1, 'slice.lines is header only');
    eq(next.lines[0], '[dim]$ make-check[/]', 'header text');
    eq(next.scroll, 0, 'scroll reset');
    eq(next.actionTabBuffers.g['make-check'].lines.length, 1, 'buffer seeded');
    assert(cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted (so terminalMode doesn\'t leak across the auto-jump)');
  });

  it('unrouted stream_start seeds viewerStreamBuffer + auto-jumps to Transcript', () => {
    // v0.6.2 — unrouted stream output's display home is the
    // Transcript tab (was Info pre-refactor). stream_start auto-
    // jumps slice.tab to Transcript and emits terminal_exit so
    // terminalMode doesn't leak across the jump.
    const s0 = { ...viewer._init(), tab: 0 };
    const { next, cmds } = applyUpdate(s0, { type: 'stream_start', header: '[dim]$ raw[/]' });
    const info = pt.flatTabInfo(next, getModel(), 'g');
    const tIdx = pt.transcriptTabIdx(info);
    eq(next.tab, tIdx, `auto-jump to Transcript (idx ${tIdx})`);
    eq(next.lines.length, 1, 'mirror line set on Transcript');
    eq(next.viewerStreamBuffer.lines.length, 1, 'buffer seeded');
    eq(next.actionTabBuffers, s0.actionTabBuffers, 'routed buffer untouched');
    assert(cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted on jump');
  });

  it('cross-group stream_start writes buffer but skips jump', () => {
    const s0 = { ...viewer._init(), tab: 0 };
    const { next, cmds } = applyUpdate(s0, {
      type: 'stream_start',
      header: '[dim]$ x[/]',
      tabKey: 'make-check',
      groupName: 'other-group',
    });
    eq(next.tab, 0, 'no jump (cross-group)');
    eq(next.lines.length, 0, 'slice.lines untouched');
    eq(next.actionTabBuffers['other-group']['make-check'].lines.length, 1, 'buffer seeded for the other group');
    eq(cmds.length, 0, 'no Cmds');
  });
});

describe('[viewer_append] routed → buffer + mirror-on-active', () => {
  function seeded() {
    const s0 = { ...viewer._init(), tab: 0 };
    return applyUpdate(s0, {
      type: 'stream_start',
      header: '[dim]$ make-check[/]',
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
  }

  it('appends to buffer AND mirrors to slice.lines when on the action tab', () => {
    let s = seeded();  // slice.tab=2 (make-check; Info=0, Transcript=1, make-check=2)
    s = applyUpdate(s, { type: 'viewer_append', line: 'foo', tabKey: 'make-check', groupName: 'g' }).next;
    s = applyUpdate(s, { type: 'viewer_append', line: 'bar', tabKey: 'make-check', groupName: 'g' }).next;
    eq(s.actionTabBuffers.g['make-check'].lines.length, 3, 'buffer grew to 3');
    eq(s.lines.length, 3, 'slice.lines mirrored');
    eq(s.lines[2], 'bar', 'tail line in slice.lines');
  });

  it('appends to buffer but NOT slice.lines when user has switched off the action tab', () => {
    let s = seeded();
    s = { ...s, tab: 0, lines: [] };  // simulate user on Info tab
    s = applyUpdate(s, { type: 'viewer_append', line: 'bg', tabKey: 'make-check', groupName: 'g' }).next;
    eq(s.actionTabBuffers.g['make-check'].lines.length, 2, 'buffer grew');
    eq(s.lines.length, 0, 'slice.lines NOT mirrored (active tab is not make-check)');
  });

  it('bottom-stick on active mirror', () => {
    let s = seeded();
    s = { ...s, innerH: 3 };
    // Append enough to push past viewport so maxScroll > 0
    for (const line of ['a', 'b', 'c', 'd']) {
      s = applyUpdate(s, { type: 'viewer_append', line, tabKey: 'make-check', groupName: 'g' }).next;
    }
    eq(s.lines.length, 5, '5 lines (header + 4 appends)');
    eq(s.scroll, 2, 'scroll bottom-stuck (lines.length - innerH = 5 - 3 = 2)');
  });

  it('unrouted viewer_append: buffer always grows; slice.lines mirrors only on Transcript', () => {
    // v0.6.2 — unrouted accumulator lives on the Transcript tab.
    // On any other tab (Info, action, term, content), only the
    // viewerStreamBuffer grows; slice.lines is left alone.
    const s0 = { ...viewer._init(), tab: 0, lines: ['existing'], innerH: 4 };
    const r1 = applyUpdate(s0, { type: 'viewer_append', line: 'y' }).next;
    eq(r1.lines.length, 1, 'slice.lines NOT mirrored on Info');
    eq(r1.viewerStreamBuffer.lines.length, 1, 'buffer captured the line');
    eq(r1.actionTabBuffers, s0.actionTabBuffers, 'routed buffer untouched');
    // Now on Transcript — both grow.
    const info = pt.flatTabInfo(s0, getModel(), 'g');
    const tIdx = pt.transcriptTabIdx(info);
    const s1 = { ...viewer._init(), tab: tIdx, lines: ['x'], innerH: 4 };
    const r2 = applyUpdate(s1, { type: 'viewer_append', line: 'y' }).next;
    eq(r2.lines.length, 2, 'slice.lines mirrors when on Transcript');
    eq(r2.viewerStreamBuffer.lines.length, 1, 'buffer also grew');
  });
});

describe('[viewer_append_lines] bulk append — atomic reducer pass', () => {
  function seeded() {
    const s0 = { ...viewer._init(), tab: 0 };
    return applyUpdate(s0, {
      type: 'stream_start',
      header: '[dim]$ make-check[/]',
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
  }

  it('appends N lines in one pass; buffer grows by N; slice.lines mirrors when active', () => {
    let s = seeded();  // tab=2, lines=[header]
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['a', 'b', 'c'],
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
    eq(s.actionTabBuffers.g['make-check'].lines.length, 4, 'buffer = header + 3');
    eq(s.lines.length, 4, 'slice mirrored');
    eq(s.lines[3], 'c', 'tail of batch lands last');
  });

  it('off-tab → buffer grows, slice.lines untouched', () => {
    let s = seeded();
    s = { ...s, tab: 0, lines: [] };  // user on Info tab
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['bg-1', 'bg-2'],
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
    eq(s.actionTabBuffers.g['make-check'].lines.length, 3, 'buffer = header + 2');
    eq(s.lines.length, 0, 'slice untouched');
  });

  it('empty batch → no-op', () => {
    const s = seeded();
    const next = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: [],
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
    eq(next, s, 'same ref');
  });

  it('bottom-stick: was-at-bottom checked once for the whole batch', () => {
    let s = { ...seeded(), innerH: 3 };
    // pre-load to push past viewport
    s = applyUpdate(s, { type: 'viewer_append', line: 'x', tabKey: 'make-check', groupName: 'g' }).next;
    s = applyUpdate(s, { type: 'viewer_append', line: 'y', tabKey: 'make-check', groupName: 'g' }).next;
    s = applyUpdate(s, {
      type: 'viewer_append_lines',
      lines: ['p', 'q', 'r'],
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
    eq(s.lines.length, 6, '1 header + 2 + 3 = 6');
    eq(s.scroll, Math.max(0, 6 - 3), 'scroll bottom-stuck after batch');
  });

  it('unrouted bulk: buffer grows; slice.lines mirrors only on Transcript', () => {
    const s0 = { ...viewer._init(), tab: 0, lines: ['head'], innerH: 4 };
    const r1 = applyUpdate(s0, { type: 'viewer_append_lines', lines: ['a', 'b'] }).next;
    eq(r1.lines.length, 1, 'slice.lines NOT mirrored on Info');
    eq(r1.viewerStreamBuffer.lines.length, 2, 'buffer captured both lines');
    // On Transcript — both grow.
    const info = pt.flatTabInfo(s0, getModel(), 'g');
    const tIdx = pt.transcriptTabIdx(info);
    const s1 = { ...viewer._init(), tab: tIdx, lines: ['head'], innerH: 4 };
    const r2 = applyUpdate(s1, { type: 'viewer_append_lines', lines: ['a', 'b'] }).next;
    eq(r2.lines.length, 3, 'slice.lines mirrors on Transcript');
    eq(r2.viewerStreamBuffer.lines.length, 2, 'buffer grew too');
  });
});

describe('[tab_switch] action arm restores buffer + bottom-pin scroll', () => {
  function buildSliceWithBuffer(lines) {
    const s0 = { ...viewer._init(), tab: 0, innerH: 3 };
    return {
      ...s0,
      actionTabBuffers: { g: { 'make-check': { lines } } },
    };
  }

  it('restores from buffer when present, bottom-pin scroll', () => {
    // v0.6.2 — make-check at idx 2 (Info=0, Transcript=1, make-check=2).
    const s = buildSliceWithBuffer(['h', 'a', 'b', 'c', 'd']);
    const { next, cmds } = applyUpdate(s, { type: 'tab_switch', idx: 2 });
    eq(next.tab, 2, 'on make-check tab');
    eq(next.lines.length, 5, 'lines restored from buffer');
    eq(next.scroll, Math.max(0, 5 - 3), 'scroll pinned to bottom (lines.length - innerH)');
    assert(!cmds.some(c => c.type === 'kill_proc'),
      'Phase 3 — no kill_proc on tab_switch (producer keeps streaming)');
    assert(cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit still fires (chrome cleanup)');
  });

  it('paints "Press Enter to run" placeholder when no buffer yet', () => {
    const s0 = { ...viewer._init(), tab: 0 };
    const { next } = applyUpdate(s0, { type: 'tab_switch', idx: 2 });
    eq(next.tab, 2, 'on make-check tab');
    eq(next.lines.length, 1, 'one placeholder line');
    assert(next.lines[0].indexOf('Press Enter to run') >= 0, 'placeholder text');
  });

  it('post-restore appends continue bottom-sticking', () => {
    const s = buildSliceWithBuffer(['h', 'a', 'b', 'c', 'd']);
    let { next } = applyUpdate(s, { type: 'tab_switch', idx: 2 });
    next = applyUpdate(next, { type: 'viewer_append', line: 'e', tabKey: 'make-check', groupName: 'g' }).next;
    eq(next.lines.length, 6, '6 lines');
    eq(next.scroll, Math.max(0, 6 - 3), 'scroll advanced with new line');
  });
});

describe('[Phase 3 invariant] background streaming survives tab leave', () => {
  it('off-tab appends grow buffer but not slice.lines; switch-back restores live state', () => {
    const s0 = { ...viewer._init(), tab: 0, innerH: 3 };
    // Run make-check
    let s = applyUpdate(s0, {
      type: 'stream_start',
      header: '$ make-check',
      tabKey: 'make-check',
      groupName: 'g',
    }).next;
    eq(s.tab, 2, 'auto-jumped to make-check (idx 2)');
    s = applyUpdate(s, { type: 'viewer_append', line: 'live-1', tabKey: 'make-check', groupName: 'g' }).next;
    s = applyUpdate(s, { type: 'viewer_append', line: 'live-2', tabKey: 'make-check', groupName: 'g' }).next;
    // Switch to other-action (idx 3)
    s = applyUpdate(s, { type: 'tab_switch', idx: 3 }).next;
    eq(s.tab, 3);
    // Background appends to make-check (producer still alive in Phase 3)
    for (const line of ['bg-1', 'bg-2', 'bg-3']) {
      s = applyUpdate(s, { type: 'viewer_append', line, tabKey: 'make-check', groupName: 'g' }).next;
    }
    eq(s.actionTabBuffers.g['make-check'].lines.length, 6, 'background buffer grew to 6');
    // Switch back to make-check (idx 2)
    s = applyUpdate(s, { type: 'tab_switch', idx: 2 }).next;
    eq(s.lines.length, 6, 'slice.lines reflects live state');
    eq(s.lines[5], 'bg-3', 'latest background line at the tail');
    eq(s.scroll, Math.max(0, 6 - 3), 'scroll pinned to bottom on re-entry');
  });
});

report();
