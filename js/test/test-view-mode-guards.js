/**
 * Free-config × view-mode guards (v0.6).
 *
 * Free-config's drag/resize gestures operate on the full grid and need
 * every cell visible — half/full view modes hide cells, so the combo
 * "free-config + non-normal view" is structurally broken. Two guards
 * enforce the separation:
 *
 *   - design_enter from half/full view is refused; `slice.design.notice`
 *     carries the reason for the footer.
 *   - view_expand / view_shrink (user-input `[` / `]`) while
 *     freeConfigMode is on is refused; same notice mechanism.
 *
 * Programmatic view changes (`view_set` from cmdline / pty-lifecycle,
 * `view_drop_full_to_normal` from terminal exit) stay unguarded — they
 * fire from system events, not user navigation.
 *
 *   node js/test/test-view-mode-guards.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');
const { getModel } = require('../app/runtime');
const { getComponentSlice } = require('../panel/api');

function setFreeConfig(on) {
  getModel().modes.freeConfigMode = !!on;
}

function freshLayoutSlice(viewMode) {
  const s = layout.init();
  s.viewMode = viewMode;
  // Ensure design.notice slot exists (matches init); tests may inspect it.
  return s;
}

describe('[1] design_enter from half/full → refused with notice', () => {
  it('half view refuses entry; viewMode unchanged; notice set', () => {
    setFreeConfig(false);
    const s = freshLayoutSlice('half');
    const result = layout.update({ type: 'design_enter' }, s);
    // Refused path returns the slice alone (no Cmd) so freeConfigMode
    // stays off — no mode_set effect emitted.
    assert(!Array.isArray(result), 'refused entry returns plain slice (no Cmds)');
    eq(result.viewMode, 'half', 'view unchanged');
    assert(result.design.notice && /normal view/.test(result.design.notice),
      `notice mentions normal view (got "${result.design.notice}")`);
  });

  it('full view refuses entry', () => {
    setFreeConfig(false);
    const s = freshLayoutSlice('full');
    const result = layout.update({ type: 'design_enter' }, s);
    assert(!Array.isArray(result), 'refused entry returns plain slice');
    eq(result.viewMode, 'full');
    assert(result.design.notice, 'notice is set');
  });

  it('normal view allows entry; emits mode_set; notice cleared', () => {
    setFreeConfig(false);
    const s = freshLayoutSlice('normal');
    // Seed a stale notice that should clear on successful entry.
    s.design = { ...s.design, notice: 'stale' };
    // Need at least one placed panel for clampSelected; init left/right
    // panels are empty — push a fake one so allDesignPanels is non-empty.
    s.arrange = { ...s.arrange, leftPanels: [{ id: 'a', type: 'a', column: 'left', hotkey: '1' }] };
    s.focus = 'a';
    const result = layout.update({ type: 'design_enter' }, s);
    assert(Array.isArray(result), 'allowed entry returns [slice, cmds]');
    const [next, cmds] = result;
    eq(next.design.notice, null, 'stale notice cleared on entry');
    assert(cmds.some(c => c.type === 'apply_msg' && c.msg.flag === 'freeConfigMode'),
      'mode_set Cmd emitted');
  });
});

describe('[2] view_expand / view_shrink in free-config → refused with notice', () => {
  it('view_expand in free-config: refused; viewMode unchanged; notice set', () => {
    setFreeConfig(true);
    const s = freshLayoutSlice('normal');
    const result = layout.update({ type: 'view_expand' }, s);
    assert(!Array.isArray(result), 'refused returns plain slice (no repaint cmd)');
    eq(result.viewMode, 'normal', 'view unchanged');
    assert(result.design.notice && /free-config/.test(result.design.notice),
      `notice mentions free-config (got "${result.design.notice}")`);
    setFreeConfig(false);
  });

  it('view_shrink in free-config: refused', () => {
    setFreeConfig(true);
    const s = freshLayoutSlice('half');  // setup that would normally shrink to normal
    const result = layout.update({ type: 'view_shrink' }, s);
    assert(!Array.isArray(result));
    eq(result.viewMode, 'half', 'view unchanged');
    assert(result.design.notice, 'notice set');
    setFreeConfig(false);
  });

  it('view_expand outside free-config: allowed', () => {
    setFreeConfig(false);
    const s = freshLayoutSlice('normal');
    const result = layout.update({ type: 'view_expand' }, s);
    assert(Array.isArray(result), 'allowed returns [slice, cmds]');
    const [next, cmds] = result;
    eq(next.viewMode, 'half', 'view expanded');
    eq(next.design.notice, null, 'no notice');
    assert(cmds.some(c => c.type === 'force_full_repaint'), 'repaint cmd emitted');
  });

  it('view_shrink success clears stale notice', () => {
    setFreeConfig(false);
    const s = freshLayoutSlice('half');
    s.design = { ...s.design, notice: 'stale' };
    const result = layout.update({ type: 'view_shrink' }, s);
    assert(Array.isArray(result));
    const [next] = result;
    eq(next.viewMode, 'normal');
    eq(next.design.notice, null, 'notice cleared by successful view change');
  });

  it('programmatic view_set is NOT blocked even in free-config', () => {
    // pty-lifecycle.js fires view_set on terminal exit; that flow must
    // keep working regardless of free-config state.
    setFreeConfig(true);
    const s = freshLayoutSlice('full');
    const result = layout.update({ type: 'view_set', mode: 'normal' }, s);
    assert(Array.isArray(result), 'programmatic view_set returns [slice, cmds]');
    const [next] = result;
    eq(next.viewMode, 'normal', 'view_set committed');
    setFreeConfig(false);
  });

  it('view_drop_full_to_normal (terminal exit) is NOT blocked in free-config', () => {
    setFreeConfig(true);
    const s = freshLayoutSlice('full');
    const result = layout.update({ type: 'view_drop_full_to_normal' }, s);
    assert(Array.isArray(result));
    const [next] = result;
    eq(next.viewMode, 'normal');
    setFreeConfig(false);
  });
});

describe('[3] design_exit clears notice', () => {
  it('design_exit wipes a stale notice along with drag/title/undo state', () => {
    setFreeConfig(true);
    const s = freshLayoutSlice('normal');
    s.design = { ...s.design, notice: 'stale notice' };
    const result = layout.update({ type: 'design_exit' }, s);
    assert(Array.isArray(result));
    const [next] = result;
    eq(next.design.notice, null);
    setFreeConfig(false);
  });
});

report();
