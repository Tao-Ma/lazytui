/**
 * Smoke — keep-in-view scroll follows the cursor WITHIN one gesture.
 *
 * User-reported 2026-08-05 (demo/postgres, Actions pane): moving the cursor
 * down from the last visible item onto the first item past the fold showed
 * NO highlighted row — and none while continuing to descend. Root cause:
 * the per-keystroke nav path (nav_select → reducer-emitted set_cursor Cmd)
 * rides applyMsg, whose depth-0 exit only ran the after-update finalize when
 * the ARRANGE changed — so the keep-in-view scroll clamp ran one gesture
 * late (on the NEXT key-lane dispatch, reading the previous cursor), leaving
 * the selected row permanently one row below the window while descending.
 * Latent since the finalize/lane split (reproduced on v0.6.12); fixed by a
 * nav-Msg counter gate in loop.applyMsg mirroring its arrange-ref gate.
 *
 * Asserts, on the REAL pipeline: after every cursor move (single steps down
 * past the fold, steps back up above the window, and bottom/top jumps) the
 * frame contains exactly one highlighted row and it is the cursor's row.
 *
 * Run: node js/scripts/run-smoke.js nav-follow   (or directly)
 */
'use strict';

const sm = require('./_helpers/smoke');
const api = sm.api;
const paint = require('../../render/paint');
const { theme } = require('../../leaves/infra/themes');
const { richToAnsi } = require('../../leaves/text/ansi');
const navState = require('../../panel/nav-state');
const { describe, it, assert, eq, report } = require('../test-runner');

if (!api.getComponent('actions')) api.registerComponent(require('../../panel/navigator/actions'));

const N = 25;
const actions = {};
for (let i = 1; i <= N; i++) {
  actions[`a${i}`] = { key: `a${i}`, label: `Action number ${i}`, type: 'run', script: 'true', tab: false };
}
sm.bootFresh({
  groups: {
    g1: { name: 'g1', label: 'G1', containers: [], actions, children: [], parent: null, depth: 0, quick: false },
  },
});
sm.resize(100, 20);                    // actions viewport well below 25 rows
paint.setColorDepth('truecolor');

let actionsPane = null;
for (const col of (api.getInstanceSlice('layout').arrange.columns || [])) {
  for (const p of (col.panels || [])) if (p.type === 'actions') actionsPane = p.paneId;
}
api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: actionsPane }));

const selSgr = richToAnsi(`[${theme().selected}]`);
const selRe = new RegExp(selSgr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\x1b]*', 'g');
const frame = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()).raw; };
const key = (k, seq) => sm.capture(() => sm.handleKey(k, seq || k));

// The one highlighted ACTIONS row in the frame must be the cursor's label.
// (The Groups pane's own selected row isn't focused → renders unhighlighted,
// so the actions cursor is the only selected-tag carrier in this layout.)
function assertCursorVisible(where) {
  const sel = navState.getSel(actionsPane);
  const hits = [...frame().matchAll(selRe)].map((m) => m[0]);
  assert(hits.length >= 1, `${where}: no highlighted row in frame (sel=${sel})`);
  const want = `Action number ${sel + 1}`;
  assert(hits.some((h) => h.includes(want)),
    `${where}: highlighted row is not the cursor's (want "${want}", got ${JSON.stringify(hits.map(h => h.slice(selSgr.length, selSgr.length + 24)))})`);
}

describe('[1] descending past the fold keeps the cursor visible every step', () => {
  it('all the way to the bottom', () => {
    for (let step = 1; step < N; step++) {
      key('j');
      assertCursorVisible(`down step ${step}`);
    }
    eq(navState.getSel(actionsPane), N - 1, 'cursor reached the last item');
    assert(navState.getScroll(actionsPane) > 0, 'view scrolled');
  });
});

describe('[2] ascending back above the window keeps the cursor visible', () => {
  it('all the way to the top', () => {
    for (let step = 1; step < N; step++) {
      key('k');
      assertCursorVisible(`up step ${step}`);
    }
    eq(navState.getSel(actionsPane), 0, 'cursor back at the first item');
    eq(navState.getScroll(actionsPane), 0, 'view scrolled back to the top');
  });
});

describe('[3] jumps land clamped in the SAME gesture', () => {
  // Drive the verbs through handleAction (the keymap that binds </> to them
  // loads at tui boot, not in this harness; handleAction is the same entry).
  const { handleAction } = require('../../dispatch/control/dispatch');
  it('goto bottom', () => {
    sm.capture(() => handleAction('goto_bottom'));
    eq(navState.getSel(actionsPane), N - 1, 'cursor at bottom');
    assertCursorVisible('after goto_bottom');
  });
  it('goto top', () => {
    sm.capture(() => handleAction('goto_top'));
    eq(navState.getSel(actionsPane), 0, 'cursor at top');
    eq(navState.getScroll(actionsPane), 0, 'scroll followed up in one gesture');
    assertCursorVisible('after goto_top');
  });
});

report();
