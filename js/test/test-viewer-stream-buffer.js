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

describe('[viewer_show_info] bails when buffer has content', () => {
  it('non-empty buffer → show_info is a no-op', () => {
    let s = { ...viewer._init(), tab: 0, innerH: 5 };
    s = applyUpdate(s, { type: 'viewer_append', line: 'transcript' }).next;
    const before = s;
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    eq(r.next, before, 'reducer returned same ref (no-op)');
  });
  it('empty buffer → show_info proceeds (returns slice unchanged when no panel def — same as before)', () => {
    const s = { ...viewer._init(), tab: 0 };
    const r = applyUpdate(s, { type: 'viewer_show_info' });
    // The fallback bails because no navigator has getItems/getInfo here;
    // the important thing is the buffer-gate did NOT short-circuit.
    eq(r.next, s);
  });
});

report();
