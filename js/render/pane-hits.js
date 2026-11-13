/**
 * Pane hit regions — the paint side of pane-anchored clicks (docs/mouse-hit-map.md
 * Release 2). render/paint brackets every pane render with `begin` / `end`;
 * inside the bracket:
 *   - hit-map.enterPane is set (the pane's screen rect, clipped to the composed
 *     frame), so pane renderers publish pane-local regions via
 *     hitMap.publishLocal (table's fold markers, text-view's ✗ cancel);
 *   - renderPanel's drawn-chrome record (draw.setChromeSink → `publishChrome`)
 *     becomes chrome-band regions: [_]/[+]/[X]/[≡], border controls, slot tabs.
 * Outside a bracket nothing publishes (an overlay's renderPanel, a unit call).
 *
 * The click gates arrive from paint's _chromeContext (one place): `chromeLive`
 * for chrome-band clicks, `bodyLive` for clicks gated like a pane-body click
 * (tabs, fold markers). Release 3's pane-body regions publish here too.
 */
'use strict';

const hitMap = require('../panel/hit-map');

// A pane's hit rect: its paint rect clipped to the composed frame (`frame` =
// { cols, rows } the view composes into; absent → unclipped). The origin is
// kept (publishLocal translates by it); a pane wholly outside the frame gets an
// empty rect, so nothing it publishes survives.
function _hitRect(x, y, w, h, frame) {
  if (!frame) return { x, y, w, h };
  return { x, y, w: Math.min(w, frame.cols - x), h: Math.min(h, frame.rows - y) };
}

// The pane being rendered: { panel, chrome, live, bodyLive } between begin and
// end; null otherwise, so an overlay's renderPanel publishes no pane chrome.
let _chromeCur = null;

/** Open the bracket for one pane render. `rect` = its paint rect; `ctx` =
 *  { chrome, chromeLive, bodyLive, frame } (frame = { cols, rows } composed). */
function begin(panel, rect, ctx) {
  ctx = ctx || {};
  hitMap.enterPane(panel.paneId, _hitRect(rect.x, rect.y, rect.w, rect.h, ctx.frame));
  _chromeCur = { panel, chrome: ctx.chrome, live: !!ctx.chromeLive, bodyLive: !!ctx.bodyLive };
}

/** Close the bracket (paint calls it in a finally). */
function end() {
  hitMap.exitPane();
  _chromeCur = null;
}

// Turn a drawn-chrome record (pane-local x-ranges on the top row; null = not
// drawn) into hit-map regions in the chrome band. Only what painted publishes
// (the record already carries renderPanel's `fits` + [≡] truncation decisions),
// and only while chrome clicks are live (paint's chromeLive — decided at paint
// rather than at click; the frame stamp's chain field keeps the two equivalent).
// Glyph handlers are absolute: the Msg names the pane's pool id.
function publishChrome(rec) {
  const cur = _chromeCur;
  if (!cur || !cur.live || !rec) return;
  const { panel, chrome } = cur;
  const Z = hitMap.BANDS.CHROME;
  const glyph = (id, g, handler) => {
    if (g) hitMap.publishLocal({ id, rect: { x: g.x0, y: 0, w: g.x1 - g.x0 + 1, h: 1 }, on: { press: handler } }, Z);
  };
  glyph('collapse', rec.collapse, { msg: { type: 'panel_collapse_toggle', id: panel.id }, owner: 'layout' });
  glyph('close', rec.close, { msg: { type: 'pool_hide', id: panel.id }, owner: 'layout' });
  const ts = chrome && chrome.tabTrigger;
  if (ts === 'open') glyph('trigger', rec.trigger, { msg: { type: 'pane_menu_close' }, owner: 'layout' });
  else if (ts === 'available') glyph('trigger', rec.trigger, { act: 'pane-menu-open', paneId: panel.paneId });
  // Border controls — the top strip (refresh `- Ns +`, sort `‹ col ›`, …) and the
  // bottom item-action legend, published from the x renderPanel drew each at.
  // The spec's own regions() splits a control into its clickable parts; the Msg
  // is computed at CLICK time by the spec (mouse-acts 'border-control'), against
  // the then-current sort / selection, after re-checking the control is shown.
  // A part repeats on a fast 2nd click only when its spec says so (steppers:
  // refresh `-`/`+`, sort `‹`/`›` — two clicks = two steps); toggles (sort
  // label, ‹ tree ›, zoom reset) and item actions don't — a double-click must not
  // undo itself or run an action twice.
  const ctl = (c, y) => {
    const ref = c && c.ref;
    if (!ref || !ref.spec || typeof ref.spec.regions !== 'function') return;
    const pane = ref.pane || { paneId: panel.paneId, type: panel.type };
    for (const r of ref.spec.regions(c.x0, y, c.visibleW, pane) || []) {
      hitMap.publishLocal({
        id: `ctl:${ref.spec.id}:${r.action}`,
        rect: { x: r.x0, y: r.y, w: r.x1 - r.x0 + 1, h: 1 },
        repeat: r.repeat === true,
        on: { press: { act: 'border-control', paneId: pane.paneId, type: pane.type, specId: ref.spec.id, action: r.action } },
      }, Z);
    }
  };
  for (const c of rec.controls || []) ctl(c, 0);
  // Slot tab strip — each tab renderPanel drew intact. Normal mode only (the tab
  // click was always gated like a pane-body click: no chain mode active).
  if (cur.bodyLive) {
    for (const t of rec.tabs || []) {
      if (!t.ref || !t.ref.poolId) continue;
      hitMap.publishLocal({
        id: `tab:${t.ref.poolId}`,
        rect: { x: t.x0, y: 0, w: t.x1 - t.x0 + 1, h: 1 },
        on: { press: { msg: { type: 'activate_tab', paneId: panel.paneId, tabPoolId: t.ref.poolId }, owner: 'layout' } },
      }, Z);
    }
  }
  if (rec.bottomControl) ctl(rec.bottomControl, rec.bottomControl.y);
}

module.exports = { begin, end, publishChrome };
