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
const modes = require('../leaves/input/modes');
const { getModel } = require('../app/runtime');

// ---- [1] registry shape + derivations ----------------------------

describe('[1] registry derivations', () => {
  it('CHAIN_MODES is the modeChain precedence order', () => {
    eq(modes.CHAIN_MODES.join(','),
       'confirmMode,promptMode,freeConfigTitleEditMode,freeConfigMode,menuOpen,filterMode,copyMode,detailSearchMode,registerPopupMode,prefixMode,cmdMode,paneMenuMode,jobsMode,diagLogMode');
  });
  it('isOverlayActive matches the pre-registry hardcoded list', () => {
    const overlay = ['copyMode','menuOpen','freeConfigMode','cmdMode','confirmMode','promptMode','registerPopupMode','prefixMode','paneMenuMode','jobsMode','diagLogMode'];
    for (const f of modes.MODES.map(m => m.flag)) {
      const s = {}; s[f] = true;
      eq(modes.isOverlayActive(s), overlay.includes(f), `${f} overlay`);
    }
  });
  it('isModal matches the pre-registry hardcoded list', () => {
    const modal = ['terminalMode','filterMode','copyMode','freeConfigMode','freeConfigTitleEditMode','menuOpen','prefixMode'];
    for (const f of modes.MODES.map(m => m.flag)) {
      const s = {}; s[f] = true;
      eq(modes.isModal(s), modal.includes(f), `${f} modal`);
    }
  });
  it('suppressesChromeClicks matches the pre-fold hand-rolled list', () => {
    // v0.6.4 Theme D — folded input.js#_suppressesChromeClicks into the
    // MODES `suppressChrome` column; this pins behavior-equivalence with
    // the 8-mode list it replaced.
    const suppress = ['cmdMode','menuOpen','copyMode','confirmMode','promptMode',
                      'registerPopupMode','freeConfigTitleEditMode','terminalMode','diagLogMode'];
    for (const f of modes.MODES.map(m => m.flag)) {
      const s = {}; s[f] = true;
      eq(modes.suppressesChromeClicks(s), suppress.includes(f), `${f} suppressChrome`);
    }
  });
  it('isOverlayActive / isModal / suppressesChromeClicks are false when nothing is active', () => {
    const s = {};
    eq(modes.isOverlayActive(s), false);
    eq(modes.isModal(s), false);
    eq(modes.suppressesChromeClicks(s), false);
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
    assert(s.confirmMode === false && s.promptMode === false && s.freeConfigTitleEditMode === false);
  });
});

// ---- [3] dispatch wires every chain mode to a handler -------------

describe('[3] dispatch modeChain completeness', () => {
  it('requiring dispatch does not throw (every CHAIN_MODES flag has a handler)', () => {
    // dispatch.js builds modeChain at module load and throws if any
    // CHAIN_MODES flag lacks a handler — so a clean require IS the test.
    let ok = true;
    try { require('../dispatch/control/dispatch'); } catch { ok = false; }
    assert(ok, 'dispatch loaded; modeChain fully wired');
  });
});

// ---- [4] T2 wedge guard -------------------------------------------

const dispatch = require('../dispatch/control/dispatch');

describe('[4] wedge guard (_dispatchActiveMode)', () => {
  it('a throwing mode handler is caught, flag cleared, key claimed', () => {
    // The registerPopupMode handler does a live property lookup
    // (registerPopup.viewportRows, to build the nav Msgs), so we can force
    // it to throw.
    const rp = require('../overlay/register-popup');
    const eventLog = require('../io/event-log');
    const orig = rp.viewportRows;
    const origErr = console.error;
    let logged = '';
    rp.viewportRows = () => { throw new Error('boom'); };
    console.error = (...a) => { logged = a.join(' '); };
    // T11 — the wedge-guard now also persists to event-log so the bug
    // class that hid handleFilterKey for who-knows-how-long is
    // post-mortem inspectable. Clear the buffer before driving.
    eventLog.clear();
    try {
      modes.resetModes(getModel().modes);
      getModel().modes.registerPopupMode = true;
      const claimed = dispatch._dispatchActiveMode('x', 'x');  // must not throw
      eq(claimed, true, 'mode claimed the key');
      eq(getModel().modes.registerPopupMode, false, 'flag force-cleared so the user is not wedged');
    } finally {
      rp.viewportRows = orig;
      console.error = origErr;
    }
    assert(/registerPopupMode/.test(logged) && /boom/.test(logged), `error logged: ${logged}`);
    // T11 assertion: event-log captured the diagnostic.
    const errs = eventLog.snapshot().filter(e => e.type === 'error');
    assert(errs.length >= 1, 'event-log captured at least one error entry');
    const last = errs[errs.length - 1];
    eq(last.payload.where, 'mode_handler', 'where=mode_handler');
    eq(last.payload.flag, 'registerPopupMode', 'flag carried through');
    assert(/boom/.test(last.payload.message), 'error message preserved');
  });
  it('returns false (falls through) when no mode is active', () => {
    modes.resetModes(getModel().modes);
    eq(dispatch._dispatchActiveMode('j', 'j'), false);
  });
});

// ---- [5] T6 regression: filterMode j/k/arrows must not wedge ----
//
// The 2a2b96e (key, seq) handler sweep dropped the leading `model` arg
// from handleFilterKey but left two `handleAction(model, ...)` calls
// referencing the now-undefined identifier. Pressing j/k/up/down inside
// filter mode threw ReferenceError, which the wedge-guard at [4]
// silently swallowed by force-clearing filterMode — user-visible
// symptom: filter overlay disappears when trying to navigate the
// filtered list. Pin the post-fix behavior: handler does NOT throw,
// filterMode stays active, no wedge-guard log.

describe('[5] T6 regression: filterMode j/k navigates without wedging', () => {
  it('j/k/arrows preserve filterMode (no ReferenceError → no force-clear)', () => {
    const origErr = console.error;
    let logged = '';
    console.error = (...a) => { logged += a.join(' ') + '\n'; };
    try {
      for (const [key, seq] of [['', 'j'], ['', 'k'], ['up', ''], ['down', '']]) {
        modes.resetModes(getModel().modes);
        getModel().modes.filterMode = true;
        const claimed = dispatch._dispatchActiveMode(key, seq);
        eq(claimed, true, `${key||seq} claimed by filterMode handler`);
        eq(getModel().modes.filterMode, true, `${key||seq} preserved filterMode (no wedge)`);
      }
      eq(logged, '', 'no wedge-guard error logged');
    } finally {
      console.error = origErr;
      modes.resetModes(getModel().modes);
    }
  });
});

report();
