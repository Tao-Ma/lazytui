/**
 * Fabric-field overlay — overlay-compositor migration (Release 2
 * Phase 2.c #2, docs/overlay-compositor-migration.md). The 1-port
 * invoke-time popup; sibling of fabric-form. Closes Phase 2.c.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `fabric_field_enter` (invoke-time path,
 *      `paneId: null`) through the real paint pipeline.
 *
 * Run: node js/test/test-fabric-field-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderFabricFieldOverlay } = require('../overlay/fabric-field');
const { visibleLen } = require('../leaves/text/ansi');

const PENDING = {
  actionKey: 'enable',
  action: { label: 'Enable', type: 'run', script: 'echo "$name"',
    ports: { in: { name: { type: 'string', required: true, desc: 'node to enable' } } } },
};

describe('[fabric-field-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, text: '', pendingAction: PENDING,
      addr: 'enable.name',
    });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderFabricFieldOverlay(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Enable'),
      `expected title "Enable" to land in newRows`);
    assert(joined.includes('enable.name'),
      `expected port address "enable.name" to land in newRows`);
    assert(joined.includes('node to enable'),
      `expected port desc to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, {
      type: 'fabric_field_enter', paneId: null, text: '', pendingAction: PENDING,
      addr: 'enable.name',
    });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderFabricFieldOverlay();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Enable'),
      `stdout fallback must still paint the title — got: ${JSON.stringify(stripped.slice(0, 120))}`);
    assert(stripped.includes('enable.name'),
      `stdout fallback must still paint the port address — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[fabric-field-overlay-composite] no FULL_CLEAR on fabric_field_enter', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the invoke-time field overlay does NOT emit a full-clear', () => {
    sm.applyMsg({
      type: 'fabric_field_enter', paneId: null, text: '', pendingAction: PENDING,
      addr: 'enable.name',
    });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'fabric_field_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(/Enable/.test(stripped),
      `expected the overlay title to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });
});

report();
