/**
 * info — the viewer's "Info" tab as a first-class pane type (U2e P0,
 * docs/one-tab-system.md). A scrollable text buffer whose content is INJECTED
 * from the focused Navigator's `getInfo(selectedItem)` projection (via the one
 * chokepoint `dispatch.showSelectedInfo` → the `info_show_content` arm), rather
 * than a streamed/seeded buffer like `text-view`.
 *
 * A near-clone of `panel/text-view/text-view.js`: same per-instance interaction
 * state (scroll/search/select/cursor) flowing through the SHARED reducer
 * `leaves/text/text-view-update` (ownKind 'info'), same `innerH`-via-augmentMsg
 * clamp, same `buildTextView` render. The only difference is the content source:
 * `info_show_content` REPLACES the buffer wholesale (a fresh Navigator selection)
 * — there are no append arms.
 *
 * U2e P0 ships this proven-by-test, NOT placed: the detail slot is still the
 * legacy `'detail'` viewer, so nothing mints an `info` instance yet. P1 (the
 * pivot) seeds the slot with an `info` tab and routes `showSelectedInfo` here.
 */
'use strict';

const { renderPanel } = require('../api');
const { buildTextView } = require('../../leaves/text-view/render');
const tvu = require('../../leaves/text/text-view-update');
const ms = require('../../leaves/text/search');
const { paneInnerH } = require('../pane-viewport');
const { getModel } = require('../../model/store');

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    // Self-identity: the COLUMN paneId (for geometry), threaded by the mint loop.
    paneId: paneId || null,
    // The injected Info content. `lines` (not `content`) to match text-view + the
    // shared reducer/render, which both key on a `lines` array.
    lines: Array.isArray(cfg.lines) ? cfg.lines : [],
    scroll: 0,
    // Viewport rows, stamped by augmentMsg (mirror viewer FIX-2); 0 pre-first-
    // dispatch → the shared reducer's _innerH falls back to 1.
    innerH: 0,
    // Full interaction state — same shapes the shared reducer + the viewer use,
    // per-instance (each info tab owns its own view state).
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
  };
}

// Content equality for info payloads (length + per-line ===) — mirror of the
// viewer's `_linesEq`. Info is small (a screenful); the scan is cheap and buys a
// ref-stable `slice.lines` across no-change refreshes (redraw fires the arm on
// every nav-select), so downstream ref-equality (search recompute) fires only on
// real change.
function _linesEq(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function update(msg, slice) {
  // Project the stamped viewport height onto the slice so the shared reducer's
  // clamps read it through _innerH (mirror viewer.js FIX-2 / text-view). The
  // `!==` guard preserves slice ref-identity when innerH is unchanged.
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };

  if (msg.type === 'info_show_content') {
    // Content injection — the focused Navigator's getInfo() lines arrive
    // PRECOMPUTED on msg.lines (dispatch.showSelectedInfo resolves them and skips
    // the dispatch when there's no getInfo / no selection). Mirror of the viewer's
    // `viewer_show_info` "already on Info" branch: replace the buffer, reset scroll
    // to the top of the new item's info, reset the match CURSOR on real content
    // change (keep the term so `/[Up]` recalls it). Per-tab view-state restore on
    // (re)mount is the framework's job (mint reconcile + finalizer view-state
    // capture/restore), not this arm.
    if (!Array.isArray(msg.lines)) return slice;
    const sameLines = _linesEq(slice.lines, msg.lines);
    // True no-op (content + scroll already in target shape) — return the input ref
    // so dispatch bookkeeping sees no change.
    if (sameLines && (slice.scroll || 0) === 0) return slice;
    const lines = sameLines ? slice.lines : msg.lines;
    const next = { ...slice, lines, scroll: 0 };
    if (!sameLines && slice.search && (slice.search.idx || 0) !== 0) {
      next.search = { ...slice.search, idx: 0 };
    }
    return next;
  }

  // Interaction — an info tab's content IS its own line buffer (ownKind 'info'
  // gates the key state machine). tvu.reduce owns the scroll clamp / per-Msg
  // mirror; null → not a msg it handles, keep the slice.
  const r = tvu.reduce(msg, slice, slice.lines || [], 'info');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport height so update() stays pure of
// layout geometry. Idempotent: a pre-attached innerH wins. Reuses the shared
// paneInnerH (keyed on this instance's column paneId) so a background info tab
// still clamps against its container slot's height.
function augmentMsg(msg, model, slice) {
  if (msg.innerH > 0) return msg;
  const ih = paneInnerH(slice);
  return ih > 0 ? { ...msg, innerH: ih } : msg;
}

// Search decoration for THIS instance's slice (mirror of text-view's, resolved
// against the own slice + focus). Render is impure shell, so the getModel() read
// of the global detailSearchMode flag is fine. Selection wins over search.
function _searchDecoration(slice, lines, focused) {
  const search = slice.search;
  if (!search) return null;
  const typingPhase = focused && getModel().modes.detailSearchMode;
  const term = typingPhase ? (search.typing || '') : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(lines, term);
  if (!matches.length) return null;
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
  return { matches, activeIdx };
}

// U2e P1b — when the info tab lives in a MULTI-tab content slot (the normal case:
// Info + Transcript + any opened content), its title becomes the slot's UNIFIED
// position-tab strip (`Info ─ Transcript ─ …`) so the siblings stay VISIBLE +
// clickable. Info is the DEFAULT active tab, so without this the strip would
// vanish whenever the user is on Info (the common state). Single-tab → plain title.
function _slotTitle(panel) {
  const strip = require('../slot-strip').unifiedSlotStrip(panel);
  return strip ? strip.title : (panel && panel.title);
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const lines = slice.lines || [];
  const sel = (slice.select && slice.select.active) ? slice.select : null;
  const searchDecoration = sel ? null : _searchDecoration(slice, lines, focused);
  const t = require('../../leaves/infra/themes').theme();
  const args = buildTextView({
    lines, scroll: slice.scroll, innerH: h - 2,
    select: sel, searchDecoration,
    // 3b — thread the theme's selection/search tags into the pure leaf.
    selectedTag: t.selected, searchTags: { match: t.match, current: t.match_current },
    width: w, height: h,
    title: _slotTitle(panel), hotkey: panel.hotkey,
    panelType: 'info', focused,
    chrome: opts && opts.chrome,
  });
  return renderPanel(args);
}

module.exports = {
  name: 'info',
  init,
  update,
  augmentMsg,
  panelTypes: { info: { render } },
};
