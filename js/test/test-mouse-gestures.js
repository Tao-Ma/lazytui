/**
 * v0.6.4 Theme F Phase 3 — SGR press classification (double-click +
 * un-dropped buttons).
 *
 * `_classifyPress(button, x, y, now)` is the parser's gesture derivation:
 * the only layer that sees raw press timing. It turns a fresh (non-wheel,
 * non-motion, non-release) press into a gesture string —
 *   left (0):   `double` iff the SAME 1-based cell within the ~250 ms
 *               window, else `press` (and the {lastX,lastY,lastTime}
 *               triple advances);
 *   right (2):  `right`;
 *   middle (1): `middle` (reserved no-op downstream);
 *   other:      null (dropped, as the pre-Theme-F filter did).
 *
 * `now` is threaded in so the timing logic is testable without mocking
 * Date.now(). The module-local triple is stateful across calls, so each
 * `it` advances `now` past the window to start from a clean single.
 *
 *   node js/test/test-mouse-gestures.js
 */
'use strict';

const { _classifyPress } = require('../dispatch/input');
const { describe, it, eq, report } = require('./test-runner');

describe('[Theme F P3] _classifyPress — buttons', () => {
  it('right button (2) → right', () => {
    eq(_classifyPress(2, 5, 5, 1000), 'right', 'right press');
  });
  it('middle button (1) → middle', () => {
    eq(_classifyPress(1, 5, 5, 1000), 'middle', 'middle press');
  });
  it('button 3 (none/other) → null (dropped)', () => {
    eq(_classifyPress(3, 5, 5, 1000), null, 'other button dropped');
  });
});

describe('[Theme F P3] _classifyPress — double-click window', () => {
  it('a fresh left press is a single', () => {
    eq(_classifyPress(0, 10, 4, 100000), 'press', 'first left press → press');
  });

  it('same cell within 250 ms → double', () => {
    _classifyPress(0, 10, 4, 200000);              // prime the triple
    eq(_classifyPress(0, 10, 4, 200200), 'double', '200 ms later, same cell → double');
  });

  it('same cell at exactly 250 ms → double (inclusive boundary)', () => {
    _classifyPress(0, 7, 7, 300000);
    eq(_classifyPress(0, 7, 7, 300250), 'double', 'Δ = 250 ms is still a double');
  });

  it('slow double (>250 ms) stays two singles', () => {
    _classifyPress(0, 3, 9, 400000);
    eq(_classifyPress(0, 3, 9, 400251), 'press', 'Δ = 251 ms → second single, not a double');
  });

  it('fast repeat in a DIFFERENT cell stays two singles', () => {
    _classifyPress(0, 20, 2, 500000);
    eq(_classifyPress(0, 21, 2, 500050), 'press', 'different column → single');
    _classifyPress(0, 20, 2, 510000);
    eq(_classifyPress(0, 20, 3, 510050), 'press', 'different row → single');
  });

  it('a right/middle press does not arm a following left double', () => {
    // The triple only advances on left presses, so an interleaved
    // right-click between two left clicks must not reset the window —
    // but it also must not let an unrelated cell read as a double.
    _classifyPress(0, 30, 1, 600000);              // left, primes triple at (30,1)
    _classifyPress(2, 30, 1, 600100);              // right at same cell — must NOT touch the triple
    eq(_classifyPress(0, 30, 1, 600150), 'double', 'left→right→left same cell within window → double');
  });

  it('a triple-click emits exactly one double (3rd click resets)', () => {
    // After a `double` the triple resets, so a 3rd rapid same-cell
    // click is a fresh single — not a second `double` (which would
    // double-fire activate). Regression for the v0.6.4 review LOW.
    eq(_classifyPress(0, 40, 5, 700000), 'press',  '1st click → press');
    eq(_classifyPress(0, 40, 5, 700100), 'double', '2nd click → double');
    eq(_classifyPress(0, 40, 5, 700200), 'press',  '3rd click → press (not a 2nd double)');
    // …and a 4th immediately after the reset re-arms a normal double.
    eq(_classifyPress(0, 40, 5, 700300), 'double', '4th click → double again');
  });
});

report();
