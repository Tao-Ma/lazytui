/**
 * U2e P1b — the Transcript is now a first-class `text-view` INSTANCE
 * (hint:'transcript') of the content slot, NOT the viewer's flat-strip
 * `viewerStreamBuffer` accumulator behind a tab index.
 *
 *   - Unrouted stream output routes to the transcript instance via `tv_append`
 *     / `tv_append_lines` (the `tv_*` arms), resolved by
 *     `route.resolveTarget('viewer_transcript')`. The instance owns its own
 *     `slice.lines` + scroll (bottom-stick lives in its update), so there is no
 *     per-tab bundle, no mirror-only-when-on-tab, and no ring cap (the buffer is
 *     uncapped — action output is retained).
 *   - `tv_stream_start` reseeds the instance to the header + resets its view
 *     state (the per-instance analog of the old routed stream_start reset).
 *   - Per-instance scroll / search / select / cursor flow through the SHARED
 *     reducer `leaves/text/text-view-update` (tvu), same as the viewer. The
 *     instance persists, so there's no tab-switch round-trip to lose or restore
 *     state across.
 *
 * RETIRED with the flat strip (deleted, not migrated): the ring-buffer cap, the
 * `(no transcript yet)` placeholder, `viewer_show_info` guards (Info is a
 * dedicated `info` instance now, fed by `info_show_content`), `tab_switch`
 * Info/Transcript routing + per-tab `tabState` persistence, `viewer_set_tab`
 * inbound-restore, `viewer_set_content` / `viewerOverride`, and the
 * stream_start auto-jump (a dedicated instance never jumps). That machinery is
 * gone in P1b (excised through U2f).
 *
 * Two drive styles: direct `text-view.update` with a seeded `slice.innerH` for
 * deterministic scroll/interaction math (the old `viewer._update` pattern), and
 * a booted model (parse-shaped config → initState → per-pane mint) for the
 * resolution/routing pins.
 *
 * Run: node js/test/test-viewer-stream-buffer.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const tv = require('../panel/text-view/text-view');
const ms = require('../leaves/text/search');
const { getModel } = require('../app/runtime');
const route = require('../panel/route');
const api = require('../panel/api');

// --- Direct-drive the text-view Component (deterministic innerH) ---------
//
// The framework's augmentMsg stamps innerH from real pane geometry; calling
// update() directly lets a test seed innerH on the slice for exact scroll math
// (mirrors the retired file's `viewer._update` step()). tv_* + interaction Msgs
// return `nextSlice | [nextSlice, effects]`.
function step(slice, msg) {
  const r = tv.update(msg, slice);
  return Array.isArray(r) ? r[0] : r;
}
function transcriptSlice(innerH = 5, lines = []) {
  return { ...tv.init(), innerH, lines: lines.slice() };
}

// --- Boot a seeded content slot (resolution/routing pins) ----------------
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));
if (!api.getComponent('info'))      api.registerComponent(require('../panel/info/info'));
const { initState } = require('../app/state');
getModel().config = {
  theme: 'default',
  register: { cap: 10 },
  groups: { g: { label: 'G', actions: {}, items: [{ name: 'a' }] } },
  warnings: [],
};
initState();

describe('[tv_append unrouted] accumulates on the Transcript instance buffer', () => {
  it('single-line appends grow slice.lines + bottom-stick scroll', () => {
    let s = transcriptSlice(3);
    s = step(s, { type: 'tv_append', line: 'a' });
    s = step(s, { type: 'tv_append', line: 'b' });
    s = step(s, { type: 'tv_append', line: 'c' });
    s = step(s, { type: 'tv_append', line: 'd' });
    eq(s.lines, ['a', 'b', 'c', 'd'], 'buffer accumulates');
    eq(s.scroll, Math.max(0, 4 - 3), 'bottom-stick (4 lines, innerH 3)');
  });
  it('a scrolled-up reader is NOT yanked to the tail on append', () => {
    let s = transcriptSlice(3, ['a', 'b', 'c', 'd', 'e', 'f']);
    s = step(s, { type: 'viewer_scroll', to: 'top' });
    eq(s.scroll, 0, 'reader scrolled to top');
    s = step(s, { type: 'tv_append', line: 'g' });
    eq(s.scroll, 0, 'append while scrolled-up does not follow the tail');
    eq(s.lines.length, 7, 'but the buffer still grew');
  });
  it('uncapped — the buffer retains history (no ring drop)', () => {
    let s = transcriptSlice(5);
    for (let i = 0; i < 1500; i++) s = step(s, { type: 'tv_append', line: `line-${i}` });
    eq(s.lines.length, 1500, 'all 1500 lines retained (no cap)');
    eq(s.lines[0], 'line-0', 'oldest preserved');
    eq(s.lines[1499], 'line-1499', 'newest preserved');
  });
});

describe('[tv_append_lines unrouted] bulk accumulator (spawn/background status)', () => {
  // Spawn / background launch + cmdline-verb outcomes append as ONE atomic Msg.
  // Multi-spawn doesn't lose history (uncapped, accumulate not replace).
  it('two consecutive spawn-status bulk appends accumulate', () => {
    let s = transcriptSlice(5);
    s = step(s, {
      type: 'tv_append_lines',
      lines: ['[dim]$ logs[/]', '[yellow]Spawned in new tmux window.[/]'],
    });
    s = step(s, {
      type: 'tv_append_lines',
      lines: ['[dim]$ psql[/]', '[yellow]Spawned in new tmux window.[/]'],
    });
    eq(s.lines.length, 4, 'both spawn messages retained');
    eq(s.lines[0], '[dim]$ logs[/]', 'first spawn preserved');
    eq(s.lines[2], '[dim]$ psql[/]', 'second spawn after the first');
  });
  it('an empty bulk append is a no-op (ref-preserved)', () => {
    const s0 = transcriptSlice(5, ['x']);
    const s1 = step(s0, { type: 'tv_append_lines', lines: [] });
    eq(s1, s0, 'empty append returns the input slice');
  });
});

describe('[tv_stream_start] re-run reseed clears to the header + resets view state', () => {
  it('replaces the buffer with just the header and resets scroll/search/select', () => {
    let s = transcriptSlice(3, ['old-1', 'old-2', 'old-3', 'old-4']);
    // Prime some view state that the reseed must clear.
    s = step(s, { type: 'viewer_search_enter' });
    for (const c of 'old') s = step(s, { type: 'viewer_search_key', seq: c });
    s = step(s, { type: 'viewer_search_commit' });
    s = step(s, { type: 'select_begin', line: 1, col: 0, kind: 'char' });
    assert(s.search.active || s.select.active, 'view state primed');
    const r = step(s, { type: 'tv_stream_start', header: '$ new-cmd' });
    eq(r.lines, ['$ new-cmd'], 'buffer cleared to the header (does NOT preserve prior)');
    eq(r.scroll, 0, 'scroll reset to top');
    eq(r.search.active, false, 'search reset');
    eq(r.select.active, false, 'select reset');
    eq(r.cursor, { line: 0, col: 0 }, 'cursor reset');
  });
});

describe('[unrouted routing] resolveTarget(viewer_transcript) lands on the transcript instance', () => {
  // The stream helpers (dispatch/runtime/stream.js appendDetailLine /
  // appendDetailLines with no tabInstId) dispatch tv_append(_lines) to
  // resolveTarget('viewer_transcript'). This pins that the intent resolves to a
  // `text-view` instance whose pool entry is hint:'transcript'.
  it('the intent resolves to a text-view instance distinct from Info', () => {
    const tid = route.resolveTarget('viewer_transcript');
    const iid = route.resolveTarget('viewer_info');
    assert(tid, 'transcript instance resolved');
    eq(route.instanceKind(tid), 'text-view', 'transcript is a text-view instance');
    eq(route.instanceKind(iid), 'info', 'info is an info instance');
    assert(tid !== iid, 'transcript and info are distinct instances');
  });
  it('a wrapped tv_append lands on that instance\'s slice.lines', () => {
    const tid = route.resolveTarget('viewer_transcript');
    api.dispatchMsg(api.wrap(tid, { type: 'tv_set_lines', lines: [] }));
    api.dispatchMsg(api.wrap(tid, { type: 'tv_append', line: 'routed-line' }));
    const s = api.getInstanceSlice(tid);
    eq(s.lines[s.lines.length - 1], 'routed-line', 'append reached the transcript buffer');
  });
});

describe('[per-instance scroll] the transcript instance owns its own scroll', () => {
  // Pre-P1b this was a per-TAB tabState round-trip (scroll shared across tabs,
  // captured/restored on tab_switch). Now each instance permanently owns its
  // scroll on its own slice — no round-trip, no capture.
  it('viewer_scroll clamps to the buffer + honors to:top / to:bottom', () => {
    let s = transcriptSlice(3, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);  // maxScroll = 4
    s = step(s, { type: 'viewer_scroll', to: 'bottom' });
    eq(s.scroll, 4, 'bottom = maxScroll');
    s = step(s, { type: 'viewer_scroll', to: 'top' });
    eq(s.scroll, 0, 'top');
    s = step(s, { type: 'viewer_scroll', delta: 2 });
    eq(s.scroll, 2, 'relative delta');
    s = step(s, { type: 'viewer_scroll', delta: 999 });
    eq(s.scroll, 4, 'clamped to maxScroll');
  });
});

describe('[per-instance search] the transcript instance owns its own search', () => {
  // The instance's content IS its own line buffer; matches DERIVE from
  // (lines, term) via ms.matchesFor (P1 selector). No per-tab persistence.
  it('enter → type → commit sets an active term; matches derive from the buffer', () => {
    let s = transcriptSlice(5, ['foo', 'BAR', 'baz', 'BAR again', 'qux']);
    s = step(s, { type: 'viewer_search_enter' });
    for (const c of 'BAR') s = step(s, { type: 'viewer_search_key', seq: c });
    s = step(s, { type: 'viewer_search_commit' });
    eq(s.search.active, true, 'search committed');
    eq(s.search.term, 'BAR', 'term set');
    eq(ms.matchesFor(s.lines, s.search.term).length, 2, 'two matches derive');
  });
  it('committed search survives an append — matches re-derive against new lines', () => {
    let s = transcriptSlice(5, ['BAR one']);
    s = step(s, { type: 'viewer_search_enter' });
    for (const c of 'BAR') s = step(s, { type: 'viewer_search_key', seq: c });
    s = step(s, { type: 'viewer_search_commit' });
    eq(ms.matchesFor(s.lines, s.search.term).length, 1, 'one match before append');
    s = step(s, { type: 'tv_append', line: 'BAR two' });
    eq(ms.matchesFor(s.lines, s.search.term).length, 2, 'match count follows the buffer');
  });
});

describe('[per-instance select] the transcript instance owns its own selection', () => {
  it('select_begin + select_extend track anchor/cursor on this instance', () => {
    let s = transcriptSlice(5, ['a', 'b', 'c', 'd', 'e']);
    s = step(s, { type: 'select_begin', line: 1, col: 0, kind: 'char' });
    s = step(s, { type: 'select_extend', line: 3, col: 0 });
    eq(s.select.active, true, 'select active');
    eq(s.select.anchor.line, 1, 'anchor at line 1');
    eq(s.select.cursor.line, 3, 'cursor at line 3');
  });
});

describe('[per-instance cursor] the transcript instance owns its own cursor', () => {
  it('select_begin moves the cursor as a side effect', () => {
    let s = transcriptSlice(5, ['line0', 'line1', 'line2', 'line3', 'line4']);
    s = step(s, { type: 'select_begin', line: 2, col: 3, kind: 'char' });
    eq(s.cursor.line, 2, 'cursor at line 2');
    eq(s.cursor.col, 3, 'cursor at col 3');
  });
});

describe('[viewer_reset_chrome] the per-instance half of the group-change reset', () => {
  // U2e P1b — viewer_reset_chrome is handled by the shared tvu reducer: it
  // clears the visual selection + parks the cursor so a stale highlight doesn't
  // survive a group switch. (The retired tab/override resets + the [≡] menu-close
  // hoisted to the dispatch funnel — see app/state.js#resetGroupContext.)
  it('clears the active selection and resets the cursor', () => {
    let s = transcriptSlice(5, ['a', 'b', 'c', 'd', 'e', 'f']);
    s = step(s, { type: 'select_begin', line: 1, col: 0, kind: 'char' });
    s = step(s, { type: 'select_extend', line: 3, col: 0 });
    assert(s.select.active, 'selection primed');
    s = step(s, { type: 'viewer_reset_chrome' });
    eq(s.select.active, false, 'selection cleared');
    eq(s.cursor, { line: 0, col: 0 }, 'cursor parked at origin');
  });
  it('no-op (no selection, cursor already at origin) preserves the slice ref', () => {
    const s0 = transcriptSlice(5, ['a', 'b']);
    const s1 = step(s0, { type: 'viewer_reset_chrome' });
    eq(s1, s0, 'ref-preserved on no-op');
  });
});

describe('[group-switch cascade] viewer_reset_chrome ordering (B5)', () => {
  // Round 2 adversarial finding: the finalizer's FROM-tab key resolution reads
  // getModel().currentGroup. If set_current_group runs first, currentGroup is
  // the NEW group by finalizer-time — so the reset lands under the WRONG group's
  // key. Fix: emit viewer_reset_chrome FIRST so currentGroup still holds the OLD
  // value at finalizer-time. This is the groups Component's cascade, unrelated to
  // the retired flat strip, so it carries over verbatim.
  it('B5: group-switch cascade emits viewer_reset_chrome BEFORE set_current_group', () => {
    const groups = require('../panel/navigator/groups');
    const { setModel } = require('../app/runtime');
    setModel({
      currentGroup: 'g1',
      modes: {},
      config: { groups: {
        g1: { label: 'G1', actions: {}, items: [{ name: 'a' }, { name: 'b' }] },
        g2: { label: 'G2', actions: {}, items: [{ name: 'c' }] },
      } },
    });
    const initialSlice = groups.init();
    // #D10: the cascade's viewer destination rides on ctx.viewerTarget (the
    // impure-shell dispatcher resolves it via route.resolveTarget('viewer')); a
    // truthy target is the precondition for the viewer_reset_chrome Cmd.
    const grpCtx = { ...groups.groupsBundle(getModel()), tabListMode: false, viewerTarget: 'detail' };
    const rec = groups._update({ type: 'groups_recompute', ctx: grpCtx }, initialSlice);
    const slice = Array.isArray(rec) ? rec[0] : rec;
    const res = groups._update({ type: 'groups_selected', index: 1, ctx: grpCtx }, slice);
    const cmds = Array.isArray(res) ? res[1] : [];
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
});

report();
