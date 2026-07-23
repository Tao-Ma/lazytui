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
const { displayedLines } = require('./_helpers/viewer-lines');
// Phase 4a — nav chrome (cursor/scroll/multiSel) lives on each Navigator
// Component's slice. The tests below dispatch through wrapped Msgs and
// read via state helpers, so the Components must be registered first.
// U2f — test-runner already registered layout/groups + the content-slot tabs
// (info/text-view); the detail viewer Component is gone.
const _api = require('../panel/api');
_api.registerComponent(require('../panel/navigator/docker'));
_api.registerComponent(require('../panel/navigator/actions'));
// U2e P1b — the content slot dissolves the single `detail` viewer into sibling
// position-tab instances (info / transcript). Register those Components + boot a
// SEEDED content slot (parser + initState) so route.resolveTarget('viewer_info'
// / 'viewer_transcript') resolve to real instances and the showSelectedInfo yank
// (a `set_active_tab` on the slot) has a slot to act on.
_api.registerComponent(require('../panel/info/info'));
_api.registerComponent(require('../panel/text-view/text-view'));

// Boot a seeded model with a placed content slot. Idempotent: safe to call once
// per test that needs the slot. Uses the repo's test.yml (a `detail` pane →
// role:'content' → seeded Info+Transcript tabs).
function seedContentSlot() {
  const { parse } = require('../parser/index');
  const { initState } = require('../app/state');
  const m = runtime.getModel();
  m.config = parse(require('path').resolve(__dirname, '../../test/test.yml'));
  m.projectDir = '.';
  initState();
}

describe('[0] init — builds the root model', () => {
  it('returns a fresh model (viewMode moved to layout Component)', () => {
    const m = runtime.init();
    assert(!('viewMode' in m),
       'viewMode no longer on the root model (lives on layout slice)');
  });
});

describe('[3] update — (model, msg) → [model, cmds], pure + Cmd descriptors', () => {
  it('focus_set stores focus + show_selected_info; a real change also pushes nav-history', () => {
    const m = runtime.init();
    // Phase 1c: focus_set moved to layout.update — test the Component
    // update directly with an isolated slice.
    const layout = require('../panel/layout');
    const slice = layout.init();
    slice.focus = 'groups';
    const [s1, c1] = layout.update({ type: 'focus_set', focus: 'actions' }, slice);
    eq(s1.focus, 'actions');
    // v0.6.7 — a real focus change refreshes the body AND emits nav_capture.
    eq(c1.map(c => c.type), ['show_selected_info', 'nav_capture']);
    // null focus leaves it put — no change → no nav_capture, still refreshes body
    const [s2, c2] = layout.update({ type: 'focus_set', focus: null }, s1);
    eq(s2.focus, 'actions', 'null focus is a no-op on the value');
    eq(c2.map(c => c.type), ['show_selected_info'], 'a no-op focus does not push nav-history');
  });
  it('returns the SAME model object (hybrid: mutate-and-return)', () => {
    const m = runtime.init();
    const [m1] = runtime.update(m, { type: 'focus_set', focus: 'groups' });
    assert(m1 === m, 'update returns the threaded model, not a clone (Phase-0 contract)');
  });
  it('viewer_scroll: delta pages clamped, to:top/bottom jumps, no effects', () => {
    // U2f — viewer_scroll's home is the content instance's update (info /
    // text-view), both delegating to the shared tvu clamp; the `detail` viewer
    // Component is gone. Drive the `info` Component with an isolated slice; the
    // buffer lives on `slice.lines` (was `infoLines`) and innerH is seeded
    // directly (production stamps it via augmentMsg).
    const info = require('../panel/info/info');
    const step = (sl, msg) => {
      const out = info.update(msg, sl);
      return Array.isArray(out) ? out[0] : out;
    };
    let slice = info.init('pane-x');
    slice = { ...slice, lines: new Array(100).fill('x'), innerH: 20 };  // maxScroll 80
    slice = step(slice, { type: 'viewer_scroll', delta: 30 });
    eq(slice.scroll, 30);
    slice = step(slice, { type: 'viewer_scroll', delta: 999 });
    eq(slice.scroll, 80, 'clamped to maxScroll');
    slice = step(slice, { type: 'viewer_scroll', delta: -999 });
    eq(slice.scroll, 0, 'clamped to 0');
    slice = step(slice, { type: 'viewer_scroll', to: 'bottom' });
    eq(slice.scroll, 80);
    const r = info.update({ type: 'viewer_scroll', to: 'top' }, slice);
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
    require('../dispatch/control/dispatch').navSelect('actions', 3);
    eq(state.getSel('actions'), 3, 'actions cursor advanced');
    require('../dispatch/control/dispatch').navSelect('groups', 1);
    eq(state.getSel('groups'), 1, 'groups cursor advanced');
  });

  it('navSelect: yanks the slot back to Info when focus has getInfo and slot is on another tab', () => {
    // U2e P1b — the yank moved OUT of the viewer_show_info reducer arm
    // (`tab: 0`) into dispatch.showSelectedInfo: when the focused pane HAS
    // getInfo, it dispatches info_show_content AND a `set_active_tab` that makes
    // the content slot's ACTIVE position-tab the info instance. So the assertion
    // is now "the slot's active instance == the info instance," not a flat
    // slice.tab. focus on detail / no-getInfo panels still bails (no lines).
    const route = require('../panel/route');
    const dispatch = require('../dispatch/control/dispatch');
    seedContentSlot();
    // Seed a group + action so actions panel has items to feed getInfo.
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    const slotPaneId = route.resolveViewerPaneId();
    const infoInst = route.resolveTarget('viewer_info');
    const transInst = route.resolveTarget('viewer_transcript');
    // Park the slot's active tab on Transcript (off Info).
    const mpane = require('../leaves/wm/pane');
    require('../panel/api').dispatchMsg(require('../panel/api').wrap('layout',
      { type: 'set_active_tab', paneId: slotPaneId, tabPoolId: mpane.poolIdOf(transInst) }));
    eq(route.activeInstanceOf(slotPaneId), transInst, 'precondition: slot on Transcript');
    // Move cursor in actions — focus is on actions, actions has getInfo,
    // items[0] exists → showSelectedInfo yanks the slot to the info instance.
    dispatch.navSelect('actions', 0);
    eq(route.activeInstanceOf(slotPaneId), infoInst, 'yanked back to Info');
  });

  it('navSelect: yanks from any non-Info tab (not just Transcript)', () => {
    // Pin that the yank fires from ANY non-Info active tab — the precondition
    // is "focus has getInfo," and the consequence is "slot active = info
    // instance." Mint a THIRD content position-tab (a text-view) and park the
    // slot on it, then confirm navSelect still yanks to Info.
    const route = require('../panel/route');
    const api = require('../panel/api');
    const dispatch = require('../dispatch/control/dispatch');
    seedContentSlot();
    const m = runtime.getModel();
    m.config = { groups: { g: { label: 'G', actions: {
      a: { label: 'A', desc: 'an action', script: 'echo a' },
    } } } };
    m.currentGroup = 'g';
    route.getInstanceSlice('layout').focus = 'actions';
    const slotPaneId = route.resolveViewerPaneId();
    const infoInst = route.resolveTarget('viewer_info');
    // Mint an extra content text-view tab into the slot (mint_tab always
    // activates it — a 3rd, non-Info, non-Transcript tab, the "any tab" case).
    const extraPool = 'content-extra';
    api.dispatchMsg(api.wrap('layout', { type: 'mint_tab', paneId: slotPaneId,
      poolId: extraPool, paneType: 'text-view', title: 'Extra', config: { lines: ['x'] },
      hint: { origin: 'open' } }));
    const extraInst = route.activeInstanceOf(slotPaneId);
    eq(extraInst, 'pane-' + extraPool, 'precondition: slot on the extra tab');
    dispatch.navSelect('actions', 0);
    eq(route.activeInstanceOf(slotPaneId), infoInst, 'yanked back to Info from a 3rd tab');
  });

  it('showSelectedInfo bails when the focused pane has no getInfo — no yank', () => {
    // U2f — the deleted `viewer_show_info` arm's "no-getInfo focus → no yank"
    // bail (T1 contract; kept the addContentTab-opened tab from being yanked to
    // Info by a cascade) now lives in dispatch.showSelectedInfo: infoLinesFromFocus
    // returns null for a focus with no getInfo, and the chokepoint returns before
    // dispatching info_show_content OR the set_active_tab yank. Drive the live
    // chokepoint with focus PARKED on the content slot (a content-viewer pane has
    // no getInfo) and assert the slot's active tab is untouched.
    const route = require('../panel/route');
    const api = require('../panel/api');
    const dispatch = require('../dispatch/control/dispatch');
    seedContentSlot();
    const slotPaneId = route.resolveViewerPaneId();
    const transInst = route.resolveTarget('viewer_transcript');
    const mpane = require('../leaves/wm/pane');
    // Park the slot's active tab on Transcript (off Info).
    api.dispatchMsg(api.wrap('layout',
      { type: 'set_active_tab', paneId: slotPaneId, tabPoolId: mpane.poolIdOf(transInst) }));
    eq(route.activeInstanceOf(slotPaneId), transInst, 'precondition: slot on Transcript');
    // Focus the content slot itself — a content-viewer pane exposes no getInfo.
    route.getInstanceSlice('layout').focus = slotPaneId;
    dispatch.showSelectedInfo();
    eq(route.activeInstanceOf(slotPaneId), transInst,
      'active tab unchanged — yank skipped (focus has no getInfo)');
  });
  // U2f — the remaining `viewer_show_info` arm tests are RETIRED here: that Msg +
  // the detail viewer's flat-tab machinery (slice.tab / slice.infoLines / slice.
  // tabState) are gone. Their intent is fully re-homed + covered by
  // test-info-pane.js `[info P0] info_show_content`:
  //   - "stores lines + resets scroll on content change"      (was: R3 within-Info scroll→0, P0 store)
  //   - "is a true no-op ... (ref-stable slice)"              (was: P0 equal-content no-op)
  //   - "keeps the lines ref stable across content-equal ..."  (was: P0 lines-ref stability + scroll reset)
  //   - "resets the match cursor (search.idx) on real change"  (was: A4/P1 match-cursor reset, keeps term)
  // The off-Info→Info per-tab-state RESTORE (was: R3 tabState[info]) is not an arm
  // concern anymore — content instances are their own position-tabs, so per-tab
  // view-state persists on each instance's slice + is restored by the framework's
  // tab-state / mint reconcile, not a viewer-internal `tabState` map.
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
    const dispatch = require('../dispatch/control/dispatch');
    // blessed-A — the reducer arms read `msg.route`; the production handler
    // stamps it. Driving applyMsg directly bypasses the handler, so thread
    // the bundle here (mirrors the shell — same as F1's augmentMsg tests).
    const route = require('../panel/route');
    const rb = () => route.bundle('containers');
    dispatch.applyMsg({ type: 'list_select', mode: 'toggle', route: rb() });
    eq(runtime.getModel().modes.listSelectMode, true, 'toggle on');
    state.toggleMultiSel('containers', 'a');
    state.toggleMultiSel('containers', 'b');
    eq(state.multiSelCount('containers'), 2, 'two items selected');
    dispatch.applyMsg({ type: 'escape', hadMultiSel: state.multiSelCount('containers') > 0, route: rb() });
    eq(runtime.getModel().modes.listSelectMode, false, 'escape exits select mode');
    eq(state.multiSelCount('containers'), 0, 'escape clears the selection');
    // escape again with a lingering selection but not in select mode
    state.toggleMultiSel('containers', 'x');
    dispatch.applyMsg({ type: 'escape', hadMultiSel: state.multiSelCount('containers') > 0, route: rb() });
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
  it('toggle_groups_tab clears multiSel — selections from prior tab don\'t survive context change', () => {
    // Round-2 regression: All-tab vs Quick-tab expose different group
    // rows; multiSel ids from one tab reference rows that may not
    // exist in the other. switchTab now clears multiSel on toggle.
    const groups = require('../panel/navigator/groups');
    const m = runtime.getModel();
    m.config = { groups: {
      g1: { name: 'g1', quick: true, children: [], parent: null },
      g2: { name: 'g2', quick: true, children: [], parent: null },
    } };
    m.currentGroup = '';
    const ctx = { ...groups.groupsBundle(m), tabListMode: false };
    const step = (sl, msg) => {
      const out = groups._update({ ...msg, ctx }, sl);
      return Array.isArray(out) ? out[0] : out;
    };
    let slice = groups._init();
    // Seed multiSel as if the user had picked two rows in All-tab.
    slice = { ...slice, nav: { ...slice.nav, multiSel: new Set(['g1', 'g2']) } };
    eq(slice.nav.multiSel.size, 2, 'seeded multiSel');
    slice = step(slice, { type: 'toggle_groups_tab' });
    eq(slice.tab, 'quick', 'toggled to quick');
    eq(slice.nav.multiSel.size, 0, 'multiSel cleared on tab toggle');
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
    // directly. U2e P1b — next_tab / prev_tab cycle the content slot's VISIBLE
    // position-tabs: the handler stamps { slotPaneId, tabPoolIds, curIdx } and
    // the arm emits a `set_active_tab` (wrapped to layout) targeting the next
    // poolId. Thread a 2-tab bundle (Info + Transcript) directly — the arm's
    // cycle math is pure of route topology.
    const bundle = {
      slotPaneId: 'pane-detail',
      tabPoolIds: ['info-pane-detail', 'transcript-pane-detail'],
      curIdx: 0,
    };
    const cmdsNext = runtime.update(m, { type: 'next_tab', ...bundle })[1];
    const cmdsPrev = runtime.update(m, { type: 'prev_tab', ...bundle })[1];
    eq(cmdsNext[0].msg.msg.type, 'set_active_tab');
    eq(cmdsPrev[0].msg.msg.type, 'set_active_tab');
    // 2 tabs, curIdx=0: dir +1 → idx 1 (Transcript); dir -1 → idx 1 (wrap).
    eq(cmdsNext[0].msg.msg.tabPoolId, 'transcript-pane-detail');
    eq(cmdsPrev[0].msg.msg.tabPoolId, 'transcript-pane-detail');
    eq(cmdsNext[0].msg.msg.paneId, 'pane-detail');
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

describe('[10] streamed output — tv_stream_start / tv_append (Transcript instance)', () => {
  // U2e P1b — the unrouted stream no longer flows through the detail viewer's
  // flat-strip stream_start/viewer_append (viewerStreamBuffer + auto-jump to a
  // `tab` index). It seeds the TRANSCRIPT text-view instance (a position-tab of
  // the content slot, hint:'transcript') via tv_stream_start / tv_append, whose
  // buffer lives on `slice.lines` (dispatch/runtime/stream.js resolves the target
  // via route.resolveTarget('viewer_transcript')). Test the LIVE path against the
  // text-view Component's update with an isolated slice.
  const tv = require('../panel/text-view/text-view');
  it('tv_stream_start reseeds the transcript buffer to the header + resets scroll', () => {
    const init = tv.init();
    const slice = { ...init, lines: ['old', 'stuff'], scroll: 5 };
    const next = tv.update({ type: 'tv_stream_start', header: '$ run' }, slice);
    eq(displayedLines(next).length, 1);
    eq(displayedLines(next)[0], '$ run');
    eq(next.scroll, 0, 'scroll reset to top on re-run');
  });
  it('tv_append pins to bottom when already at bottom', () => {
    // The instance owns its own scroll; at the bottom the view follows the tail.
    const init = tv.init();
    const slice = { ...init, scroll: 0, innerH: 3, lines: ['a', 'b', 'c'] };
    const next = tv.update({ type: 'tv_append', line: 'd' }, slice);
    eq(displayedLines(next).length, 4);
    eq(next.scroll, 1, 'followed to the new bottom');
  });
  it('tv_append leaves scroll alone when the user scrolled up', () => {
    const init = tv.init();
    const slice = { ...init, scroll: 0, innerH: 3, lines: ['a', 'b', 'c', 'd', 'e'] };  // maxScroll 2, user at top
    const next = tv.update({ type: 'tv_append', line: 'f' }, slice);
    eq(displayedLines(next).length, 6);
    eq(next.scroll, 0, 'not yanked down — user was reading');
  });
});

report();
