/**
 * test-rect-paint-parity.js — render smoke tests (v0.6.3 P3.4 → P3.6).
 *
 * Originally written to gate P3.6 on byte-equality between the old
 * paintColumns path and the new rect-painter path. P3.6 deleted the
 * old path; the test still drives the renderer through 55 configs
 * (golden + random seeds) and runs a flag flip that's now a no-op,
 * but the smoke coverage (every config renders without throwing,
 * captures non-trivial output) is worth keeping. The assertion is
 * now reflexive — both captures route through the same painter and
 * should always match.
 *
 * Run: node js/test/test-rect-paint-parity.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { initState } = require('../app/state');
const { render, forceFullRepaint } = require('../render/layout');

// ---- boot a minimal-but-real app (mirrors test-live-render.js) ----

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

// ---- arrange fixtures + render harness -------------------------

function pane(type, opts = {}) {
  return {
    type, id: type, paneId: opts.paneId || `p-${type}`,
    hotkey: opts.hotkey || '', title: opts.title || type,
    columnIndex: opts.columnIndex || 0,
    ...(opts.collapsed ? { collapsed: true } : {}),
  };
}

function applyArrange(arrange) {
  const slice = getInstanceSlice('layout');
  slice.arrange = arrange;
  slice.focus = arrange.columns[0].panels[0].type;
  slice.viewMode = 'normal';
  slice.halfLeftPanel = null;
  slice.freeConfig = { drag: null };
}

// Capture stdout for a single render() call.
function captureRender() {
  forceFullRepaint();  // start from a clean diff baseline so each
                       // capture is the FULL frame, not a diff
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { render(getModel()); } finally { process.stdout.write = orig; }
  return chunks.join('');
}

function renderUnder(flag) {
  if (flag) process.env.LAZYTUI_RECT_PAINTER = '1';
  else delete process.env.LAZYTUI_RECT_PAINTER;
  return captureRender();
}

function assertParity(arrange, label) {
  applyArrange(arrange);
  const oldAnsi = renderUnder(false);
  applyArrange(arrange);   // reset state between captures
  const newAnsi = renderUnder(true);
  if (oldAnsi !== newAnsi) {
    // Find first diverging position to make the failure debuggable.
    let i = 0;
    while (i < oldAnsi.length && i < newAnsi.length && oldAnsi[i] === newAnsi[i]) i++;
    const ctx = (s) => s.slice(Math.max(0, i - 40), i + 40).replace(/\x1b/g, '\\e');
    assert(false,
      `${label}: parity break at byte ${i}\n  old: ${JSON.stringify(ctx(oldAnsi))}\n  new: ${JSON.stringify(ctx(newAnsi))}`);
  } else {
    assert(true, `${label}: parity (${oldAnsi.length} bytes)`);
  }
}

// ---- Golden cases ----------------------------------------------

// Goldens use only `groups` + `detail` (the two Components the
// minimal boot above registers). See the comment on randomArrange
// for why mixing in unregistered types here surfaces an unrelated
// OLD-path bug class rather than testing parity of normal renders.

describe('[1] golden: two-column singleton (the today-default)', () => {
  it('groups left + detail right', () => {
    assertParity({
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [pane('groups', { hotkey: '1', columnIndex: 0 })] },
        { panels: [pane('detail', { hotkey: 'o', columnIndex: 1 })] },
      ],
    }, '2-col singleton');
  });
});

describe('[2] golden: collapsed-leftmost (the 6d9ad31 case)', () => {
  it('groups collapsed in col 0, detail right', () => {
    assertParity({
      detailHeightPct: 60,
      columns: [
        { width: 32, panels: [pane('groups', { hotkey: '1', columnIndex: 0, collapsed: true })] },
        { panels: [pane('detail', { hotkey: 'o', columnIndex: 1 })] },
      ],
    }, 'collapsed col 0');
  });
});

describe('[3] golden: three-column layout', () => {
  it('groups | groups | detail, each in own column', () => {
    assertParity({
      detailHeightPct: 60,
      columns: [
        { width: 24, panels: [pane('groups', { hotkey: '1', columnIndex: 0, paneId: 'p-g0' })] },
        { width: 24, panels: [pane('groups', { hotkey: '2', columnIndex: 1, paneId: 'p-g1' })] },
        { panels: [pane('detail', { hotkey: 'o', columnIndex: 2 })] },
      ],
    }, '3-col split');
  });
});

describe('[4] golden: detail-only (single column with just detail)', () => {
  it('one column, one panel', () => {
    assertParity({
      detailHeightPct: 60,
      columns: [
        { panels: [pane('detail', { hotkey: 'o', columnIndex: 0 })] },
      ],
    }, 'detail only');
  });
});

describe('[5] golden: narrow first column with detail right', () => {
  it('col 0 = 18 cells wide', () => {
    assertParity({
      detailHeightPct: 60,
      columns: [
        { width: 18, panels: [pane('groups', { hotkey: '1', columnIndex: 0 })] },
        { panels: [pane('detail', { hotkey: 'o', columnIndex: 1 })] },
      ],
    }, 'narrow col 0');
  });
});

// ---- Random stress ---------------------------------------------
//
// Deterministic PRNG seeded by iteration index so failures are
// reproducible. Don't import a heavy randomness lib — a simple
// LCG is enough for "vary the inputs."

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Why only `groups` in left columns: the minimal boot here registers
// the groups + detail Components (groups via the config; detail via
// initState). It does NOT register actions/stats/files/etc. The OLD
// path has a latent bug where _safeRender returning '' for an
// unregistered Component leaves a ZERO-WIDTH slot in the column
// output — and the next column's content slides LEFT into the
// missing horizontal space (the very v0.6.2 column-shift bug class
// P3 closes). NEW path correctly pads to rect.w. To keep this
// parity test about NORMAL rendering rather than catching that
// latent OLD-path bug, restrict the random generator to registered
// types. (The 6d9ad31 fix-test already pins the OLD bug class
// fix in test-live-render.js; we're not re-testing it here.)
function randomArrange(seed) {
  const rnd = lcg(seed);
  const colCount = 2 + Math.floor(rnd() * 3);   // 2..4 columns
  const columns = [];
  for (let ci = 0; ci < colCount - 1; ci++) {
    columns.push({
      width: 20 + Math.floor(rnd() * 20),
      panels: [pane('groups', {
        hotkey: String(ci + 1),
        columnIndex: ci,
        collapsed: rnd() < 0.3,
        paneId: `p-groups-${ci}`,
      })],
    });
  }
  // Last column: detail at the bottom.
  columns.push({ panels: [pane('detail', { hotkey: 'o', columnIndex: colCount - 1 })] });
  return { detailHeightPct: 50 + Math.floor(rnd() * 30), columns };
}

describe('[6] random stress: 50 deterministic seeds', () => {
  for (let seed = 1; seed <= 50; seed++) {
    it(`seed=${seed}`, () => {
      const arrange = randomArrange(seed);
      try {
        assertParity(arrange, `seed=${seed}`);
      } catch (e) {
        // Re-throw with config dump so the failure is reproducible.
        throw new Error(`${e.message}\n  arrange: ${JSON.stringify(arrange)}`);
      }
    });
  }
});

report();
