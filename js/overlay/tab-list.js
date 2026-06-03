/**
 * Tab list overlay + always-on `[≡]` trigger glyph at the top-left of
 * the pane that hosts a tab strip.
 *
 * Parameterised by `paneId` (default 'detail' for the singleton Phase 2
 * caller). Every read — slice, panel bounds, flat tab list — keys on
 * paneId. Phase 4 retargets the call sites to feed real pane ids;
 * the overlay itself stops caring about which pane it's drawing for.
 *
 * Anchors dynamically — works in normal / half / full view because both
 * the trigger and the overlay follow `panelBounds[paneId]`. The trigger
 * replaces the pane's `(o)` hotkey display (cols x+2..x+4); the panel's
 * `╭─` corner and `─` separator are preserved.
 *
 * Overlay surface:
 *   - drops down from the trigger row
 *   - width  = min(50, pane.w)
 *   - height = min(tabs.length + 2, rows - pane.y - 3)
 *
 * Row layout (Option C — hybrid):
 *   `* [N]  Label  (kind)`   ← `*` prefix on the ACTIVE tab (slice.tab)
 *   cursor row wears `[reverse]` styling around the whole row text;
 *   when cursor lands on active, both indicators compose.
 *
 * Slice: `getInstanceSlice(paneId).tabList = { open, cursor, scroll }`.
 *
 * Lives parallel to overlay/panel-list / overlay/cmdline (dispatch
 * modules don't paint; overlays do).
 */
'use strict';

const { richToAnsi, RESET, esc, visibleLen } = require('../io/ansi');
const { stdout, rows } = require('../io/term');
const { theme } = require('../render/themes');
const { renderPanel } = require('../render/panel');
const { getInstanceSlice } = require('../panel/api');
const { getModel } = require('../app/runtime');
const pt = require('../leaves/pane-tabs');

const MAX_W = 50;
// esc() escapes the literal `[` so richToAnsi doesn't treat `[≡]`
// as an unknown markup tag and EAT the inner glyph (the bug the
// first cut shipped with). Using esc() rather than hardcoding `\[≡]`
// is the convention for ANY literal bracket entering richToAnsi —
// same pattern as overlay/cmdline's _formatMatchLine.
const TRIGGER_GLYPH = esc('[≡]');
// Pane's top row is `╭─(o)[≡]─Title─…─╮`. Hotkey stays in the
// conventional first position; the trigger sits immediately after.
//   `╭`           col 0
//   `─`           col 1
//   `(o)`         cols 2..4   (hotkey display, 3 cells)
//   `[≡]`         cols 5..7   (trigger glyph, 3 cells)
//   `─Title…─╮`   col 8…
// The 3-cell trigger displaces 3 trailing fill dashes before `╮` so
// the panel border stays the same width as without the trigger.
const TRIGGER_X_OFFSET = 5;  // after the pane's `╭─(o)`
const TRIGGER_VIS_W = 3;     // [, ≡, ]

// Stash so the next render can blank the cells the previous overlay
// occupied (same pattern as overlay/cmdline.js#_lastPanelH). Single
// stash — Phase 2 only ever renders one tab-list at a time. If Phase
// 4+ allows multiple open overlays, this grows to a per-paneId map.
let _lastPanelH = 0;
let _lastTop = 0;

/** Flat tab list — same order as the tab bar. Each entry:
 *    { tabIdx, label, kind, closeable, closeKind?, closeKey? }
 *  tabIdx is the absolute index (0=Info, then actions, terminals,
 *  content tabs) — the same number `tab_switch` consumes. */
function _flatTabs(paneId = 'detail') {
  const m = getModel();
  const slice = getInstanceSlice(paneId) || { ephemeralTerminals: {}, contentTabs: {}, tab: 0 };
  const info = pt.flatTabInfo(slice, m, m.currentGroup);
  const out = [{ tabIdx: 0, label: 'Info', kind: '' }];
  info.actionTabs.forEach(([, a], i) => out.push({
    tabIdx: 1 + i, label: a.label, kind: 'action',
  }));
  const eph = (slice.ephemeralTerminals || {})[m.currentGroup] || {};
  info.termTabs.forEach(([key, t], i) => out.push({
    tabIdx: 1 + info.actionTabs.length + i,
    label: t.label || key,
    kind: 'term',
    closeable: !!eph[key],          // YAML-declared terminals not closeable
    closeKind: 'terminal', closeKey: key,
  }));
  info.contentTabs.forEach(([key, c], i) => {
    let k = 'content';
    if (key.startsWith('docker:')) k = 'docker';
    else if (key.startsWith('file:')) k = 'file';
    out.push({
      tabIdx: 1 + info.actionTabs.length + info.termTabs.length + i,
      label: c.label || key,
      kind: k,
      closeable: true,
      closeKind: 'content', closeKey: key,
    });
  });
  return out;
}

/** Pane bounds — null when layout hasn't rendered yet (boot edge). */
function _paneBounds(paneId = 'detail') {
  const l = getInstanceSlice('layout');
  return l && l.panelBounds && l.panelBounds[paneId];
}

/** Owner pane id companion to model.modes.tabListMode. The pane-tabs
 *  reducer writes it on tab_list_open/close. Falls back to 'detail'
 *  during the boot edge before layout's first paint (the singleton
 *  default; harmless for Phase 4). */
function _ownerPaneId() {
  const l = getInstanceSlice('layout');
  return (l && l.tabListOwnerPaneId) || 'detail';
}

/** Compute overlay geometry from pane bounds + tab count. */
function _geom(tabs, paneId = 'detail') {
  const paneB = _paneBounds(paneId);
  if (!paneB) return null;
  const w = Math.min(MAX_W, Math.max(20, paneB.w));
  const ROWS = rows();
  const innerCap = Math.max(1, ROWS - paneB.y - 3);
  const innerH = Math.min(tabs.length, innerCap);
  return {
    x: paneB.x,
    y: paneB.y + 1,
    w,
    innerH,                     // visible rows of the list itself
    h: innerH + 2,              // + top/bottom border
  };
}

/** Rows visible at the top of the overlay's body. Reducer uses this
 *  to keep cursor in [scroll, scroll+vh). */
function viewportRows(paneId = 'detail') {
  const tabs = _flatTabs(paneId);
  const g = _geom(tabs, paneId);
  return g ? g.innerH : 1;
}

/** Mouse hit-test for the overlay area when open. Returns
 *  { tabIdx, zone: 'label' } if the click lands on a row; null
 *  for clicks on borders / outside the overlay. */
function hitTest(mx, my, paneId = 'detail') {
  const slice = getInstanceSlice(paneId);
  if (!slice || !slice.tabList || !slice.tabList.open) return null;
  const tabs = _flatTabs(paneId);
  const g = _geom(tabs, paneId);
  if (!g) return null;
  if (mx < g.x || mx >= g.x + g.w) return null;
  if (my < g.y || my >= g.y + g.h) return null;
  // Top/bottom border rows are inert.
  if (my === g.y || my === g.y + g.h - 1) return null;
  const rowIdx = (my - g.y - 1) + (slice.tabList.scroll || 0);
  const tab = tabs[rowIdx];
  if (!tab) return null;
  return { tabIdx: tab.tabIdx, zone: 'label' };
}

/** Format one row as a rich-markup string the panel renderer can chew.
 *  Reverse-video styling is applied at the line level by the caller
 *  (the panel renderer composes the [reverse]…[/] wrapper around the
 *  whole row so border + padding pick up the highlight cleanly). */
function _formatRow(tab, isActive, width) {
  const marker = isActive ? '*' : ' ';
  // esc() escapes the `[` so richToAnsi renders `[N]` literally
  // instead of treating it as an unknown markup tag and EATING the
  // inner digits. Same gotcha as the trigger glyph above.
  const idx = esc(`[${tab.tabIdx}]`);
  const label = esc(tab.label);
  const kind = tab.kind ? `(${tab.kind})` : '';
  const left = `${marker} ${idx}  ${label}`;
  const leftVis = visibleLen(left);
  const kindVis = visibleLen(kind);
  // Available width inside the panel is (w - 4) — 2 border cells + 2
  // padding cells the renderPanel module reserves around content.
  const inner = Math.max(8, width - 4);
  if (kindVis === 0) return left;
  const padLen = Math.max(1, inner - leftVis - kindVis);
  return `${left}${' '.repeat(padLen)}${kind}`;
}

/** Paint the overlay if `tabListMode` is active. Drops residue
 *  invalidation for the previous frame so panels behind the overlay
 *  repaint cleanly when the overlay shrinks/closes.
 *
 *  v0.6.1 Phase 4 — owner pane id is read from
 *  `layout.tabListOwnerPaneId` (written in lockstep with tabListMode).
 *  The optional `paneId` arg overrides for tests / future explicit
 *  callers; default falls through to the layout-slice companion. */
function renderTabList(paneId) {
  if (!getModel().modes.tabListMode) {
    _maybeBlank();
    return;
  }
  if (paneId == null) paneId = _ownerPaneId();
  const slice = getInstanceSlice(paneId) || {};
  const tabList = slice.tabList || { open: false, cursor: 0, scroll: 0 };
  if (!tabList.open) { _maybeBlank(); return; }
  const tabs = _flatTabs(paneId);
  const g = _geom(tabs, paneId);
  if (!g) { _maybeBlank(); return; }
  const scroll = Math.max(0, Math.min(tabList.scroll || 0, Math.max(0, tabs.length - g.innerH)));
  const cursor = Math.max(0, Math.min(tabList.cursor || 0, tabs.length - 1));
  const activeTab = slice.tab || 0;

  const lines = [];
  for (let i = 0; i < g.innerH; i++) {
    const rowIdx = scroll + i;
    const tab = tabs[rowIdx];
    if (!tab) { lines.push(''); continue; }
    const isActive = tab.tabIdx === activeTab;
    const text = _formatRow(tab, isActive, g.w);
    if (rowIdx === cursor) lines.push(`[reverse]${text}[/]`);
    else                   lines.push(text);
  }

  const content = renderPanel({
    width: g.w, height: g.h, lines,
    title: 'Tabs', focused: true,
    count: [cursor + 1, tabs.length],
  });
  const panelLines = content.split('\n');
  let buf = '';
  for (let i = 0; i < panelLines.length; i++) {
    buf += `\x1b[${g.y + i + 1};${g.x + 1}H` + richToAnsi(panelLines[i]) + RESET;
  }
  // Residue-blank rows the prior frame painted but this one doesn't.
  if (_lastPanelH > g.h && _lastTop === g.y) {
    const { invalidateRows } = require('../render/layout');
    invalidateRows(g.y + g.h, _lastTop + _lastPanelH);
    for (let y = g.y + g.h; y < _lastTop + _lastPanelH; y++) {
      buf += `\x1b[${y + 1};${g.x + 1}H${' '.repeat(g.w)}`;
    }
  }
  _lastPanelH = g.h;
  _lastTop = g.y;
  stdout.write(buf);
}

function _maybeBlank() {
  if (_lastPanelH === 0) return;
  const { invalidateRows } = require('../render/layout');
  invalidateRows(_lastTop, _lastTop + _lastPanelH);
  _lastPanelH = 0;
}

/** Bake the `[≡]` trigger into a pane's top-border markup so it rides
 *  into paintColumns' single write — eliminates the flicker class the
 *  old paint-on-top suffered. Returns the modified panelOutput.
 *
 *  The trigger is inserted immediately after `(o)` (the hotkey display),
 *  so the row reads `╭─(o)[≡]─Title─…─╮`. To absorb the trigger's 3
 *  visible cells without widening the panel, 3 trailing fill dashes
 *  are eaten from before the right corner. `[fc]` is re-emitted after
 *  the trigger's `[/]` so the rest of the top row keeps its border
 *  color.
 *
 *  No-op when:
 *    - panelOutput is empty
 *    - the panel entry isn't the target pane (p.type !== paneId)
 *    - pane bounds aren't set or are too narrow
 *    - trigger is suppressed (free-config / chain modals)
 *    - the top row's hotkey display isn't single-char
 *    - the top row has fewer than 3 trailing fill dashes
 */
function injectTabTrigger(panelOutput, p, paneId = 'detail') {
  if (!panelOutput || p.type !== paneId) return panelOutput;
  const paneB = _paneBounds(paneId);
  if (!paneB || paneB.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) return panelOutput;
  if (_triggerSuppressed()) return panelOutput;

  const t = theme();
  const focused = require('../panel/api').getFocus() === paneId || getModel().modes.terminalMode;
  const fc = focused ? t.focus : t.dim;
  const isOpen = !!getModel().modes.tabListMode;
  // `reverse` keeps the open-state indication (inverted block) regardless
  // of focus. Otherwise: bright accent when focused, `dim` + color when
  // not — strip the `bold ` prefix from chrome_trigger so the dim
  // attribute composes with the remaining color (bold + dim conflict
  // on most terminals; bold tends to win, defeating the dim).
  // free-config mode renders the trigger DISABLED (greyed) — the
  // affordance stays visible so the user knows the tab-list exists,
  // but click on the glyph falls through to the panel-drag gesture
  // that owns the top-border row (see isTriggerHit).
  const triggerBase = t.chrome_trigger || 'bold cyan';
  const triggerColor = triggerBase.replace(/^bold\s+/, '');
  const disabled = _triggerDisabled();
  let triggerOpen;
  if (disabled)     triggerOpen = '[dim]';
  else if (isOpen)  triggerOpen = '[reverse]';
  else if (focused) triggerOpen = `[${triggerBase}]`;
  else              triggerOpen = `[dim][${triggerColor}]`;
  const triggerMarkup = `${triggerOpen}${TRIGGER_GLYPH}[/][${fc}]`;

  const nlIdx = panelOutput.indexOf('\n');
  const topRow  = nlIdx >= 0 ? panelOutput.slice(0, nlIdx) : panelOutput;
  const restRows = nlIdx >= 0 ? panelOutput.slice(nlIdx) : '';

  // Match `╭─(X)` right after the opening color tag — `X` is a single
  // hotkey char (the convention; renderPanel writes `(${hotkey})` from
  // a positionally-assigned single-letter key). Lazy `.*?` lets m[1]
  // grow until the first `╭─\(.\)` matches.
  const m = topRow.match(/^(.*?╭─)(\([^)]\))(.*)$/);
  if (!m) return panelOutput;
  // Eat 3 trailing fill dashes from before `╮` to absorb the trigger's
  // 3 visible cells. If there aren't 3 spare dashes, fall back to the
  // old "replace (o) with [≡]" behavior — the hotkey display is the
  // less essential of the two when there's no room for both.
  const after = m[3];
  const cornerIdx = after.indexOf('╮');
  if (cornerIdx >= 3
      && after[cornerIdx - 1] === '─'
      && after[cornerIdx - 2] === '─'
      && after[cornerIdx - 3] === '─') {
    const trimmed = after.slice(0, cornerIdx - 3) + after.slice(cornerIdx);
    return m[1] + m[2] + triggerMarkup + trimmed + restRows;
  }
  // Fallback: too narrow / title too long — replace (o) with [≡] so we
  // still get the trigger at the cost of hiding the hotkey label.
  return m[1] + triggerMarkup + after + restRows;
}

function _triggerSuppressed() {
  // Reserved for genuine "the glyph would be physically obscured by
  // another paint" cases. Today nothing qualifies — none of the
  // overlay modes paint over detail's top border (cmdline / filter
  // / detail-search live in the footer row; menu / confirm /
  // prompt / copy / register-popup / which-key are centered popups
  // that don't reach the top border). Kept as a hook so a future
  // overlay that DOES cover the top row can flip it true.
  return false;
}

/** True when the trigger is rendered but disabled (greyed, no
 *  click). Any modal mode that owns user input — free-config (its
 *  own panel-drag gesture lives on this row), cmdline / filter /
 *  detail-search (typing into a prompt), centered popups (menu /
 *  confirm / prompt / copy / register), prefix chain, free-config
 *  title-edit — disables the click while leaving the glyph visible
 *  so the user keeps the affordance hint. Click falls through to
 *  whatever else owns the row (or is a no-op). */
function _triggerDisabled() {
  const md = getModel().modes;
  if (md.freeConfigMode || md.freeConfigTitleEditMode) return true;
  if (md.cmdMode || md.filterMode || md.detailSearchMode) return true;
  if (md.confirmMode || md.promptMode || md.menuOpen) return true;
  if (md.copyMode || md.registerPopupMode) return true;
  if (md.prefixMode) return true;
  return false;
}

/** Hit-test for the trigger click. True if (mx, my) lands on `[≡]`.
 *  Disabled (free-config) and suppressed (modal overlays) both
 *  return false so the click falls through to whatever else owns
 *  that row. */
function isTriggerHit(mx, my, paneId = 'detail') {
  if (_triggerSuppressed() || _triggerDisabled()) return false;
  const paneB = _paneBounds(paneId);
  if (!paneB) return false;
  if (paneB.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) return false;
  return my === paneB.y
      && mx >= paneB.x + TRIGGER_X_OFFSET
      && mx < paneB.x + TRIGGER_X_OFFSET + TRIGGER_VIS_W;
}

function _resetRenderState() { _lastPanelH = 0; _lastTop = 0; }

module.exports = {
  renderTabList, injectTabTrigger, hitTest, isTriggerHit,
  viewportRows, _resetRenderState,
  // Exposed for tests
  _flatTabs, _geom,
};
