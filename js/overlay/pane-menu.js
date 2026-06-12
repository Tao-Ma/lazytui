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

const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { renderPanel } = require('../render/panel');
const { richToAnsi, RESET, esc, visibleLen } = require('../io/ansi');
const { stdout, rows } = require('../io/term');
const { isChainActive } = require('../dispatch/modes');
const mpool = require('../leaves/pool');
const pt = require('../leaves/pane-tabs');
const route = require('../panel/route');

const MAX_W = 50;
const VIEWPORT = 12;

// `[≡]` glyph geometry — the pane's top row is `╭─(o)[≡]─Title…─╮`.
//   `╭`        col 0
//   `─`        col 1
//   `(o)`      cols 2..4   (hotkey display)
//   `[≡]`      cols 5..7   (trigger glyph)
const TRIGGER_X_OFFSET = 5;
const TRIGGER_VIS_W = 3;

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

/** Flat tab list for a viewer pane — same order/shape as the tab bar.
 *  Mirrors the retired overlay/tab-list#_flatTabs. */
function _flatTabs(paneId) {
  const m = getModel();
  const slice = getInstanceSlice(paneId) || { ephemeralTerminals: {}, contentTabs: {}, tab: 0 };
  const info = pt.flatTabInfo(slice, m, m.currentGroup);
  const out = [
    { section: 'tab', tabIdx: 0, label: 'Info', kind: '' },
    { section: 'tab', tabIdx: 1, label: 'Transcript', kind: '' },
  ];
  info.actionTabs.forEach(([, a], i) => out.push({
    section: 'tab', tabIdx: 2 + i, label: a.label, kind: 'action',
  }));
  const eph = (slice.ephemeralTerminals || {})[m.currentGroup] || {};
  info.termTabs.forEach(([key, t], i) => out.push({
    section: 'tab',
    tabIdx: 2 + info.actionTabs.length + i,
    label: t.label || key,
    kind: 'term',
    closeable: !!eph[key],
    closeKind: 'terminal', closeKey: key,
  }));
  info.contentTabs.forEach(([key, c], i) => {
    let k = 'content';
    if (key.startsWith('docker:')) k = 'docker';
    else if (key.startsWith('file:')) k = 'file';
    out.push({
      section: 'tab',
      tabIdx: 2 + info.actionTabs.length + info.termTabs.length + i,
      label: c.label || key,
      kind: k,
      closeable: true,
      closeKind: 'content', closeKey: key,
    });
  });
  return out;
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
 *  Tabs section (viewers, ≥2 tabs) followed by the Panes section. Flat
 *  concatenation (the user's "flat, column-major" choice) — sections are
 *  distinguishable by row shape, and a flat list keeps cursor / nav /
 *  hit-test free of separator-skipping. */
function items(paneId) {
  if (paneId == null) paneId = _targetPaneId();
  if (!paneId) return [];
  const mode = _viewMode();
  const tabs = _isViewer(paneId) ? _flatTabs(paneId) : [];
  const panes = _paneRows(paneId, mode);
  return [...tabs, ...panes];
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
  return require('../render/geometry').visibleBoundsFor(paneId);
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
  if (_isViewer(paneId)) return _flatTabs(paneId).length >= 2;  // always (Info+Transcript)
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
    if (b.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) continue;
    if (my !== b.y) continue;
    if (mx < b.x + TRIGGER_X_OFFSET) continue;
    if (mx >= b.x + TRIGGER_X_OFFSET + TRIGGER_VIS_W) continue;
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
  const ROWS = rows();
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
  if (it.status === 'here')   return '[dim][here][/]';
  if (it.status === 'hidden') return '[yellow][hidden][/]';
  return `[cyan][in col ${it.columnIndex + 1}][/]`;
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

/** Format a pane row: `  type            [status]`. */
function _formatPaneRow(it, width) {
  const left = `  ${esc(it.type)}`;
  const right = _statusLabel(it);
  const leftVis = visibleLen(left);
  const rightVis = visibleLen(right);
  const inner = Math.max(8, width - 4);
  const padLen = Math.max(1, inner - leftVis - rightVis);
  return `${left}${' '.repeat(padLen)}${right}`;
}

function _formatRow(it, paneId, width) {
  if (it.section === 'tab') {
    const slice = getInstanceSlice(paneId) || {};
    const activeTab = slice.tab || 0;
    return _formatTabRow(it, it.tabIdx === activeTab, width);
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

  const title = _isViewer(paneId) ? 'Tabs' : 'Pane select';
  const lines = [];
  if (g.items.length === 0) {
    lines.push('[dim](no panes — pool is empty)[/]');
  } else {
    const end = Math.min(g.items.length, scroll + g.innerH);
    for (let i = scroll; i < end; i++) {
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
    const { invalidateRows } = require('../render/geometry');
    invalidateRows(g.y + g.h, _lastTop + _lastPanelH);
    for (let y = g.y + g.h; y < _lastTop + _lastPanelH; y++) {
      buf += `\x1b[${y + 1};${g.x + 1}H${' '.repeat(_lastWidth)}`;
    }
  }
  _lastPanelH = g.h;
  _lastTop = g.y;
  _lastLeft = g.x;
  _lastWidth = g.w;
  stdout.write(buf);
}

function _maybeBlank() {
  if (_lastPanelH === 0) return;
  const { invalidateRows } = require('../render/geometry');
  invalidateRows(_lastTop, _lastTop + _lastPanelH);
  _lastPanelH = 0;
}

function _resetRenderState() { _lastPanelH = 0; _lastTop = 0; _lastLeft = 0; _lastWidth = 0; }

module.exports = {
  hitTestTrigger, hitTest, render, items, viewportRows,
  triggerVisible, _triggerState, _flatTabs, _isViewer, _geom,
  _resetRenderState,
};
