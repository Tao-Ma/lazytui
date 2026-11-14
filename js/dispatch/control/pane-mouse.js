/**
 * Pane-body mouse — what a pointer gesture on a pane BODY does
 * (docs/mouse-hit-map.md Release 3). render/pane-hits publishes one body region
 * per visible pane (hit-map BANDS.BODY) whose handlers are the acts below; the
 * router (./mouse-router) resolves them by z-order, so chrome, fold markers and
 * every popup above a body win without a line of precedence code here.
 *
 * Acts (registered with ./mouse-acts; each receives the event point):
 *   pane-press    focus + select the row under the pointer (the keyboard's
 *                 intents), cancel every prior text selection, and return the
 *                 drag the press may start: graph-zoom on a graph stats pane,
 *                 text-select on a selectable pane's content (zoom wins).
 *   pane-gesture  double / right / middle → the `mouse:` YAML binding's intent
 *                 (mouse-bindings.intentFor), realized against the region's pane
 *                 (paneId null = the empty-screen region: a right-click there
 *                 still opens the general context menu).
 *   pane-wheel    that pane's scroll (through the intent layer's scroll intent).
 *   pane-hover    the graph value under the pointer → layout `graph_hover`,
 *                 COALESCED per body cell (mode 1003 fires per cursor cell);
 *                 paneId null = the pointer left every hoverable body.
 *
 * Pointer-capture controllers (./pointer-capture):
 *   text-select   press arms at the content cell; the FIRST motion begins the
 *                 selection, further motion extends (clamped past the edge);
 *                 release copies a real drag to the register (and keeps it
 *                 highlighted) or cancels a no-drag press.
 *   graph-zoom    motion paints the pending column band; release freezes the
 *                 dragged range (stats.freezeRange → graph_zoom) or discards it.
 *
 * Rows / content cells are resolved at click time through the geometry the
 * pane actually PAINTED (panel/select-view's capture) — one region per pane,
 * not one per row (§Performance). An act returns false when nothing changed,
 * so the router skips the paint (wheel at a list's end, a hover in the same
 * cell).
 */
'use strict';

const { allPanels, setSel, getSel, getScroll } = require('../../panel/nav-state');
const { visibleBoundsFor, getPanelViewportH } = require('../../leaves/wm/geometry');
const { getPanelDef, getItems, getInstanceSlice, wrap, getFocus, instanceKind } = require('../../panel/api');
const { dispatchMsg } = require('../runtime/loop');
const route = require('../../panel/route');
const mpane = require('../../leaves/wm/pane');
const intent = require('./intent');
const mouseBindings = require('./mouse-bindings');
const { applyMsg, navSelect } = require('./dispatch');
const acts = require('./mouse-acts');
const capture = require('./pointer-capture');

// Cached lazy requires — these run per click AND per hover cell; a require()
// inside a hot function costs tens of µs per call (render/paint documents it).
let _selViewRef, _selConfigRef;
const selView = () => (_selViewRef || (_selViewRef = require('../../panel/select-view')));
const selConfig = () => (_selConfigRef || (_selConfigRef = require('../../panel/select-config')));

/**
 * Wheel-on-panel: hit-test (mx, my) against every panel's bounds and
 * scroll the one under the cursor. Returns true if any state mutated
 * (so the caller knows to repaint). Focus is intentionally NOT
 * changed — users can wheel through a side panel while keeping the
 * keyboard focused elsewhere, which is the friendlier-than-click
 * behavior most TUIs converge on.
 *
 * Per-panel behavior:
 *   detail        viewer_scroll ±1 (clamped — detail slice's `scroll`)
 *   list panels   moveSel-style ±1 on that panel's own selection
 *   anything else no-op
 *
 * In visual-mode the detail wheel still adjusts only the view; the
 * cursor's logical position stays where it is and may drift off
 * screen. Wheel back to bring it back. j/k is the way to extend the
 * selection.
 */
function handleWheel(mx, my, delta, paneId) {
  // Use visibleBoundsFor — in half/full view, off-screen panes are
  // absent from the derived visible-bounds map; boundsFor would fall back to
  // their normal-view rects in _currentLayout and we'd scroll a phantom
  // pane whose coords overlap with the visible half-view rect.
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    if (paneId != null && p.paneId !== paneId) continue;   // the hit map named the pane
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());  // v0.6.4 Phase 2 — paneId, not type (two same-kind panes share a type key)
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    if (instanceKind(p.paneId) === 'terminal') {
      // U2d P2b / v0.6.5 §5(a) — the wheel over a `terminal` pane scrolls the
      // PTY scrollback (xterm's own viewport), not any viewer slice. delta is
      // -1 (wheel-up = back into history) / +1 (wheel-down = toward live
      // bottom), which maps straight onto scrollSession's sign. A 3-line step
      // matches the typical wheel notch. Returns whether the viewport moved so
      // the caller's paint gating is unchanged.
      const termId = route.activeInstanceOf(p.paneId);
      if (termId) return require('../../io/terminal').scrollSession(termId, delta * 3);
      continue;
    }
    if (instanceKind(p.paneId) === 'agent') {
      // Wheel over an agent pane scrolls the transcript through the shared
      // reducer (clamped against the stamped innerH, which already reserves
      // the 2 bottom rows). Pre-check against the pane's own slice so a
      // no-move wheel skips the repaint (the viewer-branch posture).
      const inst = route.getInstance(route.activeInstanceOf(p.paneId));
      const a = inst && inst.slice;
      const lines = (a && Array.isArray(a.transcript)) ? a.transcript : [];
      const innerH = (a && a.innerH > 0) ? a.innerH : 1;
      const cur = (a && a.scroll) || 0;
      const next = Math.max(0, Math.min(Math.max(0, lines.length - innerH), cur + delta));
      if (next === cur) return false;
      dispatchMsg(wrap(p.paneId, { type: 'viewer_scroll', delta }));
      return true;
    }
    if (route.isViewerKind(p.paneId)) {   // U2e P1b — content-viewer kinds (detail/info/text-view)
      // v0.6.4 multi-viewer — clamp against the wheeled pane's OWN slice
      // (not the focused viewer's), so wheeling an unfocused second
      // viewer scrolls itself. sliceForPane resolves the pane's active instance.
      const d = route.sliceForPane(p.paneId, 'detail');
      // U2e P1b — the active instance (info / text-view) stores its buffer on
      // slice.lines directly; fall back to the viewer's derived lines for the
      // content instance's slice.lines. Used only for the scroll-clamp pre-check;
      // the viewer_scroll dispatch below re-clamps in the instance's own reducer.
      const lines = (d && Array.isArray(d.lines)) ? d.lines : [];
      const curScroll = d?.scroll || 0;
      // Single source of truth for the view-mode-aware viewport (P5
      // arc fix follow-up — panelHeights[type] would have given the
      // small normal-view share even in half/full view).
      const innerH = getPanelViewportH(
        layoutSlice, p.paneId, layoutSlice.dims, null, route.resolveViewerPaneId());  // v0.6.4 Phase 3b — paneId; resize-as-Msg P1 — model dims
      const maxScroll = Math.max(0, lines.length - innerH);
      const next = Math.max(0, Math.min(maxScroll, curScroll + delta));
      if (next === curScroll) return false;
      // v0.6.1 Phase 8 — scroll the specific viewer the wheel landed on.
      // v0.6.4 multi-viewer — address by paneId (was p.type, which collapsed
      // two same-kind viewers onto the kind primary).
      dispatchMsg(wrap(p.paneId, { type: 'viewer_scroll', delta }));
      return true;
    }

    const def = getPanelDef(p.type);
    if (def && typeof def.getItems === 'function') {
      // v0.6.4 Theme A Phase 5 — items + cursor for THIS pane (p.paneId),
      // so wheel-over a same-kind pane reads/moves its own selection.
      const items = getItems(p.paneId);
      if (!items.length) return false;
      const sel = getSel(p.paneId);
      const next = Math.max(0, Math.min(items.length - 1, sel + delta));
      if (next === sel) return false;
      // Focused-panel wheel: full nav cascade (cursor + auto-yank-or-
      // refresh — same path keyboard j/k uses). Unfocused (side-panel)
      // wheel: cursor only, no detail clobber. Groups still need the
      // resetGroupContext cascade even unfocused — wheel-over a side
      // groups panel should still switch the active group.
      // v0.6.2 — used to split setSel/selectGroup unconditionally and
      // call showSelectedInfo() if focused; folded into navSelect for
      // the focused case so auto-yank parity with keyboard is automatic.
      // v0.6.3 B3 — getFocus() is a paneId; tolerant compare via paneMatchesFocus
      // so wheel-over-focused-pane still hits the full-cascade navSelect path.
      if (mpane.paneMatchesFocus(p, getFocus())) {
        navSelect(p.paneId, next);
      } else if (p.type === 'groups') {
        // selectGroup(next) inlined — it was just navSelect('groups', …)
        // (v0.6.5 §1 Phase 2; navSelect already imported above).
        navSelect('groups', next);
      } else {
        setSel(p.paneId, next);
      }
      return true;
    }
    return false;
  }
  return false;
}

// Map a click's screen-y to a list pane's getItems INDEX, through the geometry
// the pane actually PAINTED (recorded in select-view). `my - b.y - 1` drops the
// top border; a pane that drew leading chrome outside its item list (the table
// panel's sticky header at inner row 0) records `headerRows`, dropped here too.
// The scroll offset comes from the paint for a WINDOWED pane — it self-slices +
// re-clamps its own scroll at render (the model's getScroll is NOT re-clamped to
// the list bounds, so it diverges on a resize / row-shrink while scrolled); the
// captured scrollOffset is exactly what was drawn (table AND gauge). Non-windowed
// panes keep getScroll — identical to what they painted (every navigator passes
// scrollOffset: getScroll). Returns the row index (>= 0) or -1 when the click
// lands above the first item (border/header).
function _rowIndexAt(paneId, b, my) {
  const cap = selView().contentFor(paneId);
  const header = (cap && cap.headerRows) || 0;
  const itemRow = my - b.y - 1 - header;
  if (itemRow < 0) return -1;
  const scroll = (cap && cap.windowed) ? cap.scroll : getScroll(paneId);
  return itemRow + scroll;
}

// v0.6.4 Theme F Phase 4 — side-effect-free hit resolution for a discrete
// button gesture: which pane + which row sits under the cursor. Mirrors the
// click body arm's geometry but WITHOUT its chrome/tab/detail/text-select
// pre-resolution — a button gesture on chrome / a tab / the border lands
// off-row (navIdx < 0) and is therefore inert for an `activate` mapping.
// Returns { paneId, navIdx } (navIdx >= 0 iff on a selectable row), or null
// when the cursor is outside every visible pane.
function _resolveBodyHit(mx, my, paneId) {
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    if (paneId != null && p.paneId !== paneId) continue;   // the hit map named the pane
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;
    let navIdx = -1;
    const def = getPanelDef(p.type);
    if (def && typeof def.getItems === 'function') {
      const idx = _rowIndexAt(p.paneId, b, my);
      if (idx >= 0 && idx < getItems(p.paneId).length) navIdx = idx;
    }
    return { paneId: p.paneId, navIdx };
  }
  return null;
}

// v0.6.4 Theme F follow-on — resolve the CONTEXT under a right-click for the
// context menu: which pane, and the text the "Copy …" entry would yank. For a
// viewer/detail pane that's the plain text of the line under the cursor; for a
// list pane it's the row label; plus the active text selection (if any). Side-
// effect-free (no focus/select change — a right-click only opens the menu).
// Returns { paneKind, lineText, itemLabel, selectionText } or null (outside
// every visible pane).
function _itemText(def, item) {
  if (item == null) return null;
  if (typeof item === 'string') return item;
  // Most navigators expose a filterText selector — the canonical "searchable
  // label" of a row, exactly the display text we want to copy.
  if (def && typeof def.filterText === 'function') {
    try { const t = def.filterText(item); if (t) return String(t); } catch (_) { /* fall through */ }
  }
  return item.label || item.name || item.title || item.text || null;
}

function _resolveContextAt(mx, my, paneId) {
  const { stripMarkup } = require('../../leaves/text/ansi');
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    if (paneId != null && p.paneId !== paneId) continue;   // the hit map named the pane
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;
    // Active text selection (docs/pane-selection.md) — POINTER-scoped: the
    // pane under the cursor's own selection wins, so right-clicking a visible
    // highlight always copies THAT text (more than one pane can hold an active
    // selection; the focused-first global scan would pick the wrong one).
    // Falls back to the app-wide selection when the pointer pane owns none.
    // Feeds the context menu's "Copy selection" / "Send selection to port".
    const psel = selView();
    const selectionText = psel.selectedTextFor(p.paneId) || psel.selectedText() || null;
    if (route.isViewerKind(p.paneId)) {   // U2f — content-viewer kinds (info / text-view)
      const itemRow = my - b.y - 1;  // -1 for top border
      const d = getInstanceSlice(p.paneId);
      // The active content instance holds its displayed buffer on slice.lines.
      const lines = (d && Array.isArray(d.lines)) ? d.lines : [];
      const li = itemRow + ((d && d.scroll) || 0);
      const lineText = (itemRow >= 0 && li < lines.length) ? stripMarkup(lines[li]) : null;
      return { paneKind: 'detail', lineText, itemLabel: null, selectionText };
    }
    const def = getPanelDef(p.type);
    let itemLabel = null, paneOpRows = [];
    if (def && typeof def.getItems === 'function') {
      const idx = _rowIndexAt(p.paneId, b, my);   // header-aware, painted-scroll
      const items = getItems(p.paneId);
      if (idx >= 0 && idx < items.length) {
        const rawItem = items[idx];
        itemLabel = _itemText(def, rawItem);
        // Item-operations (leaves/render/item-ops): the pointed pane's declared
        // per-row ops that opt into the right-click surface, as ready menu rows
        // (the impure resolver reads the pane's slice; buildContextItems is pure).
        // Guarded like the sibling `filterText` call above — a component's itemOps
        // must never crash the stdin handler; a throw just yields no ops.
        if (typeof def.itemOps === 'function') {
          try {
            const ops = def.itemOps(getInstanceSlice(p.paneId)) || [];
            paneOpRows = require('../../leaves/render/item-ops').contextOpRows(p.paneId, rawItem, ops);
          } catch (_) { /* offer no pane ops rather than crash the right-click */ }
        }
      }
    }
    return { paneKind: p.type, lineText: null, itemLabel, selectionText, paneOpRows };
  }
  return null;
}

// Realize the intent a discrete button gesture is bound to (the gesture →
// intent map's right-hand side). The supported vocabulary mirrors
// parser/schema.js VALID_MOUSE_INTENTS. The router paints after the act.
function _realizeButtonGesture(intentName, x, y, mx, my, paneId) {
  switch (intentName) {
    case 'noop':
      return;  // reserved-but-inert (the middle-click default)
    case 'context': {
      // Open the context menu anchored AT the cursor (1-based SGR {x,y}).
      // Resolve what's under the pointer → build the rows: contextual copy
      // entries when on a target, plus the always-present general section, so
      // a right-click on EMPTY space (null ctx) still opens a populated menu.
      const ctx = _resolveContextAt(mx, my, paneId) || {};
      const items = require('../../leaves/input/context-menu').buildContextItems(ctx);
      if (!items.length) return;  // safety — the general section keeps this non-empty
      intent.realize(intent.context({ x, y }, { items, title: 'Actions' }));
      return;
    }
    case 'activate': {
      // Focus + select + activate the row under the cursor — the click body
      // arm's path, gated on landing ON a row.
      const hit = _resolveBodyHit(mx, my, paneId);
      if (hit && hit.navIdx >= 0) {
        intent.realize(intent.focusPane(hit.paneId, { skipInfo: true }));
        intent.realize(intent.selectAt(hit.paneId, hit.navIdx));
        intent.realize(intent.activate());
        }
      return;
    }
    default:
      // Unknown intent — schema validation should make this unreachable;
      // be inert rather than throw on a hot input path.
      return;
  }
}

// ── Per-pane text selection (docs/pane-selection.md) ───────────────────────
// ONE mouse path for every pane — content panes (info / text-view / agent)
// included; their Components claim the wrapped select_* Msgs themselves, every
// other pane gets the loop's generic fallback. A left press ARMS a potential
// selection (records the anchor); the FIRST motion begins it — so a plain
// click still selects a row / focuses, and only a drag starts text selection.
// Module-local, transient (like the free-config drag).
// (Release 3 — the press arm is the text-select / graph-zoom pointer-capture
// controller below; one capture slot replaces _armedSelect / _armedZoom.)

// Is this pane a selection target? Not opted out via config (per-panel
// `select:` / global default — panel/select-config).
function _selectablePane(paneId) {
  if (!paneId) return false;
  const p = allPanels().find((x) => x.paneId === paneId);
  if (!p) return false;
  return selConfig().selectionEnabledFor(paneId);
}

// Map screen (mx,my) → { line (absolute content index), col (display) } inside a
// pane's content region. Absolute line folds in the pane's scroll (0 for the
// non-scrolling list panes) so the selection stays anchored to content, matching
// how the highlight decorates. `clamp` (the motion path) pins an out-of-bounds
// row to the nearest content row so a drag past the pane's edge extends to the
// first/last visible line; without it (the press path) border/outside rows
// return null — a press on the frame must not arm.
function _contentCoordsAt(paneId, mx, my, clamp) {
  const b = visibleBoundsFor(getInstanceSlice('layout'), paneId, route.resolveViewerPaneId());
  if (!b) return null;
  let row = my - b.y - 1;
  if (row < 0 || row > b.h - 3) {              // top/bottom border rows or beyond
    if (!clamp) return null;
    row = Math.max(0, Math.min(b.h - 3, row));
  }
  const cap = selView().contentFor(paneId);
  const scroll = cap ? cap.scroll : 0;
  // Selectable extent (docs/pane-selection.md §Interaction) — not every
  // interior row is selectable content. A windowed capture may carry
  // non-content rows after the real content (the agent pane's status/input
  // chrome + its provisional streaming preview — it declares
  // `selectableRows`); a full-content capture simply ends. A press beyond the
  // extent must not arm (the pointer isn't on selectable text); a drag pins to
  // the last selectable row, same as any past-the-edge motion.
  if (cap) {
    const rows = cap.windowed
      ? (cap.selectableRows != null ? cap.selectableRows : cap.lines.length)
      : cap.lines.length - scroll;
    if (rows <= 0) return null;                // nothing selectable this frame
    if (row > rows - 1) {
      if (!clamp) return null;
      row = rows - 1;
    }
  }
  return { line: scroll + row, col: Math.max(0, mx - b.x - 1) };
}


// ── Acts ─────────────────────────────────────────────────────────────────

// A left press on a pane body: the pre-R3 body loop for the ONE pane the hit map
// resolved. Returns the capture request (or undefined).
function _press(h, ev) {
  const paneId = h.paneId;
  const { mx, my } = ev;
  const layoutSlice = getInstanceSlice('layout');
  const p = allPanels().find((x) => x.paneId === paneId);
  const b = p && visibleBoundsFor(layoutSlice, paneId, route.resolveViewerPaneId());
  if (!b) return undefined;   // the pane left the screen since paint
  // A fresh press clears EVERY prior visible selection (more than one pane can
  // hold one — a persisted mouse selection + a keyboard visual-mode one, or a
  // hidden tab re-owning on switch-back) and ARMS a new one at the click's
  // content coords; the first motion begins it (so a plain click still selects
  // the row / focuses, only a drag selects text). Content panes (info /
  // text-view / agent) ride the same arm: their instances claim the wrapped
  // select_* Msgs with buffer-clamped coords.
  const psel = selView();
  for (const prior of psel.activeSelections()) dispatchMsg(wrap(prior.paneId, { type: 'select_cancel' }));
  let drag;
  if (_selectablePane(paneId)) {
    const cc = _contentCoordsAt(paneId, mx, my);
    if (cc) drag = { capture: 'text-select', paneId, line: cc.line, col: cc.col };
  }
  // Resolve whether this click lands on a selectable row BEFORE the focus_set:
  // if it does, navSelect (below) sets the cursor and fires show_selected_info
  // against the NEW selection, so focus_set skips its own cascade (skipInfo) to
  // avoid a double-fire against the pre-cursor-write (stale) item. Off-row
  // clicks keep focus_set's show_selected_info so Info still refreshes on focus.
  // The mapping is header-aware + reads the painted scroll (_rowIndexAt).
  let navIdx = -1;
  const def = getPanelDef(p.type);
  if (def && typeof def.getItems === 'function') {
    const idx = _rowIndexAt(paneId, b, my);
    if (idx >= 0 && idx < getItems(paneId).length) navIdx = idx;
  }
  // Drag-to-zoom (docs/STATS.md §10): a press on a GRAPH stats pane (sectioned /
  // overlay — getItems empty, so NOT a mode:multi list) starts the zoom drag. Zoom
  // WINS the gesture PANE-WIDE: a stats pane is text-selectable by default, and
  // the same drag must not ALSO run a text selection (a competing highlight + the
  // glyphs pushed to the register on release). A press-drag ANYWHERE on a graph
  // stats pane zooms (the column→range map is row-independent). Trade-off: the
  // header line's numbers are no longer drag-selectable on a graph pane — a
  // deliberate call. (mode:multi is a row list → getItems non-empty → selects.)
  if (p.type === 'stats' && getItems(paneId).length === 0) {
    const cc = _contentCoordsAt(paneId, mx, my);
    if (cc) drag = { capture: 'graph-zoom', paneId, startCol: cc.col };
  }
  // Focus + select route through the shared intent layer, mirroring keyboard.
  // focusPane carries skipInfo so, when a row is also selected, focus_set skips
  // its show_selected_info and navSelect's (against the new cursor) wins.
  intent.realize(intent.focusPane(paneId, { skipInfo: navIdx >= 0 }));
  if (navIdx >= 0) intent.realize(intent.selectAt(paneId, navIdx));   // cursor + auto-yank-or-show_info (+ groups cascade)
  return drag;
}

// Coalesce key for the last dispatched graph-hover — {paneId,col,row} of the body
// cell (or null). A no-button move that resolves to the SAME cell dispatches
// nothing (mode 1003 fires per cursor cell; this bounds it to one Msg + repaint
// per cell change). See js/io/term.js's enableMouse comment.
let _lastHover = null;

// Resolve the body cell under a hover and fold it into the layout slice (or
// clear). Hoverable panes (stats graphs, composite boxes) publish a hover handler;
// the value is derived at paint by the pane's render (stats.valueAt resolves
// sectioned/overlay/multi; composite routes to the widget under the cursor, and a
// non-graph cell resolves to nothing). paneId null — the pointer is over no
// hoverable body (another pane, a popup, an in-grid mode's screen) → clear, so a
// box doesn't linger under an overlay.
function _hover(h, ev) {
  let target = null;
  if (h.paneId) {
    const cc = _contentCoordsAt(h.paneId, ev.mx, ev.my);   // {line,col} body coords; null on border/outside
    if (cc) target = { paneId: h.paneId, col: cc.col, row: cc.line, x: ev.x, y: ev.y };
  }
  const key = target ? `${target.paneId}:${target.col}:${target.row}` : null;
  const lastKey = _lastHover ? `${_lastHover.paneId}:${_lastHover.col}:${_lastHover.row}` : null;
  if (key === lastKey) return false;                    // same cell (or still none) → no churn
  _lastHover = target;
  dispatchMsg(wrap('layout', { type: 'graph_hover', hover: target }));
  return true;
}

acts.register('pane-press', _press);
acts.register('pane-gesture', (h, ev) => {
  _realizeButtonGesture(mouseBindings.intentFor(h.gesture), ev.x, ev.y, ev.mx, ev.my, h.paneId);
});
// Pointer scroll routes through the intent layer (the v0.6.4 keyboard↔mouse
// seam); false = nothing moved (the router skips the paint).
acts.register('pane-wheel', (h, ev) => !!intent.realize(intent.scrollAt(ev.mx, ev.my, h.delta, h.paneId)));
acts.register('pane-hover', _hover);

// ── Pointer-capture controllers ────────────────────────────────────────────

// Text selection (docs/pane-selection.md) — ONE path for every pane. The select_*
// Msgs ride wrapped to the pane's active instance — content panes claim them in
// their own update (clamped against their buffer), every other pane gets the
// loop's generic fallback. The gesture is scoped to the CAPTURING pane
// throughout — never resolved by an ownership scan: more than one pane can hold
// an active selection by design, and a scan-first pick would extend / settle the
// WRONG pane's selection (copying stale text on release).
capture.register('text-select', {
  start: (args) => (args.paneId ? { paneId: args.paneId, line: args.line, col: args.col } : null),
  motion(st, ev) {
    const psel = selView();
    // First motion after the press: begin at the armed anchor (the pane's own
    // selection isn't active yet — the press cancelled priors).
    if (!psel.selectionFor(st.paneId)) {
      dispatchMsg(wrap(st.paneId, { type: 'select_begin', line: st.line, col: st.col, kind: 'char' }));
    }
    const cc = _contentCoordsAt(st.paneId, ev.mx, ev.my, true);   // clamp: drag past the edge pins to the nearest row
    if (cc) dispatchMsg(wrap(st.paneId, { type: 'select_extend', line: cc.line, col: cc.col }));
    return true;
  },
  // Settle: auto-copy a real drag (and keep it highlighted); cancel a no-drag
  // press so a plain click leaves no stray one-char selection.
  release(st) {
    const psel = selView();
    const own = psel.selectionFor(st.paneId);
    if (!own) return false;
    const s = own.sel;
    const dragged = !(s.anchor.line === s.cursor.line && s.anchor.col === s.cursor.col);
    const text = dragged ? psel.selectedTextFor(st.paneId) : '';
    if (text) applyMsg({ type: 'register_push', text });
    else dispatchMsg(wrap(st.paneId, { type: 'select_cancel' }));
    return true;
  },
  pressWhileHeld: 'drop',   // a lost release: the new press cancels selections itself
});

// Drag-to-zoom (docs/STATS.md §10).
capture.register('graph-zoom', {
  start: (args) => (args.paneId ? { paneId: args.paneId, startCol: args.startCol } : null),
  // Live drag-band: fold the pending [start,current] column range into the layout
  // slice so the pane highlights the range being selected. `graph_drag` is
  // identity-preserving, so motion within the same column dispatches nothing new.
  motion(st, ev) {
    const cc = _contentCoordsAt(st.paneId, ev.mx, ev.my, true);   // clamp past-edge to the nearest col
    if (!cc) return false;
    const lo = Math.min(st.startCol, cc.col);
    const hi = Math.max(st.startCol, cc.col);
    dispatchMsg(wrap('layout', { type: 'graph_drag', band: { paneId: st.paneId, lo, hi } }));
    return true;
  },
  // Commit: a real drag freezes that column range. The frozen snapshot is
  // computed by stats.freezeRange (an impure read of the live series) and handed
  // to the `graph_zoom` reducer as DATA; a click / too-small drag yields null →
  // no zoom.
  release(st, ev) {
    let dirty = false;
    // Clear the live band (if one was painted): the pending range is now either
    // committed to a `zoom` snapshot or discarded — the highlight goes either way.
    if (getInstanceSlice('layout').dragBand) {
      dispatchMsg(wrap('layout', { type: 'graph_drag', band: null }));
      dirty = true;
    }
    const cc = _contentCoordsAt(st.paneId, ev.mx, ev.my, true);
    if (cc) {
      const ls = getInstanceSlice('layout');
      const panel = allPanels().find((p) => p.paneId === st.paneId);
      const b = panel && visibleBoundsFor(ls, st.paneId, route.resolveViewerPaneId());
      if (panel && b) {
        const frozen = require('../../panel/monitor/stats').freezeRange(panel, b.w - 2, b.h - 2, st.startCol, cc.col);
        if (frozen) { dispatchMsg(wrap('layout', { type: 'graph_zoom', paneId: st.paneId, frozen })); dirty = true; }
      }
    }
    return dirty;
  },
  pressWhileHeld: 'drop',
});

/** Test seam — forget the hover coalescing record. */
function _resetHover() { _lastHover = null; }

module.exports = { handleWheel, _resetHover };
