/**
 * Half-view focus tracking (v0.6 polish).
 *
 * In half view the screen shows "non-detail panel on the left + detail
 * on the right." When focus moves to detail (e.g., a tab-bar click that
 * dispatches `focus_set` to detail), the left side falls back to
 * `slice.halfLeftPanel` — the most recently focused non-detail panel.
 * Without this fallback the left would render detail too, duplicating
 * the panel on both halves.
 *
 *   - focus_set to a non-detail panel updates halfLeftPanel
 *   - focus_set to detail leaves halfLeftPanel untouched (stays sticky)
 *
 *   node js/test/test-half-view-focus.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');

function applyUpdate(slice, msg) {
  const r = layout.update(msg, slice);
  return Array.isArray(r) ? { next: r[0], cmds: r[1] } : { next: r, cmds: [] };
}

describe('[focus_set] tracks halfLeftPanel for half-view rendering', () => {
  it('init starts with halfLeftPanel = null', () => {
    const s = layout.init();
    eq(s.halfLeftPanel, null);
  });

  it('focus_set to a non-detail panel updates halfLeftPanel', () => {
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.focus, 'groups');
    eq(s.halfLeftPanel, 'groups');
  });

  it('focus_set to detail leaves halfLeftPanel untouched (sticky)', () => {
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'containers' }).next;
    eq(s.halfLeftPanel, 'containers');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.focus, 'detail');
    eq(s.halfLeftPanel, 'containers', 'halfLeftPanel stays at last non-detail');
  });

  it('focus_set bounces detail → other non-detail → detail correctly', () => {
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.halfLeftPanel, 'groups');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.halfLeftPanel, 'groups');
    s = applyUpdate(s, { type: 'focus_set', focus: 'containers' }).next;
    eq(s.halfLeftPanel, 'containers', 'updates to new non-detail focus');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.halfLeftPanel, 'containers', 'sticks at containers');
  });

  it('msg.focus == null is a no-op (preserves both focus and halfLeftPanel)', () => {
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    const before = s.halfLeftPanel;
    s = applyUpdate(s, { type: 'focus_set', focus: null }).next;
    eq(s.focus, 'groups');
    eq(s.halfLeftPanel, before);
  });
});

describe('[design_exit] commits current focus to halfLeftPanel', () => {
  it('non-detail focus on exit → halfLeftPanel updated', () => {
    // Free-config nav (design_nav etc.) writes focus directly without
    // routing through focus_set, so halfLeftPanel may not have tracked
    // in-mode movement. design_exit catches it up.
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.halfLeftPanel, 'groups');
    // Simulate free-config in-mode focus drift (direct write, not focus_set).
    s = { ...s, focus: 'containers' };
    eq(s.halfLeftPanel, 'groups', 'direct focus write didn’t update halfLeftPanel');
    s = applyUpdate(s, { type: 'design_exit' }).next;
    eq(s.halfLeftPanel, 'containers', 'design_exit committed the in-mode focus');
  });

  it('detail focus on exit → halfLeftPanel unchanged (no detail in left)', () => {
    let s = layout.init();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    s = { ...s, focus: 'detail' };
    s = applyUpdate(s, { type: 'design_exit' }).next;
    eq(s.halfLeftPanel, 'groups', 'detail focus doesn’t overwrite halfLeftPanel');
  });
});

report();
