/**
 * Chrome-region ↔ paint agreement for the LEFT-anchored `[≡]` trigger under
 * leftPart truncation — the residual phantom the first phantom-hit fix (8d6c7580)
 * missed and a review caught.
 *
 * The `[≡]` lives inside `leftPart`, which renderPanel truncates INDEPENDENTLY of
 * the whole-cluster `fits`: a long title or a right-anchored border-control strip
 * shrinks `leftCap` and can clip the glyph while the row still composites. Gating
 * the published trigger on `fits` alone therefore over-reported it — a click would
 * land where only `[≡…` (or nothing) painted. The fix gates on the glyph's LAST
 * cell surviving truncation. This test drives the leaf renderPanel + the chrome
 * sink directly (no layout needed) and asserts: the registry publishes a trigger
 * range IFF the full `[≡]` was actually painted — across the truncation boundary,
 * for BOTH a trigger-only pane and a control-strip pane. It fails on the pre-fix
 * `chromeDrew`-only gate (which publishes a trigger where `[≡]` was clipped).
 *
 * Run: node js/test/test-chrome-trigger-truncation.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const draw = require('../leaves/render/draw');
const { richToAnsi } = require('../leaves/text/ansi');

// Visible text of a markup line (strip SGR). The trigger glyph `\[≡]` decodes to a
// literal `[≡]`; a truncated one shows `[≡…` / `[…` (no closing `]`).
function visible(markup) { return richToAnsi(markup).replace(/\x1b\[[0-9;]*m/g, ''); }

let captured = null;
draw.setChromeSink((r) => { captured = r; });   // isolated: this file loads no paint

function renderTop(opts) {
  captured = null;
  const out = draw.renderPanel({ height: 5, lines: [], focused: true, ...opts });
  return { top: visible(out.split('\n')[0]), reg: captured };
}

describe('[trigger truncation] trigger-only pane — published range matches the painted [≡]', () => {
  // Viewer/detail chrome: only tabTrigger, so rightVis == 1 and `fits` stays true
  // even as the [≡] truncates — the pre-fix phantom.
  const chrome = { collapse: null, close: null, tabTrigger: 'available' };
  let sawClipped = false, sawPainted = false;
  for (const [hotkey, title] of [['', ''], ['d', 'Detail'], ['x', 'A Long Title Here']]) {
    for (let w = 5; w <= 26; w++) {
      const { top, reg } = renderTop({ width: w, title, hotkey, chrome });
      const painted = top.includes('[≡]');           // full 3-cell glyph on screen
      const clickable = !!(reg && reg.trigger);
      if (painted) sawPainted = true; else sawClipped = true;
      it(`hk=${JSON.stringify(hotkey)} w=${w}: registry trigger ⟺ painted [≡]`, () => {
        eq(clickable, painted, `painted=${painted}, registry ${clickable ? 'HAS' : 'lacks'} trigger — top=${JSON.stringify(top)}`);
      });
    }
  }
  it('the sweep hit BOTH a painted and a clipped [≡] (non-vacuous)', () => {
    assert(sawPainted && sawClipped, `painted=${sawPainted} clipped=${sawClipped}`);
  });
});

describe('[trigger truncation] border-control strip clips [≡] while close/collapse still paint', () => {
  // A right-anchored control strip reserves width, shrinking leftCap so the [≡]
  // clips while `fits` (= leftCap >= 2) holds — the MORE reachable phantom.
  const chrome = { collapse: 'collapse', close: null, tabTrigger: 'available' };
  const topControls = ['- 2s +'];   // ~6-cell control, right-anchored left of the glyphs
  let sawClipped = false, sawPainted = false;
  for (let w = 14; w <= 30; w++) {
    const { top, reg } = renderTop({ width: w, title: 'Docker', hotkey: 'd', chrome, topControls });
    const painted = top.includes('[≡]');
    const clickable = !!(reg && reg.trigger);
    if (painted) sawPainted = true; else sawClipped = true;
    it(`w=${w}: trigger ⟺ painted [≡] (collapse published independently)`, () => {
      eq(clickable, painted, `painted=${painted}, registry ${clickable ? 'HAS' : 'lacks'} trigger — top=${JSON.stringify(top)}`);
      // When the whole row fits, collapse [_] is right-anchored + never truncated,
      // so it stays published regardless of the [≡] clip.
      if (top.includes('[_]')) assert(reg && reg.collapse, 'painted [_] must be published');
    });
  }
  it('the strip sweep hit BOTH a painted and a clipped [≡] (non-vacuous)', () => {
    assert(sawPainted && sawClipped, `painted=${sawPainted} clipped=${sawClipped}`);
  });
});

report();
