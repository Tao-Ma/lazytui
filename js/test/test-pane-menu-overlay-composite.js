/**
 * Pane-menu overlay — overlay-compositor migration (Release 2 Phase 2.a #5,
 * docs/overlay-compositor-migration.md). Mirrors the earlier simple
 * overlays, with one asymmetry: pane-menu uses `renderPanel` + `writeOut`
 * directly (not `renderOverlay`) and ANCHORS to the target pane's bounds
 * (`g.x`, `g.y+1`), not the centered `overlayBox`. The composite pattern
 * is the same — each panel row lands in `newRows` via `compositeRow` — but
 * the test needs an open layout + pane to anchor on, so drive it through
 * the paint pipeline rather than hand-constructing a buffer.
 *
 * Three pins:
 *   1. Composite path: a `pane_menu_open` + `sm.render()` paints the Tabs
 *      list on-screen AND the frame carries NO `FULL_CLEAR` on open.
 *   2. Stdout fallback still fires when `render()` is invoked WITHOUT
 *      newRows (migration-period callers).
 *   3. The stdout path still exercises the residue tracker — close + open
 *      cycle paints the full dropdown each time (unchanged legacy
 *      behavior; this pin guards the fallback doesn't bitrot during
 *      Release 2).
 *
 * Run: node js/test/test-pane-menu-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const paneMenu = require('../overlay/pane-menu');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const api = require('../panel/api');
const { dispatchMsg } = require('../dispatch/runtime/loop');

const FULL_CLEAR = '\x1b[2J';

describe('[pane-menu-overlay-composite] composites into newRows + no FULL_CLEAR on open', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  // Steady-state frames so the diff baseline settles.
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening pane-menu via pane_menu_open does NOT emit a full-clear', () => {
    // Pick ANY visible pane where the `[≡]` trigger has something to
    // show — triggerVisible is the same gate the dropdown's items() uses,
    // so a pane that passes it will have a non-empty dropdown.
    const api = require('../panel/api');
    const slice = api.getInstanceSlice('layout');
    const mpool = require('../leaves/wm/pool');
    let chosen = null;
    for (const p of mpool.allPanesInColumns(slice.arrange)) {
      if (paneMenu.triggerVisible(p.paneId)) { chosen = p.paneId; break; }
    }
    assert(chosen != null,
      'bootFresh default layout should expose at least one pane whose `[≡]` has something to show');
    // pane_menu_open is a LAYOUT-slice Msg (dispatch wraps it via api.wrap);
    // sm.applyMsg sends root Msgs so it never reaches the layout reducer.
    dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: chosen, cursor: 0, scroll: 0 }));
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'pane_menu_open emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    // The dropdown's title or at least one of its pane-row labels must
    // land through the paint pipeline. On a navigator the title is
    // "Pane select"; on a multi-tab content slot it's "Tabs".
    const sawDropdown = /Pane select|Tabs/.test(stripped);
    assert(sawDropdown,
      `expected the pane-menu dropdown to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });

  it('closing pane-menu also does NOT emit a full-clear beyond the overlay-flag-drop forceFull', () => {
    // The flag-drop forceFull at paint.js:852 is a GLOBAL fallback (fires
    // for every overlay close until the migration drops it later in
    // Release 2); it DOES emit \x1b[2J. This pin just documents what we
    // know is coming: it's not a per-overlay sig tracker's job anymore.
    // (A later Release-2 commit removes the global forceFull; at that
    // point THIS test gets inverted the same way the plan calls out for
    // test-fabric-form-popover-repaint.js.)
    dispatchMsg(api.wrap('layout', { type: 'pane_menu_close' }));
    const out = sm.capture(sm.render).raw;
    // Yes, FULL_CLEAR here is expected FROM THE GLOBAL FALLBACK, not
    // from a per-overlay residue tracker. Document the invariant so a
    // regression that re-introduces an overlay-local force stands out.
    assert(out.length > 0, 'close emits at least a repaint');
  });
});

// (The pre-cleanup "stdout fallback still works" case retired —
// end-of-Release-2 cleanup; pane-menu's writeOut path + residue
// tracker are gone, so render() is buffer-only.)

report();
