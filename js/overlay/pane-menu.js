/**
 * Pane menu — the one generalized `[≡]` dropdown on every pane.
 *
 * v0.6.4 #1 Step 2 unioned the former two `[≡]` overlays (pane-select +
 * tab-list) into this single control. A pane's menu lists, in one
 * anchored dropdown:
 *   - **Tabs** of the pane (when it has >1 tab — viewers only today).
 *   - **Panes** — which pane occupies this slot / position.
 * Phase 1 shows a single section per pane (viewer ⇒ tabs, navigator ⇒
 * panes) so behavior is byte-identical to the two retired overlays; the
 * cross-section + half/full projection picks are Phase 2.
 *
 * The pick action is resolved by the CALLER (dispatch/input) from
 * (row section, current view mode), routing to existing reducer arms:
 *   - tab row            → tab_switch on the viewer (+ focus + close)
 *   - pane row / normal   → pool_swap_by_id (edit arrange; policy guards)
 *   - pane row / half     → view_place_pane (ephemeral projection)  [Phase 2]
 *   - pane row / full     → focus_set (full projects the focused pane) [Phase 2]
 *
 * State: open-bit is `model.modes.paneMenuMode` (the canonical "is open"
 * flag, AR2); cursor/scroll/target live on `layout.paneMenu =
 * { targetPaneId, cursor, scroll }` (pane-type-agnostic — subsumes the
 * old `layout.paneSelect` + `layout.tabListOwnerPaneId` + the viewer
 * slice's `tabList` nav state).
 *
 * Geometry: anchored dropdown from the target pane's top row (`y+1`,
 * the row below the `[≡]` trigger). Width clamps to the pane's width
 * (or MAX_W); height bottom-clamps to remaining space. Identical to the
 * two overlays it replaces; works in normal / half / full because both
 * trigger and dropdown follow `visibleBoundsFor(paneId)`.
 */
'use strict';

const { getModel } = require('../model/store');
const { getInstanceSlice, theme } = require('../panel/api');
const { renderPanel, viewportDims, writeOut, leftBorderPrefix } = require('../leaves/render/draw');
const { richToAnsi, RESET, esc, visibleLen } = require('../leaves/text/ansi');
const { isChainActive } = require('../leaves/input/modes');
const mpool = require('../leaves/wm/pool');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const route = require('../panel/route');

const MAX_W = 50;
const VIEWPORT = 12;

// `[≡]` is 3 visible cells (`[`, `≡`, `]`). Its START column is NOT fixed — it
// follows the `╭─(hotkey)?` prefix — so we take it from the SAME geometry the
// paint uses (draw.leftBorderPrefix), never a local formula. A hotkey-less pane
// draws `[≡]` flush at col 2; a hotkey pushes it right by `(${hotkey})`. (The old
// hardcoded col-5 offset assumed a 1-char hotkey and broke on hotkey-less panes.)
const TRIGGER_VIS_W = 3;

// Column (local to the pane's left border) where the `[≡]` glyph's `[` sits —
// resolved through the shared render geometry so paint + hit-test can't drift.
function _triggerX(pane) {
  return leftBorderPrefix(pane && pane.hotkey).triggerCol;
}

// Residue tracking — the dropdown shrinks/closes by overwriting only
// the rows it painted last frame (same pattern as overlay/cmdline).
let _lastPanelH = 0;
let _lastTop = 0;
let _lastLeft = 0;
let _lastWidth = 0;

// --- Item model --------------------------------------------------------
//
// items(paneId) returns a flat list of selectable rows. Each is tagged
// with `section`:
//   { section:'tab',  tabIdx, label, kind, closeable?, closeKind?, closeKey? }
//   { section:'pane', id, type, title, status:'here'|'placed'|'hidden', columnIndex }
// Phase 1: a pane yields exactly ONE section (tabs for a viewer with
// tabs, panes otherwise) so there is no separator yet.

/** Is this paneId a viewer (detail-kind) pane? Resolves via the live
 *  instance kind, falling back to the arrange pane's type for the boot
 *  edge / panes whose instance isn't minted. */
function _isViewer(paneId) {
  if (route.isViewerKind(paneId)) return true;
  const p = _paneById(paneId);
  return !!(p && p.type === 'detail');
}

/** Look up the arrange pane object for a paneId (null if not placed). */
function _paneById(paneId) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return null;
  const loc = mpool.findPaneLocation(layoutSlice.arrange, p => p.paneId === paneId);
  return loc ? loc.pane : null;
}

/** Tab rows for a MULTI-tab slot — the SAME unified entry list the visible border
 *  strip shows (panel/slot-strip), so the `[≡]` menu and the strip never disagree.
 *  U2f — every tab is a real position-tab (Info / Transcript / minted text-views);
 *  rows carry `backing:'slot'` + the entry's `{kind, poolId}` and a pick routes via
 *  set_active_tab (see dispatch._paneMenuPick). Empty for single-tab slots (their
 *  `[≡]` keeps the pane-swap behaviour). */
function _instanceTabRows(paneId) {
  const pane = _paneById(paneId);
  if (!pane || !Array.isArray(pane.tabs) || pane.tabs.length <= 1) return [];
  const strip = require('../panel/slot-strip').unifiedSlotStrip(pane);
  if (!strip || !strip.entries) return [];
  return strip.entries.map((e, i) => ({
    section: 'tab', backing: 'slot', kind: e.kind, poolId: e.poolId,
    tabIdx: i, label: e.label, active: i === strip.activeIdx,
  }));
}

/** Current view mode ('normal' | 'half' | 'full'). */
function _viewMode() {
  const l = getInstanceSlice('layout');
  return (l && l.viewMode) || 'normal';
}

/** Pane rows for the Panes section, tagged here/placed/hidden relative to
 *  `targetPaneId`. The source + content depend on the view mode:
 *    - normal — the arrange editor (pool_swap): navigators + hidden,
 *      viewers excluded (the policy layer — viewers aren't swapped here).
 *    - half/full — the PROJECTION picker: ALL placed panes incl. viewers
 *      (placed-only; view_place_pane / focus_set address placed panes). */
function _paneRows(targetPaneId, mode) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return [];
  if (mode === 'normal') {
    // Conservative: a viewer's [≡] in normal view offers tabs only (no
    // pane section) — viewers are placed/swapped via half/full, not the
    // arrange editor. A navigator's [≡] keeps today's pool-swap list.
    if (_isViewer(targetPaneId)) return [];
    return mpool.paneSelectItems(layoutSlice.arrange, targetPaneId)
      .map(it => ({ section: 'pane', ...it }));
  }
  return mpool.paneMenuPanes(layoutSlice.arrange, targetPaneId, mode)
    .map(it => ({ section: 'pane', ...it }));
}

/** The selectable rows for the menu anchored on `paneId`: an optional
 *  Tabs section (viewers, ≥2 tabs) then the Panes section. When both are
 *  present a `null` SEPARATOR row sits between them — a dim, non-selectable
 *  divider (nav skips it; a click on it is inert). Column-major flat within
 *  each section (the user's "flat" choice). */
function items(paneId) {
  if (paneId == null) paneId = _targetPaneId();
  if (!paneId) return [];
  const mode = _viewMode();
  // A MULTI-tab slot (the content slot, or any pane with >1 position-tab) offers
  // its position-tab switcher, so a backgrounded tab (e.g. Info behind an action's
  // text-view) is always reachable. Otherwise the Panes section (pool-swap /
  // projection picker). (U2f — the single-tab-viewer flat-strip rows retired.)
  const instTabs = _instanceTabRows(paneId);
  if (instTabs.length) return instTabs;
  return _paneRows(paneId, mode);
}

// --- Open-state + anchoring -------------------------------------------

/** The pane id whose menu is currently open (null when closed). */
function _targetPaneId() {
  const l = getInstanceSlice('layout');
  return (l && l.paneMenu && l.paneMenu.targetPaneId) || null;
}

/** Pane bounds via the VISIBLE accessor — null at boot, and null for
 *  off-screen panes in half/full so a click on the visible half can't
 *  fire the menu on a non-visible pane whose normal-view rect overlaps.
 *  Lazy require to dodge the layout ↔ overlay cycle. */
function _paneBounds(paneId) {
  return visibleBoundsFor(getInstanceSlice('layout'), paneId, route.resolveViewerPaneId());
}

/** Trigger glyph state machine (drives both chrome paint + click):
 *   'open'     paneMenuMode on → inverted block; click toggles closed.
 *   'disabled' another chain mode owns input → greyed, not clickable.
 *   'normal'   default → chrome color; click opens.
 *  (Per-pane visibility — "does this pane have anything to show" — is
 *  decided by `triggerVisible(paneId)`, separate from this overall
 *  state, mirroring the retired overlays.) */
function _triggerState() {
  const md = getModel().modes;
  if (md.paneMenuMode) return 'open';
  if (isChainActive(md)) return 'disabled';
  return 'normal';
}

function _triggerClickable() {
  const s = _triggerState();
  return s === 'open' || s === 'normal';
}

/** Does this pane's `[≡]` have anything to offer? A viewer shows when it
 *  has ≥2 tabs; any other pane shows when there is ≥2 pane rows (the
 *  current occupant + at least one swap target). Used by BOTH the click
 *  hit-test and the chrome paint so they never disagree. */
function triggerVisible(paneId) {
  // A multi-tab slot always has a position-tab switcher to show (the content slot
  // is always ≥2 tabs: Info + Transcript). Any other pane shows when there are ≥2
  // pane rows (the current occupant + ≥1 swap target).
  const pane = _paneById(paneId);
  if (pane && Array.isArray(pane.tabs) && pane.tabs.length > 1) return true;
  return _paneRows(paneId, _viewMode()).length >= 2;
}

/** Mouse hit-test for any pane's `[≡]` trigger. Returns the paneId under
 *  (mx,my) or null. Suppression: drag in flight or a non-paneMenu chain
 *  mode disables every trigger; while paneMenuMode is open only the open
 *  target's own glyph is live (toggles close); panes with nothing to
 *  show (triggerVisible=false) are skipped. */
function hitTestTrigger(mx, my) {
  if (!_triggerClickable()) return null;
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return null;
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  if (drag) return null;
  const modes = getModel().modes;
  const openTargetId = _targetPaneId();
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
    if (modes.paneMenuMode && p.paneId !== openTargetId) continue;
    if (!triggerVisible(p.paneId)) continue;
    const b = _paneBounds(p.paneId);
    if (!b) continue;
    const triggerX = _triggerX(p);   // hotkey-dependent — mirrors draw.js leftPart
    // KNOWN GAP (pre-existing, class-wide): this is a width PROXY for "is `[≡]`
    // painted". renderPanel drops ALL chrome (bare border, no glyph) when the
    // whole top row — title + the RIGHT [X]/[_]/controls cluster — doesn't fit
    // (draw.js `fits`), which this left-only check can't see; so a very narrow
    // pane can report a hit where nothing is drawn. Same proxy weakness as the
    // collapse/close hit-tests (chrome-hittest.js *_MIN_W). Not reachable in
    // normal layouts (panes are far wider); a real fix means the paint publishing
    // its actually-drawn chrome regions for the hit-test to read (its own arc).
    if (b.w < triggerX + TRIGGER_VIS_W + 2) continue;
    if (my !== b.y) continue;
    if (mx < b.x + triggerX) continue;
    if (mx >= b.x + triggerX + TRIGGER_VIS_W) continue;
    return p.paneId;
  }
  return null;
}

/** Compute the dropdown geometry from the target pane's bounds. */
function _geom(paneId) {
  if (paneId == null) paneId = _targetPaneId();
  if (!paneId) return null;
  const paneB = _paneBounds(paneId);
  if (!paneB) return null;
  const ROWS = viewportDims().rows;
  const all = items(paneId);
  const innerCap = Math.max(1, ROWS - paneB.y - 3);
  const lineCount = all.length === 0 ? 1 : Math.min(VIEWPORT, all.length);
  const innerH = Math.min(lineCount, innerCap);
  const h = innerH + 2;
  const w = Math.min(MAX_W, Math.max(20, paneB.w));
  const layoutSlice = getInstanceSlice('layout');
  const scroll = Math.max(0, (layoutSlice && layoutSlice.paneMenu && layoutSlice.paneMenu.scroll) || 0);
  return { x: paneB.x, y: paneB.y + 1, w, innerH, h, items: all, scroll };
}

/** Effective viewport row count — used by the nav handler for clamp
 *  math (keeps the reducer free of the terminal-size read). */
function viewportRows(paneId) {
  const g = _geom(paneId);
  return g ? g.innerH : 1;
}

/** Row hit-test for the open overlay. Returns { idx, item } on a list
 *  row, null for borders / outside / empty. */
function hitTest(mx, my) {
  if (!getModel().modes.paneMenuMode) return null;
  const g = _geom();
  if (!g) return null;
  if (mx < g.x || mx >= g.x + g.w) return null;
  if (my < g.y || my >= g.y + g.h) return null;
  if (my === g.y || my === g.y + g.h - 1) return null;
  if (g.items.length === 0) return null;
  const rowIdx = (my - g.y - 1) + g.scroll;
  if (rowIdx < 0 || rowIdx >= g.items.length) return null;
  return { idx: rowIdx, item: g.items[rowIdx] };
}

// --- Render ------------------------------------------------------------

function _statusLabel(it) {
  // Literal brackets MUST be escaped (`\[`) — an unescaped `[here]` parses
  // as an unknown markup tag → RESET, rendering the status column as
  // NOTHING. Latent since these labels existed; caught by the pre-release
  // review (Track 2 LOW, probed: richToAnsi('[dim][here][/]') emitted zero
  // visible text).
  const t = theme();
  if (it.status === 'here')   return '[dim]\\[here][/]';
  if (it.status === 'hidden') return `[${t.warning}]\\[hidden][/]`;
  return `[${t.accent}]\\[in col ${it.columnIndex + 1}][/]`;
}

/** Format a tab row: `* [N]  Label  (kind)` — `*` on the active tab. */
function _formatTabRow(it, isActive, width) {
  const marker = isActive ? '*' : ' ';
  const idx = esc(`[${it.tabIdx}]`);
  const label = esc(it.label);
  const kind = it.kind ? `(${it.kind})` : '';
  const left = `${marker} ${idx}  ${label}`;
  const leftVis = visibleLen(left);
  const kindVis = visibleLen(kind);
  const inner = Math.max(8, width - 4);
  if (kindVis === 0) return left;
  const padLen = Math.max(1, inner - leftVis - kindVis);
  return `${left}${' '.repeat(padLen)}${kind}`;
}

/** Format a pane row: `  Title            [status]`. Shows the human `title`
 *  (the name painted on the pane's border, e.g. "Actions"/"Groups") — NOT the
 *  raw structural `type` ("actions"/"component-ports") — so the picker matches
 *  what the user sees on-screen. Falls back to `type` if a title is absent. */
function _formatPaneRow(it, width) {
  const left = `  ${esc(it.title || it.type)}`;
  const right = _statusLabel(it);
  const leftVis = visibleLen(left);
  const rightVis = visibleLen(right);
  const inner = Math.max(8, width - 4);
  const padLen = Math.max(1, inner - leftVis - rightVis);
  return `${left}${' '.repeat(padLen)}${right}`;
}

function _formatRow(it, paneId, width) {
  if (it.section === 'tab') {
    // U2f — all tab rows are unified slot rows carrying their own `active` flag
    // (the viewer flat-strip rows + their slice.tab compare retired).
    return _formatTabRow(it, !!it.active, width);
  }
  return _formatPaneRow(it, width);
}

/** Paint the dropdown if paneMenuMode is active. Residue-blanks the
 *  rows the previous frame painted that this one doesn't. */
function render() {
  if (!getModel().modes.paneMenuMode) { _maybeBlank(); return; }
  const paneId = _targetPaneId();
  const g = _geom(paneId);
  if (!g) { _maybeBlank(); return; }
  const layoutSlice = getInstanceSlice('layout');
  const pm = (layoutSlice && layoutSlice.paneMenu) || { cursor: 0, scroll: 0 };
  const cursor = Math.max(0, Math.min(g.items.length - 1, pm.cursor || 0));
  const scroll = Math.max(0, Math.min(Math.max(0, g.items.length - g.innerH), g.scroll));

  const _pane = _paneById(paneId);
  const _multiTab = !!(_pane && Array.isArray(_pane.tabs) && _pane.tabs.length > 1);
  const title = (_multiTab || _isViewer(paneId)) ? 'Tabs' : 'Pane select';
  const lines = [];
  if (g.items.length === 0) {
    lines.push('[dim](no panes — pool is empty)[/]');
  } else {
    const end = Math.min(g.items.length, scroll + g.innerH);
    const inner = Math.max(8, g.w - 4);
    // Labeled dim divider between the Tabs and Panes sections — `─ panes ─…`.
    const sepLabel = '─ panes ';
    const sepRule = `[dim]${sepLabel}${'─'.repeat(Math.max(0, inner - visibleLen(sepLabel)))}[/]`;
    for (let i = scroll; i < end; i++) {
      if (g.items[i] === null) {            // section divider — dim, inert
        lines.push(sepRule);
        continue;
      }
      const text = _formatRow(g.items[i], paneId, g.w);
      lines.push((i === cursor) ? `[reverse]${text}[/]` : text);
    }
  }

  const content = renderPanel({
    width: g.w, height: g.h, lines,
    title, focused: true,
    count: g.items.length > 0 ? [cursor + 1, g.items.length] : null,
  });
  const panelLines = content.split('\n');
  let buf = '';
  for (let i = 0; i < panelLines.length; i++) {
    buf += `\x1b[${g.y + i + 1};${g.x + 1}H` + richToAnsi(panelLines[i]) + RESET;
  }
  // Residue-blank rows the prior frame painted but this one doesn't.
  if (_lastPanelH > g.h && _lastTop === g.y && _lastLeft === g.x) {
    const { invalidateRows } = require('../leaves/infra/render-queue');
    invalidateRows(g.y + g.h, _lastTop + _lastPanelH);
    for (let y = g.y + g.h; y < _lastTop + _lastPanelH; y++) {
      buf += `\x1b[${y + 1};${g.x + 1}H${' '.repeat(_lastWidth)}`;
    }
  }
  _lastPanelH = g.h;
  _lastTop = g.y;
  _lastLeft = g.x;
  _lastWidth = g.w;
  // Through draw's injected writer → paint's depth funnel (P3) — never raw
  // stdout: this overlay's rows carry theme hex since the truecolor arc.
  writeOut(buf);
}

function _maybeBlank() {
  if (_lastPanelH === 0) return;
  const { invalidateRows } = require('../leaves/infra/render-queue');
  invalidateRows(_lastTop, _lastTop + _lastPanelH);
  _lastPanelH = 0;
}

function _resetRenderState() { _lastPanelH = 0; _lastTop = 0; _lastLeft = 0; _lastWidth = 0; }

module.exports = {
  hitTestTrigger, hitTest, render, items, viewportRows,
  triggerVisible, _triggerState, _isViewer,
  _resetRenderState, _formatPaneRow,
};
