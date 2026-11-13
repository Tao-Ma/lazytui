/**
 * border-controls — the top-border control STRIP + bottom item-action legend,
 * paint side. Since hit-map Release 2 a control's click regions come from where
 * renderPanel REPORTS drawing it (the chrome sink's `controls` / `bottomControl`,
 * pane-local), and render/paint publishes the spec's regions() there — so the
 * agreement to pin is renderPanel's report ↔ its own painted row, for single- and
 * multi-control strips across widths (the multi-control phantom guard), plus the
 * bottom legend ↔ bottomFits (the one fit rule still shared with action-legend).
 *
 * Run: node js/test/test-border-controls.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const bc = require('../leaves/render/border-controls');
const draw = require('../leaves/render/draw');
const { stripMarkup } = require('../leaves/text/ansi');

// Capture renderPanel's drawn-chrome report (paint wires this sink in
// production; this process doesn't load paint, so the test owns it).
let lastRec = null;
draw.setChromeSink((rec) => { lastRec = rec; });
function renderTop(opts) {
  lastRec = null;
  const out = draw.renderPanel(opts);
  return { rows: out.split('\n').map(stripMarkup), rec: lastRec };
}

// Control objects as api.borderControlsFor returns them (spec + text + pane);
// renderPanel only reads .text and echoes the object back as `ref`.
const ctl = (text, id) => ({ text, visibleW: text.length, spec: { id }, pane: { paneId: 'p', type: 't' } });

// The phantom-click guard, generalized to a MULTI-control strip: renderPanel
// must REPORT both controls on exactly the widths it DRAWS them, at the x it drew
// each at — the report is what the hit map publishes from.
describe('[border-controls] top strip: report ↔ paint agreement (multi-control phantom guard)', () => {
  const A = ctl('AAAAAA', 'a');   // visibleW 6
  const B = ctl('BBBB', 'b');     // visibleW 4
  it('reports the strip IFF it drew both controls, at their painted x, w ∈ [8,48]', () => {
    let drewSome = false, droppedSome = false;
    for (let w = 8; w <= 48; w++) {
      const { rows, rec } = renderTop({
        width: w, height: 4, lines: [], title: 'T', hotkey: 'd',
        chrome: { collapse: 'collapse' }, topControls: [A, B],
      });
      const top = rows[0];
      const drawn = top.includes(A.text) && top.includes(B.text);
      const reported = !!(rec && rec.controls);
      eq(reported, drawn, `w=${w}: reported=${reported} drawn=${drawn} top=${JSON.stringify(top)}`);
      if (drawn) {
        drewSome = true;
        eq(rec.controls.map(c => c.x0), [top.indexOf(A.text), top.indexOf(B.text)], `w=${w}: x0s are the painted cells`);
        eq(rec.controls.map(c => c.visibleW), [6, 4]);
        assert(rec.controls[0].ref === A && rec.controls[1].ref === B, 'each entry echoes its control object');
        assert(rec.controls[0].x0 + 6 < rec.controls[1].x0, 'A fully left of B with a gap-dash between');
        eq(top[rec.controls[1].x0 + 4], '─', 'one dash after the last control');
        eq(top.slice(w - 4, w - 1), '[_]', 'the glyph cluster right of the strip');
      } else droppedSome = true;
    }
    assert(drewSome && droppedSome, 'the sweep saw both a drawn and a dropped strip');
  });
  it('markup-string controls (no object) still paint; their report carries no ref', () => {
    const { rows, rec } = renderTop({
      width: 44, height: 4, lines: [], title: 'T', hotkey: 'd',
      chrome: { collapse: 'collapse' }, topControls: ['AAAAAA'],
    });
    assert(rows[0].includes('AAAAAA'));
    eq(rec.controls.length, 1);
    eq(rec.controls[0].ref, null, 'nothing to publish without a spec');
  });
  it('presence is title-independent — a long title truncates instead', () => {
    const firstShown = (title) => {
      for (let w = 8; w <= 48; w++) {
        const { rec } = renderTop({ width: w, height: 4, lines: [], title, hotkey: 'd',
          chrome: { collapse: 'collapse' }, topControls: [A, B] });
        if (rec && rec.controls) return w;
      }
      return null;
    };
    const short = firstShown('T');
    assert(short != null, 'the strip shows at some width');
    eq(firstShown('a very long panel title that cannot fit'), short);
  });
});

// The bottom-legend paint ↔ report guard: renderPanel must draw the left-anchored
// bottom control on EXACTLY the widths bottomFits predicts, and report it at the
// cell it drew it — the geometry the hit map publishes from.
describe('[border-controls] bottom legend: render ↔ bottomFits ↔ report agreement', () => {
  const LEG = ctl('inspect stop kill', 'actions');   // visibleW 17
  it('draws + reports the legend IFF bottomFits, at its painted cell, w ∈ [8,40]', () => {
    for (let w = 8; w <= 40; w++) {
      const { rows, rec } = renderTop({ width: w, height: 4, lines: [], title: 'T', bottomControls: [LEG], count: [1, 3] });
      const row = rows[rows.length - 1];
      const drawn = row.includes(LEG.text);
      eq(drawn, bc.bottomFits(w - 2, 17), `w=${w}: drawn=${drawn} row=${JSON.stringify(row)}`);
      eq(!!(rec && rec.bottomControl), drawn, `w=${w}: reported iff drawn`);
      if (drawn) {
        eq(rec.bottomControl.x0, row.indexOf(LEG.text), `legend x0 is its painted cell (w=${w})`);
        eq(rec.bottomControl.y, 3, 'the bottom border row');
        assert(rec.bottomControl.ref === LEG, 'echoes the control object');
      }
    }
  });
});

// FINDING 1 regression: a bottom control with its OWN markup (colored keys) is
// wrapped with wrapColor, which re-opens the border color after each internal
// `[/]` reset — so the dashes/count/corner after the legend keep the border
// color instead of falling to the terminal default.
describe('[border-controls] bottom legend markup does not leak the border color', () => {
  const draw = require('../leaves/render/draw');
  it('re-opens fc after the legend’s internal [/] (regression)', () => {
    const out = draw.renderPanel({
      width: 60, height: 4, lines: [], title: 'T',
      bottomControls: ['[red]K[/]ill'], count: [1, 3], focused: true, color: 'blue',
    });
    const row = out.split('\n').pop();
    // wrapColor('blue', …) turns the legend's `[/]` into `[/][blue]`, so 'ill', the
    // dashes, the count, and the corner all render in fc — not terminal default.
    assert(row.includes('[/][blue]'), `fc re-opened after the legend reset: ${JSON.stringify(row)}`);
  });
});

report();
