/**
 * Shared harness for hit-map mouse tests (docs/mouse-hit-map.md).
 *
 * Every gesture is RAW SGR bytes through input._dispatchToken — the real
 * parser → _classifyPress → handleMouse → mouse-router path — after a real
 * paint (smoke render) published the frame's regions. Pair with
 * smoke/_helpers/smoke for booting.
 *
 *   const hc = require('./_helpers/hit-click');
 *   hc.paint();
 *   hc.clickRegion('confirm', 'chip:y');
 *   eq(hc.paintedText('confirm', 'chip:y'), '[y] confirm');
 */
'use strict';

const sm = require('../smoke/_helpers/smoke');
const input = require('../../dispatch/control/input');
const hm = require('../../panel/hit-map');
const compositor = require('../../render/overlay-compositor');
const draw = require('../../leaves/render/draw');
const { chainStamp } = require('../../leaves/input/modes');
const { stripMarkup } = require('../../leaves/text/ansi');
const { getModel } = require('../../app/runtime');

// A press far off-screen: advances the parser's double-click triple without
// hitting anything, so the next press can't pair with an earlier same-cell one.
const OFF = '\x1b[<0;250;90M';
const sgr = (btn, mx, my) => `\x1b[<${btn};${mx + 1};${my + 1}M`;

/** Full paint (stdout captured) — publishes the hit map for the current model. */
function paint() { sm.capture(sm.render); }

function click(mx, my, button = 0) {
  sm.capture(() => { input._dispatchToken(OFF); input._dispatchToken(sgr(button, mx, my)); });
}
function dblclick(mx, my) {
  sm.capture(() => { input._dispatchToken(OFF); input._dispatchToken(sgr(0, mx, my)); input._dispatchToken(sgr(0, mx, my)); });
}
function wheel(mx, my, dir) { sm.capture(() => input._dispatchToken(sgr(dir === 'up' ? 64 : 65, mx, my))); }

function regions(owner) { return hm.all().filter(r => r.owner === owner); }
function region(owner, id) { return regions(owner).find(r => r.id === id) || null; }
function at(r) { return { mx: r.rect.x + Math.floor(r.rect.w / 2), my: r.rect.y + Math.floor(r.rect.h / 2) }; }

function _need(owner, id) {
  const r = region(owner, id);
  if (!r) throw new Error(`no hit region ${owner}/${id} (have: ${regions(owner).map(x => x.id).join(', ') || 'none'})`);
  return r;
}
function clickRegion(owner, id, button) { const { mx, my } = at(_need(owner, id)); click(mx, my, button); }
function dblclickRegion(owner, id) { const { mx, my } = at(_need(owner, id)); dblclick(mx, my); }
function wheelRegion(owner, id, dir) { const { mx, my } = at(_need(owner, id)); wheel(mx, my, dir); }

/** Re-composite the active overlays into a blank buffer (same hit-map bracket
 *  as production paint) and return the visible text under `owner/id`'s rect —
 *  the paint↔hit agreement check. Single-row regions only. */
function paintedText(owner, id) {
  const vp = draw.viewportDims();
  const newRows = new Array(vp.rows).fill(' '.repeat(vp.cols));
  hm.clear(chainStamp(getModel().modes));
  compositor.paintActive(getModel(), newRows, vp.cols);
  const r = _need(owner, id);
  return stripMarkup(newRows[r.rect.y]).slice(r.rect.x, r.rect.x + r.rect.w);
}

/** The slices of the model a popup interaction can change — for chip ≡ key
 *  parity comparisons (JSON round-trip drops functions / undefined). */
function snapshot(m) {
  m = m || getModel();
  return JSON.parse(JSON.stringify({ modes: m.modes, modal: m.modal, register: m.register, prefixSeq: m.prefixSeq }));
}

module.exports = {
  paint, click, dblclick, wheel, regions, region, at,
  clickRegion, dblclickRegion, wheelRegion, paintedText, snapshot,
};
