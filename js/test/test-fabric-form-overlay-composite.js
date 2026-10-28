/**
 * Fabric-form overlay — overlay-compositor migration (Release 2
 * Phase 2.c #1, docs/overlay-compositor-migration.md). The complex
 * tier's pacing item.
 *
 * Resolves the plan's §Open question #1: the choices POPOVER is
 * self-contained inside the form's single `renderOverlay` call (its
 * rows are inlined into the main `rows[]` array), so no sub-overlay
 * rect protocol is needed — the compositor sees popover rows as just
 * more form rows to paint.
 *
 * Four pins:
 *   1. Composite path mutates `targetRows` with the form rows.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `fabric_form_enter` through the real paint
 *      pipeline.
 *   4. No `FULL_CLEAR` on `fabric_form_choices_close` — the exact
 *      transition the retired `prevFabricPickingSig` sig tracker caught.
 *
 * Run: node js/test/test-fabric-form-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

// Shared fixture — a 1-field form reachable without walking the Actions
// pane. The port carries a choicesCmd so the popover is reachable.
const PENDING = { actionKey: 'pick',
  action: { label: 'Pick item', type: 'run', script: 'echo "$name"',
    ports: { in: { name: { type: 'string', required: true,
                           choices_cmd: "printf 'alpha\\nbravo\\ncharlie\\n'" } } } } };
const FIELDS = [
  { port: 'name', text: '', required: true, default: null, desc: 'name',
    choicesCmd: "printf 'alpha\\nbravo\\ncharlie\\n'",
    choicesLabeled: false, choicesTimeout: null, dependsOn: [] },
];

describe('[fabric-form-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(COLS, 30);
    sm.applyMsg({ type: 'fabric_form_enter', fields: FIELDS, pendingAction: PENDING });

    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderFabricFormOverlay(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Pick item'),
      `expected form title "Pick item" to land in newRows`);
    assert(/name/.test(joined),
      `expected field "name" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[fabric-form-overlay-composite] no FULL_CLEAR on open / popover close through the paint pipeline', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the fabric-form overlay does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'fabric_form_enter', fields: FIELDS, pendingAction: PENDING });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'fabric_form_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(/Pick item/.test(stripped),
      `expected the form title to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });

  it('closing the choices popover does NOT emit a full-clear — the retired prevFabricPickingSig territory', () => {
    // Open the popover (grow the overlay). Settle so the baseline diff is
    // tight, then close the popover (shrink the overlay) and verify no
    // FULL_CLEAR fires. This is the EXACT transition the pre-migration
    // sig tracker caught.
    sm.applyMsg({ type: 'fabric_form_choices_request', port: 'name', requestId: 1 });
    sm.applyMsg({
      type: 'fabric_form_choices_resolved', port: 'name', actionKey: 'pick', requestId: 1,
      items: ['alpha', 'bravo', 'charlie'], labels: null, error: null,
    });
    sm.applyMsg({ type: 'fabric_form_choices_open', port: 'name' });
    sm.capture(sm.render);              // settle after open
    sm.applyMsg({ type: 'fabric_form_choices_close' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'fabric_form_choices_close emitted a full-clear — the migration retires prevFabricPickingSig; cell-diff must handle the popover shrink from the natural row delta');
  });
});

report();
