/**
 * Mode registry (js/modes.js) — the single source of truth that the
 * dispatch modeChain, layout overlay/modal lists, and initState reset
 * all derive from. These tests lock the derivations to the documented
 * behavior so the historical drift (a mode added to one list but not
 * the others) can't recur, and cover the T2 wedge guard + the initState
 * reset gap that the registry fixes.
 *
 * Run: node js/test/test-modes.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const modes = require('../dispatch/modes');
const { getModel } = require('../app/runtime');

// ---- [1] registry shape + derivations ----------------------------

describe('[1] registry derivations', () => {
  it('CHAIN_MODES is the modeChain precedence order', () => {
    eq(modes.CHAIN_MODES.join(','),
       'confirmMode,promptMode,designTitleEditMode,designMode,menuOpen,filterMode,copyMode,detailSearchMode,registerPopupMode,prefixMode,cmdMode');
  });
  it('isOverlayActive matches the pre-registry hardcoded list', () => {
    const overlay = ['copyMode','menuOpen','designMode','cmdMode','confirmMode','promptMode','registerPopupMode','prefixMode'];
    for (const f of modes.MODES.map(m => m.flag)) {
      const s = {}; s[f] = true;
      eq(modes.isOverlayActive(s), overlay.includes(f), `${f} overlay`);
    }
  });
  it('isModal matches the pre-registry hardcoded list', () => {
    const modal = ['terminalMode','filterMode','copyMode','designMode','designTitleEditMode','menuOpen','prefixMode'];
    for (const f of modes.MODES.map(m => m.flag)) {
      const s = {}; s[f] = true;
      eq(modes.isModal(s), modal.includes(f), `${f} modal`);
    }
  });
  it('isOverlayActive / isModal are false when nothing is active', () => {
    const s = {};
    eq(modes.isOverlayActive(s), false);
    eq(modes.isModal(s), false);
  });
});

// ---- [2] resetModes covers every flag (incl. the old gaps) --------

describe('[2] resetModes', () => {
  it('clears every mode flag, including confirm/prompt/designTitleEdit (the old initState gap)', () => {
    const s = {};
    for (const m of modes.MODES) s[m.flag] = true;
    modes.resetModes(s);
    for (const m of modes.MODES) eq(s[m.flag], false, `${m.flag} reset`);
    // Specifically the three that initState used to miss:
    assert(s.confirmMode === false && s.promptMode === false && s.designTitleEditMode === false);
  });
});

// ---- [3] dispatch wires every chain mode to a handler -------------

describe('[3] dispatch modeChain completeness', () => {
  it('requiring dispatch does not throw (every CHAIN_MODES flag has a handler)', () => {
    // dispatch.js builds modeChain at module load and throws if any
    // CHAIN_MODES flag lacks a handler — so a clean require IS the test.
    let ok = true;
    try { require('../dispatch/dispatch'); } catch { ok = false; }
    assert(ok, 'dispatch loaded; modeChain fully wired');
  });
});

// ---- [4] T2 wedge guard -------------------------------------------

const dispatch = require('../dispatch/dispatch');

describe('[4] wedge guard (_dispatchActiveMode)', () => {
  it('a throwing mode handler is caught, flag cleared, key claimed', () => {
    // The registerPopupMode handler does a live property lookup
    // (registerPopup.viewportRows, to build the nav Msgs), so we can force
    // it to throw.
    const rp = require('../overlay/register-popup');
    const orig = rp.viewportRows;
    const origErr = console.error;
    let logged = '';
    rp.viewportRows = () => { throw new Error('boom'); };
    console.error = (...a) => { logged = a.join(' '); };
    try {
      // reset all mode flags, then arm just this one
      modes.resetModes();
      getModel().modes.registerPopupMode = true;
      const claimed = dispatch._dispatchActiveMode('x', 'x');  // must not throw
      eq(claimed, true, 'mode claimed the key');
      eq(getModel().modes.registerPopupMode, false, 'flag force-cleared so the user is not wedged');
    } finally {
      rp.viewportRows = orig;
      console.error = origErr;
    }
    assert(/registerPopupMode/.test(logged) && /boom/.test(logged), `error logged: ${logged}`);
  });
  it('returns false (falls through) when no mode is active', () => {
    modes.resetModes();
    eq(dispatch._dispatchActiveMode('j', 'j'), false);
  });
});

report();
