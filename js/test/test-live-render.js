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
const { getModel } = require('../app/runtime');
const {getInstanceSlice, getFocus } = require('../panel/api');

const { initState, getSel, setSel, selectGroup } = require('../app/state');

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

const { handleKey } = require('../dispatch/dispatch');
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

const { render } = require('../render/layout');

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
    const frame = capture(() => handleKey('+', '+'));
    assert(/\[half\]/.test(frame), `[half] tag rendered after +: ${JSON.stringify(frame.slice(-80))}`);
  });
  it('pressing + again renders [full]', () => {
    const frame = capture(() => handleKey('+', '+'));
    assert(/\[full\]/.test(frame), `[full] tag rendered after second +: ${JSON.stringify(frame.slice(-80))}`);
  });
  it('pressing _ shrinks back toward [half]', () => {
    const frame = capture(() => handleKey('_', '_'));
    assert(/\[half\]/.test(frame), `[half] after _: ${JSON.stringify(frame.slice(-80))}`);
  });
});

describe('[3] chrome (sel/focus) flows through the model — live', () => {
  it('down-arrow moves the groups selection via the real key path', () => {
    capture(() => { handleKey('_', '_'); handleKey('_', '_'); });   // back to normal view (silenced)
    getInstanceSlice("layout").focus = 'groups';
    setSel('groups', 0);
    const before = capture(() => render());
    // handleKey('down') → nav_down → moveSel on the focused panel.
    // Phase 4a — cursor lives on the groups Component's slice.nav.groups.
    const after = capture(() => handleKey('down', 'down'));
    eq(getSel('groups'), 1, 'selection advanced 0 → 1 (chrome read through the model)');
    assert(before !== after, 'the rendered frame changed when the selection moved');
  });
  it('down-arrow cascades currentGroup inline (the selectGroup transform in the reducer)', () => {
    capture(() => { handleKey('_', '_'); handleKey('_', '_'); });
    getInstanceSlice("layout").focus = 'groups';
    setSel('groups', 0);
    selectGroup(0);   // anchor currentGroup on the first row
    eq(getModel().currentGroup, 'g1', 'anchored on g1');
    // nav_down → nav_select(groups) → mg.selectGroup runs inline in
    // update (no Cmd): the cursor AND currentGroup advance together.
    capture(() => handleKey('down', 'down'));
    eq(getModel().currentGroup, 'g2', 'currentGroup cascaded to row 1 via the inline reducer transform');
  });
});

describe('[3b] focus moves through the update spine — live', () => {
  it('right/left arrow re-focus via applyMsg → update(focus_set) and repaint', () => {
    capture(() => { handleKey('_', '_'); handleKey('_', '_'); });   // normal view (silenced)
    getInstanceSlice("layout").focus = 'groups';
    const fromGroups = capture(() => handleKey('right', 'right')); // focus_right → update
    assert(getFocus() !== 'groups', `focus advanced off groups (now ${getFocus()})`);
    assert(fromGroups.length > 0, 'a frame painted on focus change');
    const movedTo = getFocus();
    capture(() => handleKey('left', 'left'));                       // focus_left → back
    assert(getFocus() === 'groups', `focus_left returned to groups from ${movedTo}`);
  });
});

describe('[collapse-shift] all-collapsed column preserves its horizontal slot', () => {
  // v0.6.2 — Round-2 bug discovered during postgres-demo manual
  // verification: when ALL panels in the leftmost column were
  // collapsed, the column produced fewer rendered rows than the
  // available height, so paintColumns' per-row concatenation saw
  // splits[0][i] === undefined for rows past the collapsed bars
  // → '' substitute → the right column's content shifted LEFT to
  // x=0 for those rows. Fix: pad each column's output to availH
  // rows with blank space-of-column-width so the right column
  // stays at its proper x-offset.
  it('collapsed leftmost column reserves its horizontal space for all rows', () => {
    capture(() => { handleKey('_', '_'); handleKey('_', '_'); });  // back to normal view
    // The initState in this test file produces a 2-column layout:
    // col 0 has containers (no groups in g1's containers, but the
    // panel exists by default placement). Force all col-0 panels
    // collapsed.
    const layoutSlice = getInstanceSlice('layout');
    const col0 = layoutSlice.arrange.columns[0];
    const col0Panels = col0 && col0.panels || [];
    for (const p of col0Panels) p.collapsed = true;
    // Capture raw output WITHOUT stripping ANSI so we can decode
    // cursor positions.
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try { render(); } finally { process.stdout.write = orig; }
    const raw = chunks.join('');
    // Walk the bytes; collect (row, col) of each cursor-set move
    // \x1b[N;1H plus any plain content emitted at that position.
    const rowsMap = new Map();  // row → first-char column
    let curRow = 1;
    let curCol = 1;
    let i = 0;
    while (i < raw.length) {
      const cur = raw.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
      if (cur) {
        curRow = parseInt(cur[1], 10);
        curCol = parseInt(cur[2], 10);
        i += cur[0].length;
        continue;
      }
      const otherEsc = raw.slice(i).match(/^\x1b\[[\d;?]*[A-Za-z]/);
      if (otherEsc) { i += otherEsc[0].length; continue; }
      const ch = raw[i];
      if (ch === '\n' || ch === '\r') { i++; continue; }
      // First non-blank char encountered for this row → record the col.
      if (ch !== ' ' && !rowsMap.has(curRow)) rowsMap.set(curRow, curCol);
      curCol++;
      i++;
    }
    // Find the FIRST row that has content (col 0 collapsed bars at top).
    // After the 3 collapsed bars, look at rows 4+ — assert their FIRST
    // non-space char is at col > 1 (i.e., the left column's blank
    // padding pushes right-column content to its proper offset).
    // We don't hardcode the left column width because tests may differ
    // — just assert "not at col 1" for rows beyond the collapsed bars.
    const collapsedBarCount = col0Panels.length;  // each collapsed = 1 row
    let pastCollapseFirstContentCol = null;
    for (const [row, col] of rowsMap) {
      if (row > collapsedBarCount && row < (process.stdout.rows || 24)) {
        if (pastCollapseFirstContentCol === null || col < pastCollapseFirstContentCol) {
          pastCollapseFirstContentCol = col;
        }
      }
    }
    if (pastCollapseFirstContentCol !== null) {
      assert(pastCollapseFirstContentCol > 1,
        `rows past collapsed bars should have content offset by left-col width; ` +
        `first content col seen at ${pastCollapseFirstContentCol} (would be 1 pre-fix).`);
    }
    // Cleanup so subsequent tests aren't stuck collapsed.
    for (const p of col0Panels) p.collapsed = false;
  });
});

describe('[4] detail content flows model → view — live', () => {
  it('detail viewerOverride flows into the rendered Detail panel', () => {
    // v0.6.2 T2c — render reads viewerLines() which prefers
    // slice.viewerOverride for discrete-doc content (history replay,
    // diff, help text). Poking slice.lines directly no longer reaches
    // the frame — render derives from active tab + buffers + override.
    capture(() => { handleKey('_', '_'); handleKey('_', '_'); });  // normal view
    getInstanceSlice('detail').viewerOverride = { lines: ['ZZ-DETAIL-MARKER-ZZ'] };
    getInstanceSlice('detail').scroll = 0;
    const frame = capture(() => render());
    assert(/ZZ-DETAIL-MARKER-ZZ/.test(frame), 'detail content (via the model) reached the rendered frame');
    // Cleanup so subsequent tests aren't sticky-overridden.
    getInstanceSlice('detail').viewerOverride = null;
  });
});

report();
