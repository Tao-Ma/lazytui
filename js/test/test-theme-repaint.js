/**
 * Regression: a `:theme` switch must recolor STORED transcript content (the
 * completion chip, the `[warning]Cancelled.[/]` footer, any stored line).
 *
 * Stored rows carry SEMANTIC theme tokens (`[warning]`/`[error]`/`[success]`)
 * that resolve to the CURRENT palette at PAINT (ansi._expandThemeKeys, pinned in
 * test-ansi.js). But the main-frame diff (painter.paintFrame) compares MARKUP
 * strings, and a stored row's markup is byte-IDENTICAL across a theme switch — so
 * the diff would skip it and leave the previous theme's resolved ANSI on screen.
 * Only rows that changed for some other reason picked up the new palette, which is
 * exactly the user-reported symptom (2026-08-14): the chip + Cancelled line don't
 * recolor on `:theme` until the next run repaints them.
 *
 * The fix: paint.render() forces a full repaint when model.theme changes from the
 * previous frame, so every row re-resolves under the new palette. This pins that
 * force — AND its one-shot property (forcing every frame would kill the diff).
 * Combined with test-ansi.js (a full repaint runs richToAnsi, which re-resolves
 * semantic tokens on a theme flip) the stored-content recolor is fully covered.
 *
 * Run: node js/test/test-theme-repaint.js
 */
'use strict';

// Deterministic dims before anything (io/term reads stdout.columns at load).
process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');   // auto-wires panel-host
const sm = require('./smoke/_helpers/smoke');

const FULL_CLEAR = '\x1b[2J';   // painter.paintFrame's full-repaint marker

describe('[theme-repaint] a :theme change forces a full repaint (so stored rows re-resolve)', () => {
  sm.bootFresh({ groups: { g1: { name: 'g1', label: 'G1', containers: [], children: [], parent: null, depth: 0, quick: false, actions: {} } } });
  sm.resize(100, 30);

  // Reach steady state: the first paint(s) full-clear (initial forceFull), then
  // the diff settles so a no-op render emits no full clear.
  sm.capture(sm.render);
  const steady = sm.capture(sm.render).raw;

  it('a no-op re-render at the same theme does NOT full-repaint (diff-based steady state)', () => {
    assert(!steady.includes(FULL_CLEAR), `steady-state render must be diff-only, got a full clear:\n${JSON.stringify(steady.slice(0, 40))}`);
  });

  it('switching theme forces a full repaint (every stored row re-resolves under the new palette)', () => {
    sm.applyMsg({ type: 'set_theme', name: 'dracula' });
    const switched = sm.capture(sm.render).raw;
    assert(switched.includes(FULL_CLEAR), 'a :theme change must force a full repaint so unchanged-markup rows re-resolve');
  });

  it('the force is ONE-SHOT — the next same-theme render is diff-only again', () => {
    const after = sm.capture(sm.render).raw;
    assert(!after.includes(FULL_CLEAR), 'the theme-change force must not stick (forcing every frame would defeat the diff)');
  });

  it('a redundant :theme (same name) does not churn a full repaint', () => {
    sm.applyMsg({ type: 'set_theme', name: 'dracula' });   // already dracula → reducer no-ops
    const same = sm.capture(sm.render).raw;
    assert(!same.includes(FULL_CLEAR), 'set_theme to the current theme must not force a repaint');
  });
});

report();
