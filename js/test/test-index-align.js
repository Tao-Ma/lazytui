/**
 * #F4.4 — index↔projection alignment invariant.
 *
 * Two effect-driven Cmds invoke a module-held closure by INDEX into a table
 * that parallels a render-safe projection on the model:
 *
 *   cmdline_run {sel} → cmdline.runAt(sel)   → _full[sel].run()
 *                       (model.modal.cmdline.matches[sel] is what the user saw)
 *   copy_commit {idx} → copy.copySelect(idx) → _options[idx]
 *                       (model.modal.copy.options[idx] is what the user saw)
 *
 * The held table and its model projection are built in one shot (rebuild() /
 * collectOptions()), so they're parallel by construction. The risk the review
 * named is a FUTURE change rebuilding one side without the other (or reordering
 * one), which would silently invoke a different closure than the highlighted
 * label. This pins both halves of the defense:
 *   (1) construction parallelism on the real rebuild() path, and
 *   (2) the use-site guard predicate (_aligned) that trips on divergence.
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

describe('[2] cmdline: _aligned guard predicate', () => {
  it('true when displays match', () => {
    assert(cmdline._aligned({ display: 'help' }, { display: 'help' }), 'equal display → aligned');
  });
  it('false when displays diverge (the tripwire)', () => {
    assert(!cmdline._aligned({ display: 'help' }, { display: 'quit' }), 'divergent display → NOT aligned');
  });
  it('true when either side is absent (range-checked by caller)', () => {
    assert(cmdline._aligned(undefined, { display: 'help' }), 'no shown → aligned (vacuous)');
    assert(cmdline._aligned({ display: 'help' }, undefined), 'no held → aligned (vacuous)');
  });
});

describe('[3] copy: _aligned guard predicate', () => {
  it('true when labels match', () => {
    assert(copy._aligned({ label: 'Detail' }, { label: 'Detail' }), 'equal label → aligned');
  });
  it('false when labels diverge (the tripwire)', () => {
    assert(!copy._aligned({ label: 'Detail' }, { label: 'Image ID' }), 'divergent label → NOT aligned');
  });
  it('true when either side is absent', () => {
    assert(copy._aligned(undefined, { label: 'Detail' }), 'no shown → aligned (vacuous)');
    assert(copy._aligned({ label: 'Detail' }, undefined), 'no held → aligned (vacuous)');
  });
});

report();
