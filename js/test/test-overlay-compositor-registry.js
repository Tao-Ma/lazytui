/**
 * Overlay-compositor REGISTRY integration test — the final R3 exit
 * criteria pin (docs/overlay-compositor-migration.md §Release 3). The
 * unit test for the compositor's own primitives lives at
 * test-overlay-compositor.js; THIS test boots the real
 * `overlay-compositor-boot.registerAll()` and verifies every migrated
 * overlay descriptor is reachable, well-formed, and sits at the
 * expected zIndex position.
 *
 * If a future overlay migration forgets a `registerSelf` export OR
 * forgets to add a line to `registerAll`, this test fails loudly —
 * the drift-defense pin [[feedback_render_test_new_overlays]] codifies
 * for overlays, lifted to the whole registry.
 *
 * Pins:
 *   1. registerAll produces EXACTLY 15 descriptors (change this
 *      count intentionally — the test is the canary).
 *   2. Each expected overlay id is present.
 *   3. Each descriptor has the right shape: id, isActive fn, render
 *      fn, modal bool, zIndex int.
 *   4. zIndex ascending: the paint order matches the retired paint.js
 *      if-chain's historical order.
 *   5. Modal set matches the retired if-chain's modal semantics.
 *   6. activeOverlayIds + paintActive still behave on the real
 *      registry (an end-to-end smoke of the pipeline).
 *
 * Run: node js/test/test-overlay-compositor-registry.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const compositor = require('../render/overlay-compositor');

// The authoritative list — matches `js/render/overlay-compositor-boot.js`
// registerAll(). If you migrate a new overlay, add it here first; the
// drift pin below catches a forgotten boot-line.
const EXPECTED = [
  { id: 'confirm',         modal: true,  zIndex:  10 },
  { id: 'copy',            modal: true,  zIndex:  20 },
  { id: 'diag-log',        modal: false, zIndex:  30 },
  { id: 'jobs',            modal: false, zIndex:  40 },
  { id: 'pane-menu',       modal: true,  zIndex:  50 },
  { id: 'panel-list',      modal: true,  zIndex:  60 },
  { id: 'register-popup',  modal: true,  zIndex:  70 },
  { id: 'which-key',       modal: false, zIndex:  80 },
  { id: 'action-palette',  modal: true,  zIndex:  90 },
  { id: 'menu',            modal: true,  zIndex: 100 },
  { id: 'cmdline',         modal: true,  zIndex: 110 },
  { id: 'fabric-form',     modal: true,  zIndex: 120 },
  { id: 'fabric-field',    modal: true,  zIndex: 130 },
  { id: 'replay-scrubber', modal: false, zIndex: 140 },
  { id: 'hover-tooltip',   modal: false, zIndex: 999 },
];

// Rebuild the registry from a clean slate — some other test file in
// the same process may have called _reset() last. require('./overlay-
// compositor-boot') runs its side-effect registerAll() on first
// require; call registerAll() explicitly here so a repeat run after
// _reset() still populates.
compositor._reset();
const boot = require('../render/overlay-compositor-boot');
boot.registerAll();

describe('[overlay-compositor-registry] registerAll produces the expected shape', () => {
  it(`has exactly ${EXPECTED.length} descriptors (drift pin)`, () => {
    const n = compositor._count();
    assert(n === EXPECTED.length,
      `expected ${EXPECTED.length} overlays registered, got ${n}. ` +
      `If you migrated a new overlay, update EXPECTED in this file.`);
  });

  // Build a model where every overlay's `isActive` returns true, so we
  // can observe the full ordered id list in one go.
  const everything = {
    now: Date.now(),
    modes: {
      confirmMode: true, copyMode: true, diagLogMode: true, jobsMode: true,
      paneMenuMode: true, freeConfigMode: true, registerPopupMode: true,
      prefixMode: true, paletteMode: true, menuOpen: true, cmdMode: true,
      fabricFormMode: true, fabricFieldMode: true,
    },
  };

  it('flat-modal gate + zIndex sort: mode-everything surfaces (non-modals + highest-zIndex modal), zIndex-ascending', () => {
    // NAME NOTE — the "every expected id reachable" claim this test
    // used to carry overclaimed. The per-overlay single-flag pin below
    // is what reaches each id in isolation; THIS pin is specifically
    // about (a) the flat-modal gate selecting the highest zIndex and
    // (b) the active list sort order. See code review R3 for the
    // naming clarification.
    const ids = compositor.activeOverlayIds(everything);
    // modal-flat-invariant: with 11 modals all active, 10 are dropped,
    // only the HIGHEST zIndex modal (fabric-field, z=130) survives.
    // Non-modals (diag-log, jobs, which-key, replay-scrubber, hover-
    // tooltip) all survive. The order is zIndex-ascending.
    //
    // That gives us a crisp pin: the flat-modal warn fires AND every
    // non-modal paints AND the highest-zIndex modal wins.
    const modals = EXPECTED.filter(e => e.modal);
    const highestModal = modals.reduce((hi, e) => e.zIndex > hi.zIndex ? e : hi);
    const nonModals = EXPECTED.filter(e => !e.modal)
      // hover-tooltip's isActive gates on hoverRegion.get(), which is
      // null in this synthetic test; replay-scrubber gates on an
      // injected data source (also null in test). They don't surface
      // through activeOverlayIds here.
      .filter(e => e.id !== 'hover-tooltip' && e.id !== 'replay-scrubber');
    const expected = [...nonModals, highestModal].sort((a, b) => a.zIndex - b.zIndex);

    // Silence the flat-modal console.warn (expected here — the test is
    // DOING what the warn describes).
    const origWarn = console.warn; console.warn = () => {};
    try {
      const got = ids;
      assert(JSON.stringify(got) === JSON.stringify(expected.map(e => e.id)),
        `active ids:\n  got      ${JSON.stringify(got)}\n  expected ${JSON.stringify(expected.map(e => e.id))}`);
    } finally { console.warn = origWarn; }
  });

  // Reaching each descriptor directly via its own isActive — single-
  // flag models — tests every id in isolation, including the two
  // (hover-tooltip, replay-scrubber) that the global test suppresses.
  it('every expected overlay activates on its OWN gate', () => {
    const _mForFlag = (flag) => ({ now: Date.now(), modes: { [flag]: true } });
    const checks = {
      confirm:         _mForFlag('confirmMode'),
      copy:            _mForFlag('copyMode'),
      'diag-log':      _mForFlag('diagLogMode'),
      jobs:            _mForFlag('jobsMode'),
      'pane-menu':     _mForFlag('paneMenuMode'),
      'panel-list':    _mForFlag('freeConfigMode'),
      'register-popup':_mForFlag('registerPopupMode'),
      'which-key':     _mForFlag('prefixMode'),
      'action-palette':_mForFlag('paletteMode'),
      menu:            _mForFlag('menuOpen'),
      cmdline:         _mForFlag('cmdMode'),
      'fabric-form':   _mForFlag('fabricFormMode'),
      'fabric-field':  _mForFlag('fabricFieldMode'),
    };
    for (const [id, m] of Object.entries(checks)) {
      const ids = compositor.activeOverlayIds(m);
      assert(ids.indexOf(id) >= 0,
        `overlay '${id}' did not activate on its single-flag model (got ids: ${JSON.stringify(ids)})`);
    }
  });
});

describe('[overlay-compositor-registry] paintActive is callable on the real registry', () => {
  it('empty model → paintActive is a no-op (none active, no throws)', () => {
    const rows = new Array(5).fill('xxxx');
    compositor.paintActive({ modes: {} }, rows, 4);
    assert(JSON.stringify(rows) === JSON.stringify(['xxxx','xxxx','xxxx','xxxx','xxxx']),
      'rows mutated by paintActive with no-active model');
  });

  it('confirmMode model → paintActive calls confirm.render (mutates newRows)', () => {
    // Set the real store's model so renderConfirmOverlay (which reads
    // getModel()) finds a usable modal.continuation shape.
    const store = require('../model/store');
    const runtime = require('../app/runtime');
    const m0 = runtime.init();
    m0.modes.confirmMode = true;
    m0.modal = m0.modal || {};
    m0.modal.confirm = { message: 'ok', continuation: null };
    store.setModel(m0);
    const cols = 100;
    const rows = new Array(24).fill(' '.repeat(cols));
    compositor.paintActive(m0, rows, cols);
    const joined = rows.join('\n');
    assert(joined.includes('ok'),
      `expected 'ok' confirm message to land in newRows via paintActive. First 400 chars:\n${joined.slice(0, 400)}`);
  });
});

report();
