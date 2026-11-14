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
 *   - the pane BODY (Release 3): one region over the whole pane at the body
 *     band, published at `begin`. Its handlers are acts that resolve the row /
 *     content cell under the pointer at click time (dispatch/control/pane-mouse);
 *     chrome, fold markers and popups sit above it in z.
 * Outside every pane, `publishScreen` covers the viewport at the screen band so
 * a right-click on empty space still opens the general context menu.
 *
 * The click gates arrive from paint's _chromeContext (one place): `chromeLive`
 * for chrome-band clicks, `bodyLive` for clicks gated like a pane-body click
 * (bodies, tabs, fold markers — the T13 chain gate at paint), `wheelLive` for
 * the body wheel (bodyLive, or agentMode).
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

// The pane being rendered: { panel, chrome, live, bodyLive, wheelLive, w, h }
// between begin and end; null otherwise, so an overlay's renderPanel publishes
// no pane chrome.
let _chromeCur = null;

// Hoverable pane kinds — a graph's value under the pointer (stats; composite
// routes to the widget under it). The hover tooltip reads hover-region.
const _HOVER_TYPES = new Set(['stats', 'composite']);

/** Open the bracket for one pane render. `rect` = its paint rect; `ctx` =
 *  { chrome, chromeLive, bodyLive, wheelLive, frame } (frame = { cols, rows }
 *  composed). Publishes the pane's body region. */
function begin(panel, rect, ctx) {
  ctx = ctx || {};
  hitMap.enterPane(panel.paneId, _hitRect(rect.x, rect.y, rect.w, rect.h, ctx.frame), panel.activeTabId);
  _chromeCur = { panel, chrome: ctx.chrome, live: !!ctx.chromeLive, bodyLive: !!ctx.bodyLive,
    wheelLive: !!(ctx.wheelLive || ctx.bodyLive), w: rect.w, h: rect.h };
  publishBody();
}

/** Publish the bracketed pane's BODY region (begin does; paint calls it again
 *  after retracting an errored pane's regions — the pane is still there). The
 *  acts carry only the paneId; the row / content cell is resolved at click
 *  time against the select-view capture this same paint records. Tab-scoped
 *  (a batched tab switch shows other content under the pointer). */
function publishBody() {
  const cur = _chromeCur;
  if (!cur) return;
  const paneId = cur.panel.paneId;
  const on = {};
  if (cur.bodyLive) {
    on.press = { act: 'pane-press', paneId };
    on.double = { act: 'pane-gesture', paneId, gesture: 'double-click' };
    on.right = { act: 'pane-gesture', paneId, gesture: 'right-click' };
    on.middle = { act: 'pane-gesture', paneId, gesture: 'middle-click' };
    if (_HOVER_TYPES.has(cur.panel.type)) on.hover = { act: 'pane-hover', paneId };
  }
  if (cur.wheelLive) {
    on['wheel-up'] = { act: 'pane-wheel', paneId, delta: -1 };
    on['wheel-down'] = { act: 'pane-wheel', paneId, delta: +1 };
  }
  if (!Object.keys(on).length) return;
  hitMap.publishLocal({ id: 'body', rect: { x: 0, y: 0, w: cur.w, h: cur.h }, on }, hitMap.BANDS.BODY);
}

/** The empty-screen region (paint, right after the hit map's clear): the
 *  button gestures outside every pane body — a right-click on empty space
 *  opens the general context menu (`pane-gesture` with no pane). Gated like a
 *  body (bodyLive). */
function publishScreen(cols, rows, bodyLive) {
  if (!bodyLive || !(cols > 0) || !(rows > 0)) return;
  const g = (gesture) => ({ act: 'pane-gesture', paneId: null, gesture });
  hitMap.publish({ id: 'screen', owner: 'screen', rect: { x: 0, y: 0, w: cols, h: rows }, z: hitMap.BANDS.SCREEN,
    on: { double: g('double-click'), right: g('right-click'), middle: g('middle-click') } });
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
// Glyph handlers are absolute: the Msg names the pane's pool id. Glyphs and the
// tab strip are PANE-level (they act on the pane, not its active tab), so they
// stay live across a batched tab switch; border controls are tab-scoped
// (hit-map §Tab scope).
function publishChrome(rec) {
  const cur = _chromeCur;
  if (!cur || !cur.live || !rec) return;
  const { panel, chrome } = cur;
  const Z = hitMap.BANDS.CHROME;
  const glyph = (id, g, handler) => {
    if (g) hitMap.publishLocal({ id, rect: { x: g.x0, y: 0, w: g.x1 - g.x0 + 1, h: 1 }, paneLevel: true, on: { press: handler } }, Z);
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
  // The handler names the spec OBJECT (static Component config), not just its
  // `id`: the spec contract never required an id, nor a unique one, so the act
  // finds the control by identity. A spec whose regions() throws or returns a
  // malformed value loses only its own clicks (a bad part, only that part) — a
  // paint-side bug must not turn the pane into an error block.
  // Region ids: `ctl:<spec id>:<action>` when the id names one drawn control;
  // otherwise (no id, or a duplicate) the spec object's own key, so the
  // press→double continuation (owner + id) never confuses two controls.
  const drawn = [...(rec.controls || []), rec.bottomControl].map(c => c && c.ref && c.ref.spec).filter(Boolean);
  const ctl = (c, y) => {
    const ref = c && c.ref;
    if (!ref || !ref.spec || typeof ref.spec.regions !== 'function') return;
    const pane = ref.pane || { paneId: panel.paneId, type: panel.type };
    const sid = ref.spec.id;
    const tag = sid != null && drawn.filter(s => s.id === sid).length === 1 ? sid : `${sid != null ? sid : ''}#${_specKey(ref.spec)}`;
    let parts;
    try {
      parts = ref.spec.regions(c.x0, y, c.visibleW, pane);
      if (parts != null && !Array.isArray(parts)) throw new TypeError('regions() must return an array');
    } catch (e) { _recordError('border_control_regions', panel, tag, e); return; }
    for (const r of parts || []) {
      if (!r || !Number.isFinite(r.x0) || !Number.isFinite(r.x1) || r.x1 < r.x0) {
        _recordError('border_control_regions', panel, tag, new TypeError('malformed region (needs numeric x0 <= x1)'));
        continue;
      }
      hitMap.publishLocal({
        id: `ctl:${tag}:${r.action}`,
        rect: { x: r.x0, y: Number.isFinite(r.y) ? r.y : y, w: r.x1 - r.x0 + 1, h: 1 },
        repeat: r.repeat === true,
        on: { press: { act: 'border-control', paneId: pane.paneId, type: pane.type, spec: ref.spec, specId: ref.spec.id, action: r.action } },
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
        paneLevel: true,
        on: { press: { msg: { type: 'activate_tab', paneId: panel.paneId, tabPoolId: t.ref.poolId }, owner: 'layout' } },
      }, Z);
    }
  }
  if (rec.bottomControl) ctl(rec.bottomControl, rec.bottomControl.y);
}

// A stable per-object key for a spec without a unique id (static config, so
// the key survives across frames; a fresh object gets a fresh key).
const _specKeys = new WeakMap();
let _nextSpecKey = 1;
function _specKey(spec) {
  let k = _specKeys.get(spec);
  if (k === undefined) { k = _nextSpecKey++; _specKeys.set(spec, k); }
  return k;
}

// A publish-side failure is recorded, never thrown into the pane's render —
// ONCE per pane / control / message: paint runs it every frame, and a
// per-frame record would flood the event-log ring.
const _recorded = new Set();
function _recordError(where, panel, tag, e) {
  try {
    const log = require('../io/event-log');
    if (!log.isEnabled()) return;
    const key = `${where}|${panel && panel.paneId}|${tag}|${e && e.message}`;
    if (_recorded.has(key)) return;
    if (_recorded.size >= 256) _recorded.clear();
    _recorded.add(key);
    log.record('error', {
      where, paneId: panel && panel.paneId, control: tag, message: e && e.message, stack: e && e.stack,
    });
  } catch (_) { /* event-log unavailable */ }
}

module.exports = { begin, end, publishChrome, publishBody, publishScreen };
