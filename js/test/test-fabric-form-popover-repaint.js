/**
 * Regression: closing (or shrinking) the fabric-form choices popover must
 * clear the outgoing LARGER overlay border's cells.
 *
 * Pre-overlay-compositor-migration this invariant was held by paint.js's
 * `prevFabricPickingSig` sig tracker — the fabric-form overlay stayed open
 * (fabricFormMode remained true) while the popover opened/closed INSIDE
 * it; the mode-flag drop check in paint.js couldn't catch the shape
 * change, so a per-frame signature of (picking port + items count)
 * forced a whole-screen repaint on any transition. User-caught v0.6.38.
 *
 * Post-migration (overlay-compositor Release 2 Phase 2.c #1): the form
 * composites into newRows, so cell-diff emits per-cell writes for the
 * vacated popover rows on close / items-count-change. The sig tracker
 * is retired; THIS test's assertions are inverted — pre-migration
 * asserted `FULL_CLEAR` fires on shrink, post-migration asserts it
 * does NOT fire (the mechanism this file pins is now cell-diff).
 *
 * Run: node js/test/test-fabric-form-popover-repaint.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');

const FULL_CLEAR = '\x1b[2J';   // painter.paintFrame's full-repaint marker

describe('[fabric-form-popover-repaint] close/shrink does NOT force a full repaint (compositor path)', () => {
  sm.bootFresh({ groups: { g: {
    name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
    actions: {}
  } } });
  sm.resize(100, 30);

  // Open a 1-field + choices_cmd form directly via fabric_form_enter so this
  // test doesn't need to drive the Actions pane. The field carries a
  // choicesCmd so the popover is reachable.
  const PENDING = { actionKey: 'pick',
    action: { label: 'Pick item', type: 'run', script: 'echo "$name"',
      ports: { in: { name: { type: 'string', required: true,
                             choices_cmd: "printf 'alpha\\nbravo\\ncharlie\\n'" } } } } };
  const fields = [
    { port: 'name', text: '', required: true, default: null, desc: 'name',
      choicesCmd: "printf 'alpha\\nbravo\\ncharlie\\n'",
      choicesLabeled: false, choicesTimeout: null, dependsOn: [] },
  ];

  sm.applyMsg({ type: 'fabric_form_enter', fields, pendingAction: PENDING });
  // Resolve the fetch directly so we have a known items count and reach
  // steady state without waiting on a spawn.
  sm.applyMsg({ type: 'fabric_form_choices_request', port: 'name', requestId: 1 });
  sm.applyMsg({
    type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 1,
    items: ['alpha', 'bravo', 'charlie'], labels: null, error: null,
  });

  // Reach steady state: initial frames clear/paint; a no-op render after
  // should be diff-only.
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the popover does NOT force full (overlay grows → compositor paints new region via cell-diff)', () => {
    sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'popover open → overlay grows → cell-diff emits per-cell writes for the new popover rows; no need for force-full');
  });

  it('a no-op re-render while popover stays open is diff-only (no force)', () => {
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'steady state while picker is open must stay diff-only, got a full clear');
  });

  it('closing the popover does NOT force full — cell-diff clears the vacated popover rows (Phase 2.c #1 inverted)', () => {
    sm.applyMsg({ type: 'fabric_form_choices_close' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'popover close emitted a full-clear — the compositor path (prevFabricPickingSig retired, form composites into newRows) promises cell-diff clears the vacated popover rows from the natural row delta');
  });

  it('a resolver reply that CHANGES items count while popover is open does NOT force full either (Phase 2.c #1 inverted)', () => {
    // Reopen the popover and bump the request so the next resolver reply's
    // requestId matches (fabric-form.js drops stale replies). The
    // popover's shrink/grow mid-flight is the same residue-risk shape as
    // close — pre-migration it tripped `prevFabricPickingSig`.
    sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' });
    sm.applyMsg({ type: 'fabric_form_choices_request', port: 'name', requestId: 2 });
    sm.capture(sm.render);                   // reach steady state at count=3 → pending re-render
    sm.applyMsg({
      type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 2,
      items: ['x'], labels: null, error: null,
    });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'items count change (3 → 1) emitted a full-clear — the compositor path handles the overlay shrink via cell-diff from the natural row delta');
  });
});

// -------------------------------------------------------------------------
// The shared `assertOverlayShrinkForcesRepaint` harness retired with
// Phase 2.c #1 — every overlay in the regression suite has migrated to
// the compositor path. The residue-risk discipline for a NEW variable-
// size overlay is now:
//   1. Thread (newRows, cols) through renderOverlay in the overlay fn.
//   2. Add paint.js's `md.XxxMode → renderXxx(newRows, COLS)` call to
//      the pre-paintFrame composite block.
//   3. Add a no-FULL_CLEAR assertion to the overlay's companion
//      composite test — see test-action-palette-overlay-composite.js
//      and test-fabric-form-overlay-composite.js for the shape.
// A sig tracker in paint.js is NO LONGER an acceptable fix.
// -------------------------------------------------------------------------

describe('[overlay-shrink-invariant] migrated overlays stay shrink-safe via cell-diff', () => {
  it('action palette: filter narrows → cell-diff clears vacated cells WITHOUT a full-clear (Phase 2.b #1 inverted)', () => {
    // Overlay-compositor Release 2 Phase 2.b #1 migrated the action
    // palette into newRows and retired `prevPaletteSig`. This is the
    // original inversion from the Phase 2.b #1 commit (04701dba);
    // preserved here because it exercises a different shrink shape
    // (filter mutation) than the fabric-form popover tests above.
    sm.applyMsg({ type: 'fabric_form_cancel' });
    sm.capture(sm.render);              // settle after close
    sm.applyMsg({ type: 'palette_open' });
    sm.capture(sm.render);              // settle at grown state
    sm.capture(sm.render);
    sm.applyMsg({ type: 'palette_filter', seq: 'z' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'palette filter mutation emitted a full-clear — the compositor path promises cell-diff clears the vacated rect from the natural row delta');
  });
});

report();
