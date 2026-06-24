/**
 * #F4.4 — index↔projection alignment invariant.
 *
 * Two effect-driven Cmds invoke a module-held closure by INDEX into a table
 * that parallels a render-safe projection on the model:
 *
 *   cmdline_run {sel, display} → cmdline.runAt(sel, args, display) → _full[sel].run()
 *   copy_commit {idx, label}   → copy.copySelect(idx, label)       → _options[idx]
 *
 * The held table and its model projection are built in one shot (rebuild() /
 * collectOptions()), so they're parallel by construction. The risk the review
 * named is a FUTURE change rebuilding one side without the other (or reordering
 * one), which would silently invoke a different closure than the highlighted
 * label.
 *
 * The guard captures what the user SAW (display/label) at reduce time and
 * carries it ON THE Cmd — NOT a re-read of the model, which the submit/select
 * reducer arm has already cleared by the time the effect runs (this was the
 * vacuousness bug the pre-release review's Track 3 caught: a model re-read here
 * always saw `undefined`). The use-site compares the held closure against the
 * carried value, so the guard stays load-bearing across the projection clear.
 *
 * This pins all three halves: (1) construction parallelism on the real
 * rebuild() path, (2) the guard predicate, and (3) the LIVE use-site guard —
 * driving runAt()/copySelect() with controllable closures to prove it actually
 * runs the aligned entry and ABORTS a misaligned one.
 *
 * Run: node js/test/test-index-align.js
 */
'use strict';

const cmdline = require('../dispatch/control/cmdline');
const copy = require('../overlay/copy');
const { describe, it, eq, assert, report } = require('./test-runner');

describe('[1] cmdline: rebuild() projection is parallel-indexed to _full', () => {
  it('same length + per-index display, on the real registry', () => {
    const proj = cmdline.rebuild('');          // framework defaults — non-empty
    const held = cmdline._fullDisplays();       // _full[i].display
    assert(proj.length > 0, 'registry non-empty (sanity — defaults present)');
    eq(proj.length, held.length, 'projection length === _full length');
    const parallel = proj.every((p, i) => p.display === held[i]);
    assert(parallel, 'projection[i].display === _full[i].display for all i');
  });

  it('holds after a narrowing rebuild too', () => {
    const proj = cmdline.rebuild('he');         // narrows toward "help"
    const held = cmdline._fullDisplays();
    eq(proj.length, held.length, 'narrowed projection length === _full length');
    assert(proj.every((p, i) => p.display === held[i]), 'still parallel after narrow');
  });
});

describe('[2] cmdline: _aligned(expectedDisplay, held) guard predicate', () => {
  it('true when held display matches the expected (carried) display', () => {
    assert(cmdline._aligned('help', { display: 'help' }), 'match → aligned');
  });
  it('false when they diverge (the tripwire)', () => {
    assert(!cmdline._aligned('help', { display: 'quit' }), 'divergent → NOT aligned');
  });
  it('true when no entry was chosen (expected == null) or held absent', () => {
    assert(cmdline._aligned(undefined, { display: 'help' }), 'no expectation → aligned (vacuous)');
    assert(cmdline._aligned('help', undefined), 'no held → aligned (range-checked by caller)');
  });
});

describe('[3] copy: _aligned(expectedLabel, held) guard predicate', () => {
  it('true when held label matches the expected (carried) label', () => {
    assert(copy._aligned('Detail', { label: 'Detail' }), 'match → aligned');
  });
  it('false when they diverge (the tripwire)', () => {
    assert(!copy._aligned('Detail', { label: 'Image ID' }), 'divergent → NOT aligned');
  });
  it('true when no option was chosen or held absent', () => {
    assert(copy._aligned(undefined, { label: 'Detail' }), 'no expectation → aligned (vacuous)');
    assert(copy._aligned('Detail', undefined), 'no held → aligned (range-checked by caller)');
  });
});

describe('[4] cmdline: LIVE runAt() guard runs aligned, aborts misaligned', () => {
  it('runs the closure when the carried display matches _full[sel]', () => {
    let ran = null;
    cmdline._setFull([
      { display: 'help', run: () => { ran = 'help'; } },
      { display: 'quit', run: () => { ran = 'quit'; } },
    ]);
    cmdline.runAt(0, [], 'help');               // carried display === _full[0].display
    eq(ran, 'help', 'aligned → ran the matching closure');
    cmdline._setFull([]);
  });
  it('ABORTS (does not run) when the carried display diverges from _full[sel]', () => {
    let ran = null;
    cmdline._setFull([
      { display: 'help', run: () => { ran = 'help'; } },
    ]);
    // _full was reordered/rebuilt so sel=0 is now "help", but the user selected
    // (and the Cmd carries) "quit" — the guard must refuse to run the wrong one.
    cmdline.runAt(0, [], 'quit');
    eq(ran, null, 'misaligned → run aborted (would have invoked the wrong closure)');
    cmdline._setFull([]);
  });
});

describe('[5] copy: LIVE copySelect() guard aborts misaligned', () => {
  it('does NOT invoke the content thunk when the carried label diverges', () => {
    let copied = null;
    copy._setOptions([
      { label: 'Detail', content: () => { copied = 'Detail'; return ''; } },
    ]);
    // sel=0 is now "Detail" but the Cmd carries "Image ID" — abort before copy.
    copy.copySelect(0, 'Image ID');
    eq(copied, null, 'misaligned → copy aborted (content thunk never reached)');
    copy._setOptions([]);
  });
});

report();
