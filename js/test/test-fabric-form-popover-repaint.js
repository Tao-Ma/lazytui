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

report();
