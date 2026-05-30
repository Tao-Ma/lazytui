/**
 * v0.5 TEA spike — the root-model reducer/dispatch seam (js/runtime.js).
 * So far only the `viewMode` slice has migrated off the global S.
 *
 * Run: node js/test/test-runtime.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../runtime');

describe('[0] init — builds the root model', () => {
  it('returns a fresh model with viewMode defaulted', () => {
    const m = runtime.init();
    eq(m.viewMode, 'normal');
  });
});

describe('[1] reduceViewMode — pure cycling', () => {
  const r = runtime.reduceViewMode;
  it('view_expand: normal → half → full → full', () => {
    eq(r('normal', { type: 'view_expand' }), 'half');
    eq(r('half',   { type: 'view_expand' }), 'full');
    eq(r('full',   { type: 'view_expand' }), 'full');
  });
  it('view_shrink: full → half → normal → normal', () => {
    eq(r('full',   { type: 'view_shrink' }), 'half');
    eq(r('half',   { type: 'view_shrink' }), 'normal');
    eq(r('normal', { type: 'view_shrink' }), 'normal');
  });
  it('view_set sets a valid mode; ignores junk', () => {
    eq(r('normal', { type: 'view_set', mode: 'full' }), 'full');
    eq(r('full',   { type: 'view_set', mode: 'bogus' }), 'full');
  });
  it('unknown msg is a no-op', () => {
    eq(r('half', { type: 'whatever' }), 'half');
  });
});

describe('[2] dispatch — applies the reducer, reports change', () => {
  it('mutates the model and returns whether it changed', () => {
    // reset to a known state
    runtime.getModel().viewMode = 'normal';
    eq(runtime.dispatch({ type: 'view_expand' }), true);
    eq(runtime.getModel().viewMode, 'half');
    eq(runtime.dispatch({ type: 'view_shrink' }), true);
    eq(runtime.getModel().viewMode, 'normal');
    eq(runtime.dispatch({ type: 'view_shrink' }), false, 'no change at normal → false');
    eq(runtime.getModel().viewMode, 'normal');
  });
});

describe('[3] update — (model, msg) → [model, cmds], pure + Cmd descriptors', () => {
  it('view transition returns a force_full_repaint Cmd; no-op returns none', () => {
    const m = runtime.init();                       // isolated model, not the singleton
    const [m1, c1] = runtime.update(m, { type: 'view_expand' });
    eq(m1.viewMode, 'half');
    eq(c1.length, 1);
    eq(c1[0].type, 'force_full_repaint');
    const [, c2] = runtime.update(m1, { type: 'view_shrink' }); // half → normal: changed
    eq(c2.length, 1);
    const [, c3] = runtime.update(m1, { type: 'view_shrink' }); // normal → normal: no change
    eq(c3.length, 0, 'no Cmd when viewMode did not change');
  });
  it('focus_set stores focus and always emits show_selected_info', () => {
    const m = runtime.init();
    const [m1, cmds] = runtime.update(m, { type: 'focus_set', focus: 'actions' });
    eq(m1.focus, 'actions');
    eq(cmds.length, 1);
    eq(cmds[0].type, 'show_selected_info');
    // null focus leaves it put but still refreshes the body
    const [m2, cmds2] = runtime.update(m1, { type: 'focus_set', focus: null });
    eq(m2.focus, 'actions', 'null focus is a no-op on the value');
    eq(cmds2[0].type, 'show_selected_info');
  });
  it('returns the SAME model object (hybrid: mutate-and-return)', () => {
    const m = runtime.init();
    const [m1] = runtime.update(m, { type: 'focus_set', focus: 'groups' });
    assert(m1 === m, 'update returns the threaded model, not a clone (Phase-0 contract)');
  });
  it('viewer_scroll: delta pages clamped, to:top/bottom jumps, no effects', () => {
    // Phase B: viewer_scroll moved to detail.update — test the Component
    // update directly with an isolated slice.
    const detail = require('../plugins/core/viewer');
    // detail.update reads getModel().panelHeights — write to the singleton so
    // the viewport-based clamp uses the test's value.
    runtime.getModel().panelHeights.detail = 22;  // viewport = 20 → maxScroll 80
    const slice = detail._init();
    slice.lines = new Array(100).fill('x');
    detail._update({ type: 'viewer_scroll', delta: 30 }, slice);
    eq(slice.scroll, 30);
    detail._update({ type: 'viewer_scroll', delta: 999 }, slice);
    eq(slice.scroll, 80, 'clamped to maxScroll');
    detail._update({ type: 'viewer_scroll', delta: -999 }, slice);
    eq(slice.scroll, 0, 'clamped to 0');
    detail._update({ type: 'viewer_scroll', to: 'bottom' }, slice);
    eq(slice.scroll, 80);
    const r = detail._update({ type: 'viewer_scroll', to: 'top' }, slice);
    eq(slice.scroll, 0);
    // Bare slice return = no effects array.
    assert(!Array.isArray(r), 'scroll returns bare slice (no effects)');
  });
  it('nav_select: plain panel stores index purely; groups cascades inline', () => {
    const m = runtime.init();
    const [m1, c1] = runtime.update(m, { type: 'nav_select', panel: 'actions', index: 3 });
    eq(m1.ui.sel.actions, 3, 'plain panel selection is a pure model write');
    eq(c1.length, 1);
    eq(c1[0].type, 'show_selected_info');
    // Phase C: nav_select for groups writes ui.sel.groups (uniform) AND emits
    // dispatch_msg → groups Component, which is then responsible for the
    // cascade (currentGroup / reset_group_context / viewer_reset_chrome).
    const [, c2] = runtime.update(m, { type: 'nav_select', panel: 'groups', index: 1 });
    eq(m.ui.sel.groups, 1, 'groups index written uniformly by nav_select');
    eq(c2.length, 2);
    eq(c2[0].type, 'show_selected_info');
    eq(c2[1].type, 'dispatch_msg');
    eq(c2[1].msg.type, 'groups_selected');
    eq(c2[1].msg.index, 1);
  });
  it('escape / list_select: pure model.modes + model.ui.multiSel writes', () => {
    const m = runtime.init();
    m.focus = 'containers';
    // list_select toggle on, then escape exits + clears the selection
    runtime.update(m, { type: 'list_select', mode: 'toggle' });
    eq(m.modes.listSelectMode, true, 'toggle on');
    m.ui.multiSel.containers = new Set(['a', 'b']);
    const [, c] = runtime.update(m, { type: 'escape' });
    eq(m.modes.listSelectMode, false, 'escape exits select mode');
    eq(m.ui.multiSel.containers, undefined, 'escape clears the selection');
    eq(c.length, 0, 'escape emits no Cmd');
    // escape again with a lingering selection but not in select mode
    m.ui.multiSel.containers = new Set(['x']);
    runtime.update(m, { type: 'escape' });
    eq(m.ui.multiSel.containers, undefined, 'escape clears lingering selection');
    // list_select on (the * path) forces it true
    runtime.update(m, { type: 'list_select', mode: 'on' });
    eq(m.modes.listSelectMode, true, 'mode:on forces select mode');
  });
  it('toggle_groups_tab + toggle_group are handled by the groups Component (Phase C)', () => {
    // Phase C: these Msgs moved out of runtime.update into groups.update.
    // Test the Component update directly with an isolated slice.
    const groups = require('../plugins/core/groups');
    const m = runtime.getModel();  // the leaves read getModel().config
    m.config = { groups: {
      g1: { name: 'g1', quick: true, children: ['g1.a'], parent: null },
      'g1.a': { name: 'g1.a', children: [], parent: 'g1' },
    } };
    m.currentGroup = '';

    const slice = groups._init();
    eq(slice.tab, 'all');
    // toggle_groups_tab
    groups._update({ type: 'toggle_groups_tab' }, slice);
    eq(slice.tab, 'quick', 'all → quick');
    groups._update({ type: 'toggle_groups_tab' }, slice);
    eq(slice.tab, 'all', 'quick → all');
    // toggle_group
    groups._update({ type: 'toggle_group', name: 'g1' }, slice);
    eq(slice.expanded.has('g1'), true, 'expanded after first toggle');
    groups._update({ type: 'toggle_group', name: 'g1' }, slice);
    eq(slice.expanded.has('g1'), false, 'collapsed after second toggle');
  });
  it('design: gate is pure reducer logic — Cmd only when model.designEnabled', () => {
    const m = runtime.init();
    eq(m.designEnabled, false);
    const [, off] = runtime.update(m, { type: 'design' });
    eq(off.length, 0, 'no start_design Cmd when disabled');
    m.designEnabled = true;
    const [, on] = runtime.update(m, { type: 'design' });
    eq(on.length, 1);
    eq(on[0].type, 'start_design');
  });
  it('Cmd-only verbs route Msg → Cmd without touching the model', () => {
    const m = runtime.init();
    const snap = JSON.stringify(m.focus) + m.viewMode;
    eq(runtime.update(m, { type: 'refresh' })[1][0].type, 'refresh');
    eq(runtime.update(m, { type: 'show_help' })[1][0].type, 'show_help');
    eq(runtime.update(m, { type: 'next_tab' })[1][0].dir, +1);
    eq(runtime.update(m, { type: 'prev_tab' })[1][0].dir, -1);
    eq(runtime.update(m, { type: 'quit' })[1][0].type, 'quit');
    eq(JSON.stringify(m.focus) + m.viewMode, snap, 'model unchanged by Cmd-only verbs');
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
    const m = runtime.init();
    const [, cmds] = runtime.update(m, { type: 'terminal_enter' });
    eq(m.modes.terminalMode, true);
    eq(cmds.length, 0);
  });
  it('terminal_exit clears the flag; drops full→normal + repaint Cmd', () => {
    const m = runtime.init();
    m.modes.terminalMode = true;
    m.viewMode = 'full';
    const [, cmds] = runtime.update(m, { type: 'terminal_exit' });
    eq(m.modes.terminalMode, false);
    eq(m.viewMode, 'normal');
    eq(cmds[0].type, 'force_full_repaint');
  });
  it('terminal_exit from non-full leaves viewMode + emits no Cmd', () => {
    const m = runtime.init();
    m.modes.terminalMode = true;
    m.viewMode = 'half';
    const [, cmds] = runtime.update(m, { type: 'terminal_exit' });
    eq(m.viewMode, 'half');
    eq(cmds.length, 0);
  });
  it('multisel_toggle adds then removes; drops the panel key when empty', () => {
    const m = runtime.init();
    runtime.update(m, { type: 'multisel_toggle', panel: 'containers', id: 'c1' });
    assert(m.ui.multiSel.containers.has('c1'), 'added');
    runtime.update(m, { type: 'multisel_toggle', panel: 'containers', id: 'c1' });
    eq(m.ui.multiSel.containers, undefined, 'panel key dropped when set empties');
  });
  it('multisel_select_all adds every id (idempotent)', () => {
    const m = runtime.init();
    runtime.update(m, { type: 'multisel_toggle', panel: 'containers', id: 'c1' });
    runtime.update(m, { type: 'multisel_select_all', panel: 'containers', ids: ['c1', 'c2', 'c3'] });
    eq(m.ui.multiSel.containers.size, 3, 'c1 not double-added');
  });
});

describe('[10] streamed output — stream_start / viewer_append (effect source)', () => {
  // Phase B: stream_start + viewer_append moved into detail.update — tested
  // here against the Component update with an isolated slice.
  const detail = require('../plugins/core/viewer');
  it('stream_start replaces detail with the header + resets scroll', () => {
    const m = runtime.init();
    const slice = detail._init();
    slice.lines = ['old', 'stuff'];
    slice.scroll = 5;
    const r = detail._update({ type: 'stream_start', header: '$ run' }, slice);
    eq(slice.lines.length, 1);
    eq(slice.lines[0], '$ run');
    eq(slice.scroll, 0);
    assert(!Array.isArray(r), 'no effects — bare slice return');
  });
  it('viewer_append pins to bottom when already at bottom', () => {
    runtime.getModel().panelHeights.detail = 5;   // innerH = 3
    const slice = detail._init();
    slice.lines = ['a', 'b', 'c'];      // maxScroll = 0, scroll 0 = at bottom
    slice.scroll = 0;
    detail._update({ type: 'viewer_append', line: 'd' }, slice);
    eq(slice.lines.length, 4);
    eq(slice.scroll, 1, 'followed to the new bottom');
  });
  it('viewer_append leaves scroll alone when the user scrolled up', () => {
    runtime.getModel().panelHeights.detail = 5;   // innerH = 3
    const slice = detail._init();
    slice.lines = ['a', 'b', 'c', 'd', 'e'];  // maxScroll = 2
    slice.scroll = 0;                          // user scrolled up to the top
    detail._update({ type: 'viewer_append', line: 'f' }, slice);
    eq(slice.lines.length, 6);
    eq(slice.scroll, 0, 'not yanked down — user was reading');
  });
});

report();
