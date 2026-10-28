/**
 * Regression: closing (or shrinking) the fabric-form choices popover must
 * force a full repaint so the outgoing LARGER overlay border's cells get
 * cleared.
 *
 * The fabric-form overlay stays open (fabricFormMode remains true) while the
 * popover opens/closes INSIDE it — the mode-flag drop check in paint.js
 * can't catch it. Items are rendered as rows while picking is active, so
 * opening the popover grows the overlay (menuH scales with rows.length) and
 * closing it shrinks the overlay back. The cell-diff cache keeps the
 * outgoing larger border's cells, so after close the OLD border visibly
 * lingers around the new smaller overlay. User-caught v0.6.38.
 *
 * Fix: paint.js tracks a per-frame signature of the picker state (port +
 * items count); any transition forces a full repaint on the next render.
 * Mirrors the menu-items-replaced-in-place force trigger (same reason:
 * mode stays set while the overlay's contents change).
 *
 * Run: node js/test/test-fabric-form-popover-repaint.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');

const FULL_CLEAR = '\x1b[2J';   // painter.paintFrame's full-repaint marker

describe('[fabric-form-popover-repaint] close/shrink forces a full repaint', () => {
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

  it('opening the popover does NOT force full (overlay grows → new region paints cleanly over existing)', () => {
    sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'popover open → overlay grows → the enlarged render covers everything within the new border; no need for force-full (would waste a frame on every open)');
  });

  it('a no-op re-render while popover stays open is diff-only (no force)', () => {
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'steady state while picker is open must stay diff-only, got a full clear');
  });

  it('closing the popover forces a full repaint (overlay shrinks: items dropped)', () => {
    sm.applyMsg({ type: 'fabric_form_choices_close' });
    const out = sm.capture(sm.render).raw;
    assert(out.includes(FULL_CLEAR),
      'popover close → overlay shrinks → MUST force-full to clear the larger outgoing border (user-reported bug)');
  });

  it('a resolver reply that CHANGES items count while popover is open forces a full repaint', () => {
    // Reopen the popover and bump the request so the next resolver reply's
    // requestId matches (fabric-form.js:559 drops stale replies). The
    // popover's shrink/grow mid-flight has the same residue risk as close.
    sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' });
    sm.applyMsg({ type: 'fabric_form_choices_request', port: 'name', requestId: 2 });
    sm.capture(sm.render);                   // reach steady state at count=3 → pending re-render
    sm.applyMsg({
      type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 2,
      items: ['x'], labels: null, error: null,
    });
    const out = sm.capture(sm.render).raw;
    assert(out.includes(FULL_CLEAR),
      'items count change (3 → 1) → overlay shrinks → must force-full');
  });
});

// -------------------------------------------------------------------------
// Reusable harness: `assertOverlayShrinkForcesRepaint` — PRE-COMPOSITOR
// INVARIANT. Only still exercised by the fabric-form choices popover
// below, which hasn't migrated yet (Phase 2.c). Callers for already-
// migrated overlays have been inverted inline — see the "action palette"
// it block above, which asserts NO FULL_CLEAR per the compositor
// migration (docs/overlay-compositor-migration.md). This harness retires
// in full once the fabric-form popover migrates.
//
// Why a MECHANISM test (FULL_CLEAR), not a SYMPTOM test (visible residue
// in a captured frame): the test harness captures per-render stdout
// deltas, not accumulated terminal state. In the real terminal, residue
// happens because the shrink delta doesn't emit "clear these cells"
// instructions — the terminal still shows the old overlay cells from
// previous frames. A test that captures just one render's output can't
// catch this because the "residue" lives in the terminal's retained
// state, not in the delta. Catching it would require a terminal-state
// emulator (significant investment). The pre-compositor mechanism was
// force-full-repaint on shrink; post-compositor it's cell-diff emitting
// per-cell writes for the vacated rect — the inverted assertion checks
// no FULL_CLEAR AND lets the surrounding frames paint via diff.
// -------------------------------------------------------------------------

function assertOverlayShrinkForcesRepaint({ overlayName, grow, shrink }) {
  // Capture at steady state after the grow stimulus so the "before"
  // reference is a stable larger overlay.
  grow();
  sm.capture(sm.render);                              // paint the grown state
  sm.capture(sm.render);                              // and reach diff-steady

  shrink();
  const out = sm.capture(sm.render).raw;
  assert(out.includes(FULL_CLEAR),
    `RESIDUE RISK for ${overlayName}: shrink/close did NOT emit a full-repaint. This overlay is still on the PRE-COMPOSITOR path (not yet migrated — see docs/overlay-compositor-migration.md). Without the force the outgoing LARGER overlay's cells linger in the terminal because the overlay bypasses newRows. The fix once this overlay migrates is to composite into newRows (overlay-compositor Release 2); until then, the sig tracker in paint.js that force-fulls on shrink is the mechanism. The last remaining sig tracker is 'prevFabricPickingSig' (Phase 2.c target).`);
}

describe('[overlay-shrink-invariant] generic harness pins each variable-size overlay', () => {
  // Reset state for a clean harness run (previous describe block mutated it).
  sm.applyMsg({ type: 'fabric_form_choices_close' });
  sm.applyMsg({ type: 'fabric_form_choices_request', port: 'name', requestId: 100 });
  sm.applyMsg({
    type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 100,
    items: ['alpha', 'bravo', 'charlie'], labels: null, error: null,
  });
  sm.capture(sm.render);                       // settle

  it('fabric-form choices popover: close forces repaint', () => {
    assertOverlayShrinkForcesRepaint({
      overlayName: 'fabric-form choices popover',
      grow: () => sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' }),
      shrink: () => sm.applyMsg({ type: 'fabric_form_choices_close' }),
    });
  });

  it('action palette: filter narrows → cell-diff clears vacated cells WITHOUT a full-clear (v0.6.49 → Phase 2.b inverted)', () => {
    // Overlay-compositor Release 2 Phase 2.b #1 migrated the action
    // palette into newRows and retired `prevPaletteSig`. The pre-
    // migration assertion was that the sig tracker forces a full-clear
    // on shrink; the plan calls out this invariant inversion as the
    // mechanism-level pin that proves the compositor path works
    // (docs/overlay-compositor-migration.md §Release 2 — Test strategy).
    //
    // Direction inverted; the describe/it labels stay to preserve
    // continuity in the regression history (same purpose, new mechanism).
    sm.applyMsg({ type: 'fabric_form_cancel' });
    sm.capture(sm.render);              // settle after close
    sm.applyMsg({ type: 'palette_open' });
    sm.capture(sm.render);              // settle at grown state
    sm.capture(sm.render);
    sm.applyMsg({ type: 'palette_filter', seq: 'z' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'palette filter mutation emitted a full-clear — the compositor path (prevPaletteSig retired, overlay composites into newRows) promises cell-diff clears the vacated rect from the natural row delta');
  });

  // Future variable-size overlays — if any — go here. Each new overlay
  // that adopts the compositor path (overlay-compositor Release 2
  // onwards) is shrink-safe BY CONSTRUCTION: cell-diff emits per-cell
  // writes for the vacated rect from the natural newRows delta. The
  // residue-risk discipline shifts from "add a sig tracker to paint.js"
  // to "thread newRows+cols through renderOverlay"; the companion test
  // for a new overlay is a no-FULL_CLEAR-on-shrink assertion (see
  // test-action-palette-overlay-composite.js for the shape).
});

report();
