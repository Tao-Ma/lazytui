/**
 * Live-render harness (v0.5) — boots the real state + core plugins,
 * drives the REAL key path (input → dispatch → layout.render), captures
 * the bytes written to stdout, and asserts on the rendered frame.
 *
 * This is the verification seam the TEA migration needs: it exercises
 * the whole render pipeline headlessly so a state-slice migration can be
 * checked against actual on-screen output, not just unit-level state.
 *
 * Run: node js/test/test-live-render.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../components/api');

const { initState, getSel, setSel, selectGroup } = require('../state');

// --- boot a minimal-but-real app (mirrors tui.js boot, no PTY/input) ---
const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') },
};
initState();
getModel().projectDir = '.';

const { handleKey } = require('../dispatch');
// The program owns the model and threads it into handleKey; the harness
// plays that owner role here.
const model = getModel();

// Strip ANSI/CSI escapes so we can assert on the visible text.
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, ''); }

// Run `fn` while capturing everything written to stdout; return the
// visible (ANSI-stripped) frame.
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return stripAnsi(chunks.join(''));
}

const { render } = require('../layout');

describe('[1] live render pipeline boots + paints', () => {
  it('renders a frame without throwing, showing panel chrome', () => {
    const frame = capture(() => render());
    assert(frame.length > 0, 'something was painted');
    // The footer hint line is always present in normal mode.
    assert(/q quit/.test(frame), `footer painted: ${JSON.stringify(frame.slice(-80))}`);
  });
});

describe('[2] viewMode flows model → view end-to-end (the v0.5 slice, live)', () => {
  it('normal mode shows no [half]/[full] tag', () => {
    const frame = capture(() => render());
    assert(!/\[half\]|\[full\]/.test(frame), 'no view-mode tag in normal');
  });
  it('pressing + (the real key path) renders the [half] footer tag', () => {
    // handleKey runs the real dispatch (case '+' → handleAction
    // view_expand → runtime model update) AND paints — capture that.
    const frame = capture(() => handleKey(model, '+', '+'));
    assert(/\[half\]/.test(frame), `[half] tag rendered after +: ${JSON.stringify(frame.slice(-80))}`);
  });
  it('pressing + again renders [full]', () => {
    const frame = capture(() => handleKey(model, '+', '+'));
    assert(/\[full\]/.test(frame), `[full] tag rendered after second +: ${JSON.stringify(frame.slice(-80))}`);
  });
  it('pressing _ shrinks back toward [half]', () => {
    const frame = capture(() => handleKey(model, '_', '_'));
    assert(/\[half\]/.test(frame), `[half] after _: ${JSON.stringify(frame.slice(-80))}`);
  });
});

describe('[3] chrome (sel/focus) flows through the model — live', () => {
  it('down-arrow moves the groups selection via the real key path', () => {
    capture(() => { handleKey(model, '_', '_'); handleKey(model, '_', '_'); });   // back to normal view (silenced)
    getComponentSlice("layout").focus = 'groups';
    setSel('groups', 0);
    const before = capture(() => render());
    // handleKey(model, 'down') → nav_down → moveSel on the focused panel.
    // Phase 4a — cursor lives on the groups Component's slice.nav.groups.
    const after = capture(() => handleKey(model, 'down', 'down'));
    eq(getSel('groups'), 1, 'selection advanced 0 → 1 (chrome read through the model)');
    assert(before !== after, 'the rendered frame changed when the selection moved');
  });
  it('down-arrow cascades currentGroup inline (the selectGroup transform in the reducer)', () => {
    capture(() => { handleKey(model, '_', '_'); handleKey(model, '_', '_'); });
    getComponentSlice("layout").focus = 'groups';
    setSel('groups', 0);
    selectGroup(0);   // anchor currentGroup on the first row
    eq(getModel().currentGroup, 'g1', 'anchored on g1');
    // nav_down → nav_select(groups) → mg.selectGroup runs inline in
    // update (no Cmd): the cursor AND currentGroup advance together.
    capture(() => handleKey(model, 'down', 'down'));
    eq(getModel().currentGroup, 'g2', 'currentGroup cascaded to row 1 via the inline reducer transform');
  });
});

describe('[3b] focus moves through the update spine — live', () => {
  it('right/left arrow re-focus via applyMsg → update(focus_set) and repaint', () => {
    capture(() => { handleKey(model, '_', '_'); handleKey(model, '_', '_'); });   // normal view (silenced)
    getComponentSlice("layout").focus = 'groups';
    const fromGroups = capture(() => handleKey(model, 'right', 'right')); // focus_right → update
    assert(getComponentSlice("layout").focus !== 'groups', `focus advanced off groups (now ${getComponentSlice("layout").focus})`);
    assert(fromGroups.length > 0, 'a frame painted on focus change');
    const movedTo = getComponentSlice("layout").focus;
    capture(() => handleKey(model, 'left', 'left'));                       // focus_left → back
    assert(getComponentSlice("layout").focus === 'groups', `focus_left returned to groups from ${movedTo}`);
  });
});

describe('[4] detail content flows model → view — live', () => {
  it('detail slice lines (now model.viewer.lines) renders into the Detail panel', () => {
    capture(() => { handleKey(model, '_', '_'); handleKey(model, '_', '_'); });  // normal view
    getComponentSlice('detail').lines = ['ZZ-DETAIL-MARKER-ZZ'];
    getComponentSlice('detail').scroll = 0;
    const frame = capture(() => render());
    assert(/ZZ-DETAIL-MARKER-ZZ/.test(frame), 'detail content (via the model) reached the rendered frame');
  });
});

report();
