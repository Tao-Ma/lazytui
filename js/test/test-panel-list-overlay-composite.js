/**
 * Panel-list overlay — overlay-compositor migration (Release 2 Phase 2.a #6,
 * docs/overlay-compositor-migration.md). This commit is the first in the
 * arc where the migration DIRECTLY REMOVES explicit `force_full_repaint`
 * Cmds — three sites in `js/panel/layout.js` (panel_list_open,
 * panel_list_close, panel_list_pick) plus the auto-open conditional on
 * `free_config_enter`. Those were Class-A workarounds for the overlay
 * bypassing newRows; with the composite path cell-diff emits per-cell
 * writes for the overlay rect on both open AND close transitions, so the
 * force is retired.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. Neither `panel_list_open` nor `panel_list_close` emits a
 *      `\x1b[2J` (FULL_CLEAR) when driven through sm.render — this is
 *      the first Phase 2.a test that pins the CLOSE direction too
 *      (previous overlays could only pin OPEN because the global
 *      overlay-flag-drop forceFull at paint.js:852 still fires on
 *      mode-flag drop; panel-list doesn't flip a mode flag, so the
 *      flag-drop forcer is bypassed and the close transition genuinely
 *      rides on cell-diff).
 *
 * Run: node js/test/test-panel-list-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderPanelListOverlay } = require('../overlay/panel-list');
const { visibleLen } = require('../leaves/text/ansi');
const api = require('../panel/api');
const { dispatchMsg } = require('../dispatch/runtime/loop');

const FULL_CLEAR = '\x1b[2J';

describe('[panel-list-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    freshOverlayModel({ cols: COLS, rows: 30 });
    // The overlay reads slice.panelList.open; drive it live through the
    // same layout-wrapped Msg path dispatch uses in production.
    dispatchMsg(api.wrap('layout', { type: 'panel_list_open', cursor: 0 }));
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderPanelListOverlay(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Panels'),
      `expected title "Panels" to land in newRows`);
    // At least one of the list's header labels makes it in — the title
    // row carries "id    type    title".
    assert(/id\s+type\s+title/.test(joined),
      `expected list header to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
    // Close the overlay so the next describe starts clean.
    dispatchMsg(api.wrap('layout', { type: 'panel_list_close' }));
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[panel-list-overlay-composite] no FULL_CLEAR on open/close through the paint pipeline', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the panel-list overlay does NOT emit a full-clear', () => {
    dispatchMsg(api.wrap('layout', { type: 'free_config_enter' }));
    dispatchMsg(api.wrap('layout', { type: 'panel_list_open', cursor: 0 }));
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'panel_list_open emitted a full-clear — the migration drops `force_full_repaint` from panel_list_open; cell-diff must handle the open transition from the natural row delta');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Panels'),
      `expected the Panels overlay title to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 160))}`);
  });

  it('closing the panel-list overlay (via panel_list_close) does NOT emit a full-clear either', () => {
    // Overlay is open from the previous step. Close it and capture.
    dispatchMsg(api.wrap('layout', { type: 'panel_list_close' }));
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'panel_list_close emitted a full-clear — the migration drops `force_full_repaint` from panel_list_close; cell-diff must clear the vacated overlay rect from the natural row delta');
  });
});

report();
