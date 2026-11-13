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
const { compositeOverlays } = require('./overlay-capture');
const { stripMarkup } = require('../../leaves/text/ansi');
const { getModel } = require('../../app/runtime');

// Reset the parser's double-click triple to a far-off cell WITHOUT dispatching
// a press (input._classifyPress only records it), so the next press can't pair
// with an earlier same-cell one. A real off-screen press would itself be an
// "outside click" for overlays with a legacy outside-close (pane-menu).
const sgr = (btn, mx, my) => `\x1b[<${btn};${mx + 1};${my + 1}M`;
function _resetDouble() { input._classifyPress(0, 250, 90, Date.now()); }

/** Full paint (stdout captured) — publishes the hit map for the current model. */
function paint() { sm.capture(sm.render); }

function click(mx, my, button = 0) {
  _resetDouble();
  sm.capture(() => input._dispatchToken(sgr(button, mx, my)));
}
function dblclick(mx, my) {
  _resetDouble();
  sm.capture(() => { input._dispatchToken(sgr(0, mx, my)); input._dispatchToken(sgr(0, mx, my)); });
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
  const newRows = compositeOverlays(getModel());
  const r = _need(owner, id);
  return stripMarkup(newRows[r.rect.y]).slice(r.rect.x, r.rect.x + r.rect.w);
}

/** Paint a FULL frame (forceFullRepaint — production paint, so the hit map is
 *  repopulated too) and decode the emitted bytes into 0-based screen rows of
 *  single chars (paint positions with cursor moves, not '\n'). */
function screenRows() {
  const paintMod = require('../../render/paint');
  let raw = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { raw += s; return true; };
  try { paintMod.forceFullRepaint(); sm.render(); } finally { process.stdout.write = orig; }
  const rows = []; let cy = 0, cx = 0, i = 0;
  while (i < raw.length) {
    if (raw[i] === '\x1b') {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i));
      if (m) {
        if (m[2] === 'H') { const p = m[1].split(';').map(Number); cy = (p[0] || 1) - 1; cx = (p[1] || 1) - 1; }
        i += m[0].length; continue;
      }
      i++; continue;
    }
    if (raw[i] === '\n') { cy++; cx = 0; i++; continue; }
    if (raw[i] === '\r') { cx = 0; i++; continue; }
    (rows[cy] = rows[cy] || [])[cx] = raw[i]; cx++; i++;
  }
  return rows;
}

/** Full-frame paint, then the screen text under `owner/id`'s rect (single row) —
 *  the paint↔hit agreement check for pane chrome (paintedText only composites
 *  overlays). */
function screenText(owner, id) {
  const rows = screenRows();
  const r = _need(owner, id);
  const line = rows[r.rect.y] || [];
  let out = '';
  for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) out += line[x] || ' ';
  return out;
}

/** The pane-chrome glyph a press at (mx, my) resolves to on the CURRENT hit map
 *  (no repaint — paint first): `id` ∈ collapse | close | trigger, chrome band
 *  only. The resolve result `{ region, handler }` or null. */
function chromeAt(id, mx, my) {
  const h = hm.resolve(mx, my, 'press');
  return h && h.region.id === id && h.region.z === hm.BANDS.CHROME ? h : null;
}
/** paneId whose `[≡]` a press at (mx, my) hits, or null. */
function triggerAt(mx, my) { const h = chromeAt('trigger', mx, my); return h ? h.region.owner : null; }
/** Pool id a press on a `[_]`/`[+]` at (mx, my) toggles, or null. */
function collapseAt(mx, my) { const h = chromeAt('collapse', mx, my); return h ? h.handler.msg.id : null; }
/** Pool id a press on an `[X]` at (mx, my) hides, or null. */
function closeAt(mx, my) { const h = chromeAt('close', mx, my); return h ? h.handler.msg.id : null; }

/** What a press at (mx, my) on a border control would dispatch now — the
 *  spec's `{ owner, msg }` — or null when no border-control region is there
 *  (or the act would no-op). Resolves on the CURRENT hit map (paint first). */
function borderControlAt(mx, my) {
  const h = hm.resolve(mx, my, 'press');
  if (!h || !h.handler || h.handler.act !== 'border-control') return null;
  return require('../../dispatch/control/mouse-acts').resolveBorderControl(h.handler);
}

/** The slices of the model a popup interaction can change — for chip ≡ key
 *  parity comparisons (JSON round-trip drops functions / undefined). */
function snapshot(m) {
  m = m || getModel();
  return JSON.parse(JSON.stringify({ modes: m.modes, modal: m.modal, register: m.register, prefixSeq: m.prefixSeq }));
}

module.exports = {
  screenRows, screenText, borderControlAt, chromeAt, triggerAt, collapseAt, closeAt,
  paint, click, dblclick, wheel, regions, region, at,
  clickRegion, dblclickRegion, wheelRegion, paintedText, snapshot,
};
