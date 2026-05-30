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
    // detail.update reads getModel().panelHeights — write to the singleton so
    // the viewport-based clamp uses the test's value.
    require('../panel/api').getComponentSlice('layout').panelHeights.detail = 22;  // viewport = 20 → maxScroll 80
    // Phase 3 — _update returns the new slice; step() threads it through.
    const step = (sl, msg) => {
      const out = detail._update(msg, sl);
      return Array.isArray(out) ? out[0] : out;
    };
    let slice = detail._init();
    slice = { ...slice, lines: new Array(100).fill('x') };
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
  it('escape / list_select: emit wrapped multisel_clear into the focused Component', () => {
    // Phase 4a — escape/list_select route multiSel clears through the
    // focused Navigator's update (single-writer per slice). Read via the
    // state helper to assert the post-effect outcome.
    const api = require('../panel/api');
    const state = require('../app/state');
    const m = runtime.getModel();
    api.getComponentSlice('layout').focus = 'containers';
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
    const step = (sl, msg) => {
      const out = groups._update(msg, sl);
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
  it('design: gate is pure reducer logic — Cmd only when layout slice has design.enabled', () => {
    // Phase 1f migration: designEnabled lives on layout.slice.design.enabled.
    const api = require('../panel/api');
    const m = runtime.init();
    const layoutSlice = api.getComponentSlice('layout');
    layoutSlice.design.enabled = false;
    const [, off] = runtime.update(m, { type: 'design' });
    eq(off.length, 0, 'no start_design Cmd when disabled');
    layoutSlice.design.enabled = true;
    const [, on] = runtime.update(m, { type: 'design' });
    eq(on.length, 1);
    eq(on[0].type, 'start_design');
  });
  it('Cmd-only verbs route Msg → Cmd without touching the model', () => {
    const m = runtime.init();
    const snap = JSON.stringify(m.focus);
    eq(runtime.update(m, { type: 'refresh' })[1][0].type, 'refresh');
    eq(runtime.update(m, { type: 'show_help' })[1][0].type, 'show_help');
    eq(runtime.update(m, { type: 'next_tab' })[1][0].msg.msg.dir, +1);
    eq(runtime.update(m, { type: 'prev_tab' })[1][0].msg.msg.dir, -1);
    eq(runtime.update(m, { type: 'quit' })[1][0].type, 'quit');
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
    eq(cmds[0].type, 'dispatch_msg');
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
  it('stream_start replaces detail with the header + resets scroll', () => {
    const m = runtime.init();
    const init = detail._init();
    const slice = { ...init, lines: ['old', 'stuff'], scroll: 5 };
    const r = detail._update({ type: 'stream_start', header: '$ run' }, slice);
    eq(r.lines.length, 1);
    eq(r.lines[0], '$ run');
    eq(r.scroll, 0);
    assert(!Array.isArray(r), 'no effects — bare slice return');
  });
  it('viewer_append pins to bottom when already at bottom', () => {
    require('../panel/api').getComponentSlice('layout').panelHeights.detail = 5;   // innerH = 3
    const init = detail._init();
    const slice = { ...init, lines: ['a', 'b', 'c'], scroll: 0 };  // maxScroll = 0, at bottom
    const r = detail._update({ type: 'viewer_append', line: 'd' }, slice);
    eq(r.lines.length, 4);
    eq(r.scroll, 1, 'followed to the new bottom');
  });
  it('viewer_append leaves scroll alone when the user scrolled up', () => {
    require('../panel/api').getComponentSlice('layout').panelHeights.detail = 5;   // innerH = 3
    const init = detail._init();
    const slice = { ...init, lines: ['a', 'b', 'c', 'd', 'e'], scroll: 0 };  // maxScroll = 2, user at top
    const r = detail._update({ type: 'viewer_append', line: 'f' }, slice);
    eq(r.lines.length, 6);
    eq(r.scroll, 0, 'not yanked down — user was reading');
  });
});

report();
