/**
 * v0.5 TEA spike — the root-model reducer/dispatch seam (js/runtime.js).
 * Phase 1b moved viewMode out of the root reducer into the layout
 * Component's slice; the view_* tests below live in test-component
 * and exercise layout.update directly.
 *
 * Run: node js/test/test-runtime.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
// Phase 4a — nav chrome (cursor/scroll/multiSel) lives on each Navigator
// Component's slice. The tests below dispatch through wrapped Msgs and
// read via state helpers, so the Components must be registered first.
// test-runner already registered layout/detail/groups.
const _api = require('../panel/api');
_api.registerComponent(require('../panel/navigator/docker'));
_api.registerComponent(require('../panel/navigator/actions'));

describe('[0] init — builds the root model', () => {
  it('returns a fresh model (viewMode moved to layout Component)', () => {
    const m = runtime.init();
    assert(!('viewMode' in m),
       'viewMode no longer on the root model (lives on layout slice)');
  });
});

describe('[3] update — (model, msg) → [model, cmds], pure + Cmd descriptors', () => {
  it('focus_set stores focus and always emits show_selected_info', () => {
    const m = runtime.init();
    // Phase 1c: focus_set moved to layout.update — test the Component
    // update directly with an isolated slice.
    const layout = require('../panel/layout');
    const slice = layout.init();
    slice.focus = 'groups';
    const [s1, c1] = layout.update({ type: 'focus_set', focus: 'actions' }, slice);
    eq(s1.focus, 'actions');
    eq(c1.length, 1);
    eq(c1[0].type, 'show_selected_info');
    // null focus leaves it put but still refreshes the body
    const [s2, c2] = layout.update({ type: 'focus_set', focus: null }, s1);
    eq(s2.focus, 'actions', 'null focus is a no-op on the value');
    eq(c2[0].type, 'show_selected_info');
  });
  it('returns the SAME model object (hybrid: mutate-and-return)', () => {
    const m = runtime.init();
    const [m1] = runtime.update(m, { type: 'focus_set', focus: 'groups' });
    assert(m1 === m, 'update returns the threaded model, not a clone (Phase-0 contract)');
  });
  it('viewer_scroll: delta pages clamped, to:top/bottom jumps, no effects', () => {
    // Phase B: viewer_scroll moved to detail.update — test the Component
    // update directly with an isolated slice.
    const detail = require('../panel/viewer/viewer');
    // A1/B1 fix: viewport lives on detail's own slice (innerH), written
    // by render() via viewer_set_viewport. Tests seed it directly.
    // Phase 3 — _update returns the new slice; step() threads it through.
    const step = (sl, msg) => {
      const out = detail._update(msg, sl);
      return Array.isArray(out) ? out[0] : out;
    };
    let slice = detail._init();
    slice = { ...slice, lines: new Array(100).fill('x'), innerH: 20 };  // maxScroll 80
    slice = step(slice, { type: 'viewer_scroll', delta: 30 });
    eq(slice.scroll, 30);
    slice = step(slice, { type: 'viewer_scroll', delta: 999 });
    eq(slice.scroll, 80, 'clamped to maxScroll');
    slice = step(slice, { type: 'viewer_scroll', delta: -999 });
    eq(slice.scroll, 0, 'clamped to 0');
    slice = step(slice, { type: 'viewer_scroll', to: 'bottom' });
    eq(slice.scroll, 80);
    const r = detail._update({ type: 'viewer_scroll', to: 'top' }, slice);
    // Bare slice return = no effects array.
    assert(!Array.isArray(r), 'scroll returns bare slice (no effects)');
    eq(r.scroll, 0);
  });
  it('navSelect: writes the cursor via the owning Component + show_selected_info; groups also cascades', () => {
    // Phase 4b — the uniform `nav_select` Msg retired; `dispatch.navSelect`
    // routes a wrapped `set_cursor` Msg to the owning Component, fires
    // show_selected_info, and (for groups) emits the groups_selected
    // cascade. Drive it through the real dispatch so the wrapped Msgs
    // land in each Component's slice.
    const state = require('../app/state');
    state.setSel('actions', 0);
    state.setSel('groups',  0);
    require('../dispatch/dispatch').navSelect('actions', 3);
    eq(state.getSel('actions'), 3, 'actions cursor advanced');
    require('../dispatch/dispatch').navSelect('groups', 1);
    eq(state.getSel('groups'), 1, 'groups cursor advanced');
  });

  it('navSelect: yanks viewer back to Info when focus has getInfo and on a non-Info tab', () => {
    // v0.6.2 T1 — viewer_show_info reducer folds the yank: focus on
    // a list panel with getInfo → yank to Info + populate. focus on
    // detail / no-getInfo panels (stats) → bail. The
    // addContentTab → focus_set(detail) cascade is safe by the bail.
    const route = require('../leaves/route');
    const dispatch = require('../dispatch/dispatch');
    // Seed a group + action so actions panel has items to feed getInfo.
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    // Park the viewer on Transcript (idx 1).
    const sliceBefore = { ...route.getInstanceSlice('detail'), tab: 1 };
    route.setInstanceSlice('detail', sliceBefore);
    eq(route.getInstanceSlice('detail').tab, 1, 'precondition: on Transcript');
    // Move cursor in actions — focus is on actions, actions has
    // getInfo, items[0] exists → reducer yanks to Info.
    dispatch.navSelect('actions', 0);
    eq(route.getInstanceSlice('detail').tab, 0, 'yanked back to Info');
  });

  it('navSelect: yanks from any non-Info tab (action tab idx 3, not just Transcript)', () => {
    // Pin that yank fires from ANY non-Info tab. The reducer doesn't
    // special-case Transcript — the precondition is "focus has
    // getInfo," and the consequence is "tab=0 + populate."
    const route = require('../leaves/route');
    const dispatch = require('../dispatch/dispatch');
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    const sliceBefore = { ...route.getInstanceSlice('detail'), tab: 3 };
    route.setInstanceSlice('detail', sliceBefore);
    eq(route.getInstanceSlice('detail').tab, 3, 'precondition: on tab 3');
    dispatch.navSelect('actions', 0);
    eq(route.getInstanceSlice('detail').tab, 0, 'yanked back to Info from tab 3');
  });

  it('viewer_show_info bails when focus is on detail (no getInfo) — preserves addContentTab flow', () => {
    // T1 contract: detail / no-getInfo focus → no yank. Critical for
    // the addContentTab → focus_set(detail) cascade: a freshly-opened
    // content tab must STAY on the content tab even though
    // show_selected_info fires from the cascade.
    const route = require('../leaves/route');
    const detail = require('../panel/viewer/viewer');
    const layout = route.getInstanceSlice('layout');
    layout.focus = 'detail';
    const slice = { ...route.getInstanceSlice('detail'), tab: 3, lines: ['content'] };
    const r = detail._update({ type: 'viewer_show_info' }, slice);
    // Unwrap [slice, effects] or bare slice.
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 3, 'tab unchanged — yank skipped (detail focus has no getInfo)');
    eq(next.lines[0], 'content', 'lines unchanged');
  });
  it('R3: viewer_show_info from off-Info restores tabState[info]', () => {
    // Pre-R3 the reducer wrote { tab: 0, scroll: 0 } unconditionally.
    // navSelect from an action tab dropped Info's saved scroll.
    // Post-R3: when transitioning to Info from another tab, restore
    // tabState['info'].{scroll, search, select, cursor}.
    const route = require('../leaves/route');
    const detail = require('../panel/viewer/viewer');
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    // Land on action tab 3 with Info's tabState entry pre-seeded.
    const slice = {
      ...route.getInstanceSlice('detail'),
      tab: 3,
      scroll: 0,
      tabState: { info: { scroll: 47, cursor: { line: 47, col: 0 } } },
    };
    const r = detail._update({ type: 'viewer_show_info' }, slice);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 0, 'transitioned to Info');
    eq(next.scroll, 47, 'restored Info scroll from tabState');
    eq(next.cursor.line, 47, 'restored Info cursor from tabState');
  });
  it('A4: viewer_show_info on Info drops stale search.matches but keeps term', () => {
    // Round 2 finding: with active committed search on Info, j/k in a
    // Navigator re-fires viewer_show_info → previous matches reference
    // the OLD item's text → highlights paint on wrong content.
    // Fix: clear matches/idx on within-Info nav; keep term so the
    // user can `/[Up]`-recall.
    const route = require('../leaves/route');
    const detail = require('../panel/viewer/viewer');
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    const slice = {
      ...route.getInstanceSlice('detail'),
      tab: 0,
      search: {
        active: true,
        term: 'foo',
        matches: [{ line: 7, col: 0, len: 3 }, { line: 12, col: 4, len: 3 }],
        idx: 0,
        typing: '',
      },
    };
    const r = detail._update({ type: 'viewer_show_info' }, slice);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 0, 'stayed on Info');
    eq(next.search.matches.length, 0, 'stale matches dropped');
    eq(next.search.idx, 0, 'idx reset');
    eq(next.search.term, 'foo', 'term preserved for /[Up] recall');
    eq(next.search.active, true, 'active flag preserved');
  });
  it('R3: viewer_show_info while already on Info resets scroll to 0 (new item)', () => {
    // Within-Info case (j/k navigates to a new item, same tab): scroll
    // resets to 0 so the new item's getInfo displays from line 0.
    // tabState[info] is NOT consulted — the restore is only for
    // off-Info transitions; within-Info, content changes per item and
    // scroll: 0 is the natural fresh-content default.
    const route = require('../leaves/route');
    const detail = require('../panel/viewer/viewer');
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    const slice = {
      ...route.getInstanceSlice('detail'),
      tab: 0,
      scroll: 50,
      tabState: { info: { scroll: 100 } },
    };
    const r = detail._update({ type: 'viewer_show_info' }, slice);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.tab, 0, 'stayed on Info');
    eq(next.scroll, 0, 'within-Info navSelect resets scroll to 0');
  });
  it('escape / list_select: emit wrapped multisel_clear into the focused Component', () => {
    // Phase 4a — escape/list_select route multiSel clears through the
    // focused Navigator's update (single-writer per slice). Read via the
    // state helper to assert the post-effect outcome.
    const api = require('../panel/api');
    const state = require('../app/state');
    const m = runtime.getModel();
    api.getInstanceSlice('layout').focus = 'containers';
    // Seed: arm select mode + put two ids in the multiSel set.
    // Phase 4 — runtime.update is pure; applyMsg threads the new model
    // through setModel(), so subsequent reads must go through getModel().
    const dispatch = require('../dispatch/dispatch');
    dispatch.applyMsg({ type: 'list_select', mode: 'toggle' });
    eq(runtime.getModel().modes.listSelectMode, true, 'toggle on');
    state.toggleMultiSel('containers', 'a');
    state.toggleMultiSel('containers', 'b');
    eq(state.multiSelCount('containers'), 2, 'two items selected');
    dispatch.applyMsg({ type: 'escape' });
    eq(runtime.getModel().modes.listSelectMode, false, 'escape exits select mode');
    eq(state.multiSelCount('containers'), 0, 'escape clears the selection');
    // escape again with a lingering selection but not in select mode
    state.toggleMultiSel('containers', 'x');
    dispatch.applyMsg({ type: 'escape' });
    eq(state.multiSelCount('containers'), 0, 'escape clears lingering selection');
    // list_select on (the * path) forces it true
    dispatch.applyMsg({ type: 'list_select', mode: 'on' });
    eq(runtime.getModel().modes.listSelectMode, true, 'mode:on forces select mode');
  });
  it('toggle_groups_tab + toggle_group are handled by the groups Component (Phase C)', () => {
    // Phase C: these Msgs moved out of runtime.update into groups.update.
    // Test the Component update directly with an isolated slice.
    const groups = require('../panel/navigator/groups');
    const m = runtime.getModel();  // the leaves read getModel().config
    m.config = { groups: {
      g1: { name: 'g1', quick: true, children: ['g1.a'], parent: null },
      'g1.a': { name: 'g1.a', children: [], parent: 'g1' },
    } };
    m.currentGroup = '';

    // Phase 3 — update() returns either a new slice or [newSlice, Cmds];
    // unwrap both shapes and thread through.
    // v0.6.3 Phase D1 — thread groups ctx so the reducer arm stays pure.
    const ctx = { ...groups.groupsBundle(m), tabListMode: false };
    const step = (sl, msg) => {
      const out = groups._update({ ...msg, ctx }, sl);
      return Array.isArray(out) ? out[0] : out;
    };
    let slice = groups._init();
    eq(slice.tab, 'all');
    // toggle_groups_tab
    slice = step(slice, { type: 'toggle_groups_tab' });
    eq(slice.tab, 'quick', 'all → quick');
    slice = step(slice, { type: 'toggle_groups_tab' });
    eq(slice.tab, 'all', 'quick → all');
    // toggle_group
    slice = step(slice, { type: 'toggle_group', name: 'g1' });
    eq(slice.expanded.has('g1'), true, 'expanded after first toggle');
    slice = step(slice, { type: 'toggle_group', name: 'g1' });
    eq(slice.expanded.has('g1'), false, 'collapsed after second toggle');
  });
  it('freeConfig: forwards a wrapped free_config_enter Msg (v0.6 — free-config is always available)', () => {
    // v0.5 gated this on layout.slice.freeConfig.enabled (the --design CLI
    // flag); v0.6 removed the gate — free-config mode is reachable from
    // the cmdline / menu / keybinding regardless of how the TUI was
    // booted. R4.2 collapsed the start_free_config Cmd into a direct
    // dispatch_msg wrap (was: runtime → Cmd → effects → dispatch.helper
    // → dispatchMsg; now: runtime → Cmd → dispatchMsg).
    const m = runtime.init();
    const [, cmds] = runtime.update(m, { type: 'free_config' });
    eq(cmds.length, 1);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.kind, 'layout');
    eq(cmds[0].msg.msg.type, 'free_config_enter');
  });
  it('Cmd-only verbs route Msg → Cmd without touching the model', () => {
    const m = runtime.init();
    const snap = JSON.stringify(m.focus);
    // show_help / quit no longer go through the reducer (R4.8) —
    // actions.js calls overlay/help.showHelp() / cleanup() + process.exit
    // directly. next_tab / prev_tab keep their Cmd path — v0.6.3
    // Phase 3f retired the intermediate `tab_cycle` Msg; _cycleViewerTab
    // now emits `tab_switch` directly (with precomputed idx + targetKey)
    // so the pane-tabs leaf no longer needs ctx.getModel.
    const cmdsNext = runtime.update(m, { type: 'next_tab' })[1];
    const cmdsPrev = runtime.update(m, { type: 'prev_tab' })[1];
    eq(cmdsNext[0].msg.msg.type, 'tab_switch');
    eq(cmdsPrev[0].msg.msg.type, 'tab_switch');
    // total=2 (Info + Transcript) with currentGroup=''; from tab=0,
    // dir +1 → idx 1; dir -1 → idx 1 (wrap).
    eq(cmdsNext[0].msg.msg.idx, 1);
    eq(cmdsPrev[0].msg.msg.idx, 1);
    eq(JSON.stringify(m.focus), snap, 'model unchanged by Cmd-only verbs');
  });
  it('unknown msg: model untouched, no cmds', () => {
    const m = runtime.init();
    const before = m.focus;
    const [m1, cmds] = runtime.update(m, { type: 'no_such_msg' });
    eq(m1.focus, before);
    eq(cmds.length, 0);
  });
});

describe('[11] terminal mode + multi-select writes (folded off the input path)', () => {
  it('terminal_enter sets the flag; no Cmds', () => {
    // Phase 4 — capture the new model from the return tuple.
    const m = runtime.init();
    const [m2, cmds] = runtime.update(m, { type: 'terminal_enter' });
    eq(m2.modes.terminalMode, true);
    eq(cmds.length, 0);
  });
  it('terminal_exit clears the flag and emits cross-layer dispatch_msg wrapped to layout', () => {
    // Phase 1b: viewMode lives on layout's slice; terminal_exit emits a
    // dispatch_msg → view_drop_full_to_normal. Phase 2a — the inner Msg is
    // wrapped { kind: 'layout', msg: {...} } so the handler routes
    // straight to layout's update.
    const m = runtime.init();
    const armed = { ...m, modes: { ...m.modes, terminalMode: true } };
    const [m2, cmds] = runtime.update(armed, { type: 'terminal_exit' });
    eq(m2.modes.terminalMode, false);
    eq(cmds.length, 1);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.kind, 'layout');
    eq(cmds[0].msg.msg.type, 'view_drop_full_to_normal');
  });
  it('multisel toggle/clear lands on the Component slice (wrapped Msg path)', () => {
    // Phase 4b — call sites wrap directly to the owning Component now;
    // exercise the state helpers (which do that wrap) and read back via
    // the same helpers.
    const state = require('../app/state');
    state.clearMultiSel('containers');
    state.toggleMultiSel('containers', 'c1');
    assert(state.isMultiSel('containers', 'c1'), 'added');
    state.toggleMultiSel('containers', 'c1');
    eq(state.multiSelCount('containers'), 0, 'count drops to 0 when the set empties');
  });
  it('multisel_select_all adds every id (idempotent)', () => {
    const api = require('../panel/api');
    const state = require('../app/state');
    state.clearMultiSel('containers');
    state.toggleMultiSel('containers', 'c1');
    api.dispatchMsg(api.wrap('docker', { type: 'multisel_select_all', panel: 'containers', ids: ['c1', 'c2', 'c3'] }));
    eq(state.multiSelCount('containers'), 3, 'c1 not double-added');
  });
});

describe('[10] streamed output — stream_start / viewer_append (effect source)', () => {
  // Phase B: stream_start + viewer_append moved into detail.update — tested
  // here against the Component update with an isolated slice.
  const detail = require('../panel/viewer/viewer');
  // Phase 3 — _update returns the new slice; capture it instead of reading
  // the input after the call.
  it('stream_start replaces detail with the header + auto-jumps to Transcript', () => {
    // v0.6.2 — unrouted stream_start auto-jumps to the Transcript tab
    // (last in the strip; idx 1 with no per-group tabs). Returns
    // [slice, cmds] when slice.tab !== transcriptIdx — the cmds carry
    // a terminal_exit so terminalMode doesn't leak across the jump.
    const m = runtime.init();
    const init = detail._init();
    const slice = { ...init, lines: ['old', 'stuff'], scroll: 5, tab: 0 };
    const r = detail._update({ type: 'stream_start', header: '$ run' }, slice);
    assert(Array.isArray(r), 'jump path returns [slice, cmds]');
    const [next, cmds] = r;
    eq(next.lines.length, 1);
    eq(next.lines[0], '$ run');
    eq(next.scroll, 0);
    eq(next.tab, 1, 'auto-jumped to Transcript');
    assert(cmds.some(c => c.type === 'msg' && c.msg && c.msg.type === 'terminal_exit'),
      'terminal_exit Cmd emitted');
  });
  it('viewer_append pins to bottom when already at bottom', () => {
    // v0.6.2 T2d — slice.lines derives from viewerStreamBuffer on
    // Transcript. Seed buffer state directly.
    const init = detail._init();
    const slice = {
      ...init,
      scroll: 0,
      innerH: 3,
      tab: 1,
      viewerStreamBuffer: { lines: ['a', 'b', 'c'], cap: 1000 },
    };
    const r = detail._update({ type: 'viewer_append', line: 'd' }, slice);
    eq(r.lines.length, 4);
    eq(r.scroll, 1, 'followed to the new bottom');
  });
  it('viewer_append leaves scroll alone when the user scrolled up', () => {
    const init = detail._init();
    const slice = {
      ...init,
      scroll: 0,
      innerH: 3,
      tab: 1,
      viewerStreamBuffer: { lines: ['a', 'b', 'c', 'd', 'e'], cap: 1000 },
    };  // maxScroll = 2, user at top
    const r = detail._update({ type: 'viewer_append', line: 'f' }, slice);
    eq(r.lines.length, 6);
    eq(r.scroll, 0, 'not yanked down — user was reading');
  });
});

report();
