/**
 * Overlay compositor registry — unit tests for the module introduced
 * by overlay-compositor-migration Release 3 commit 1
 * (docs/overlay-compositor-migration.md §Release 3).
 *
 * Pins:
 *   1. `register` adds a descriptor; `_reset` clears; `_count` reports.
 *   2. `register` is idempotent on `id` (second registration replaces).
 *   3. `activeOverlayIds` filters by `isActive(model)` and sorts by zIndex
 *      (low → high = under → on top).
 *   4. `paintActive` calls each active descriptor's `render` in zIndex
 *      order, mutating newRows.
 *   5. Flat-modal invariant: two `modal: true` descriptors active
 *      simultaneously → keep the higher zIndex, drop the other, log a
 *      console.warn with { kept, dropped }.
 *   6. Non-modal descriptors are never filtered by the flat-modal
 *      gate — only two concurrent modals trip it.
 *   7. Zero overlays registered → paintActive is a no-op (the state
 *      the migration starts from before any overlay registers).
 *
 * Run: node js/test/test-overlay-compositor.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const compositor = require('../render/overlay-compositor');

function _freshModel(overrides) {
  return { modes: { ...(overrides && overrides.modes) }, ...(overrides || {}) };
}

function _mkD(id, opts) {
  return {
    id,
    isActive: opts.isActive || (() => true),
    render: opts.render || (() => {}),
    modal: !!opts.modal,
    zIndex: opts.zIndex | 0,
  };
}

describe('[overlay-compositor] register + _reset + _count', () => {
  compositor._reset();
  it('starts empty', () => {
    assert(compositor._count() === 0, `expected 0 registered, got ${compositor._count()}`);
  });
  it('register adds', () => {
    compositor.register(_mkD('a', { zIndex: 1 }));
    compositor.register(_mkD('b', { zIndex: 2 }));
    assert(compositor._count() === 2, `expected 2 registered, got ${compositor._count()}`);
  });
  it('register with existing id REPLACES (idempotent)', () => {
    compositor.register(_mkD('a', { zIndex: 99 }));  // replace
    assert(compositor._count() === 2, `expected 2 after replace, got ${compositor._count()}`);
    const ids = compositor.activeOverlayIds(_freshModel());
    // zIndex 2 ('b') < zIndex 99 ('a' replaced) → b first, a second.
    assert(ids[0] === 'b' && ids[1] === 'a', `expected [b, a], got ${JSON.stringify(ids)}`);
  });
  it('_reset clears', () => {
    compositor._reset();
    assert(compositor._count() === 0, 'reset should clear');
  });
});

describe('[overlay-compositor] activeOverlayIds — isActive filter + zIndex sort', () => {
  compositor._reset();
  compositor.register(_mkD('under',   { zIndex: 1,  isActive: (m) => !!m.modes.underMode }));
  compositor.register(_mkD('middle',  { zIndex: 5,  isActive: (m) => !!m.modes.middleMode }));
  compositor.register(_mkD('top',     { zIndex: 10, isActive: (m) => !!m.modes.topMode }));

  it('none active → empty', () => {
    const ids = compositor.activeOverlayIds(_freshModel());
    assert(ids.length === 0, `expected [], got ${JSON.stringify(ids)}`);
  });
  it('one active → single id', () => {
    const ids = compositor.activeOverlayIds(_freshModel({ modes: { middleMode: true } }));
    assert(ids.length === 1 && ids[0] === 'middle', `expected [middle], got ${JSON.stringify(ids)}`);
  });
  it('all active → sorted low→high (under paints first = below)', () => {
    const ids = compositor.activeOverlayIds(_freshModel({ modes: {
      underMode: true, middleMode: true, topMode: true,
    } }));
    assert(JSON.stringify(ids) === JSON.stringify(['under', 'middle', 'top']),
      `expected [under, middle, top], got ${JSON.stringify(ids)}`);
  });
  it('zIndex ties keep insertion order (deterministic replay)', () => {
    compositor._reset();
    compositor.register(_mkD('first',  { zIndex: 3 }));
    compositor.register(_mkD('second', { zIndex: 3 }));
    const ids = compositor.activeOverlayIds(_freshModel());
    assert(JSON.stringify(ids) === JSON.stringify(['first', 'second']),
      `expected [first, second], got ${JSON.stringify(ids)}`);
  });
});

describe('[overlay-compositor] paintActive — calls render in zIndex order', () => {
  compositor._reset();
  const log = [];
  compositor.register(_mkD('third',  { zIndex: 30, render: (m, rows) => { log.push('third');  rows[2] = 'c'; } }));
  compositor.register(_mkD('first',  { zIndex: 10, render: (m, rows) => { log.push('first');  rows[0] = 'a'; } }));
  compositor.register(_mkD('second', { zIndex: 20, render: (m, rows) => { log.push('second'); rows[1] = 'b'; } }));

  it('render fns called low→high zIndex', () => {
    const rows = [' ', ' ', ' '];
    compositor.paintActive(_freshModel(), rows, 10);
    assert(JSON.stringify(log) === JSON.stringify(['first', 'second', 'third']),
      `expected call order [first, second, third], got ${JSON.stringify(log)}`);
    assert(JSON.stringify(rows) === JSON.stringify(['a', 'b', 'c']),
      `expected rows mutated, got ${JSON.stringify(rows)}`);
  });
});

describe('[overlay-compositor] flat-modal invariant', () => {
  it('two modals active → keep higher zIndex, drop other, warn', () => {
    compositor._reset();
    compositor.register(_mkD('modal-lo', { zIndex: 10, modal: true, isActive: () => true }));
    compositor.register(_mkD('modal-hi', { zIndex: 20, modal: true, isActive: () => true }));
    compositor.register(_mkD('ambient',  { zIndex: 5,  modal: false, isActive: () => true }));

    const warned = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
      const ids = compositor.activeOverlayIds(_freshModel());
      // ambient paints first (z=5), modal-hi last (z=20). modal-lo dropped.
      assert(JSON.stringify(ids) === JSON.stringify(['ambient', 'modal-hi']),
        `expected [ambient, modal-hi], got ${JSON.stringify(ids)}`);
    } finally {
      console.warn = origWarn;
    }
    assert(warned.length === 1, `expected one warn, got ${warned.length}`);
    const [msg, payload] = warned[0];
    assert(/two modal overlays active/.test(msg),
      `warn message missing expected text: ${JSON.stringify(msg)}`);
    assert(payload && payload.kept === 'modal-hi',
      `warn payload.kept = ${JSON.stringify(payload && payload.kept)}, expected 'modal-hi'`);
    assert(payload && JSON.stringify(payload.dropped) === JSON.stringify(['modal-lo']),
      `warn payload.dropped = ${JSON.stringify(payload && payload.dropped)}, expected ['modal-lo']`);
  });

  it('one modal + many non-modals active → no warn, flat-modal clean', () => {
    compositor._reset();
    compositor.register(_mkD('modal',    { zIndex: 20, modal: true,  isActive: () => true }));
    compositor.register(_mkD('ambient1', { zIndex: 5,  modal: false, isActive: () => true }));
    compositor.register(_mkD('ambient2', { zIndex: 15, modal: false, isActive: () => true }));

    const warned = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
      const ids = compositor.activeOverlayIds(_freshModel());
      assert(JSON.stringify(ids) === JSON.stringify(['ambient1', 'ambient2', 'modal']),
        `expected [ambient1, ambient2, modal], got ${JSON.stringify(ids)}`);
    } finally {
      console.warn = origWarn;
    }
    assert(warned.length === 0, `expected no warn, got ${warned.length}`);
  });

  it('three modals active → keep max, drop two, warn naming both', () => {
    compositor._reset();
    compositor.register(_mkD('m1', { zIndex: 10, modal: true, isActive: () => true }));
    compositor.register(_mkD('m2', { zIndex: 30, modal: true, isActive: () => true }));
    compositor.register(_mkD('m3', { zIndex: 20, modal: true, isActive: () => true }));

    const warned = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warned.push(args); };
    try {
      const ids = compositor.activeOverlayIds(_freshModel());
      assert(JSON.stringify(ids) === JSON.stringify(['m2']),
        `expected [m2], got ${JSON.stringify(ids)}`);
    } finally {
      console.warn = origWarn;
    }
    assert(warned.length === 1 && warned[0][1].kept === 'm2'
      && JSON.stringify(warned[0][1].dropped.sort()) === JSON.stringify(['m1', 'm3']),
      `warn payload wrong: ${JSON.stringify(warned[0])}`);
  });
});

describe('[overlay-compositor] zero registered — paintActive is a no-op', () => {
  it('rows unchanged, no throw', () => {
    compositor._reset();
    const rows = ['x', 'y', 'z'];
    compositor.paintActive(_freshModel(), rows, 10);
    assert(JSON.stringify(rows) === JSON.stringify(['x', 'y', 'z']),
      `rows mutated with empty registry: ${JSON.stringify(rows)}`);
    assert(compositor.activeOverlayIds(_freshModel()).length === 0,
      'activeOverlayIds should be empty');
  });
});

// Clean up for any test file that imports this one indirectly.
compositor._reset();

report();
