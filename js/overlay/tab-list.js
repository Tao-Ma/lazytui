/**
 * Tab list overlay + always-on `[≡]` trigger glyph at the top-left of
 * the detail panel.
 *
 * Anchors to the detail panel's bounds dynamically — works in normal /
 * half / full view because both the trigger and the overlay follow
 * `slice.panelBounds.detail`. The trigger replaces detail's `(o)`
 * hotkey display (cols `detail.x+2..detail.x+4`); the panel's `╭─`
 * corner and `─` separator are preserved.
 *
 * Overlay surface:
 *   - drops down from the trigger row
 *   - width  = min(50, detail.w)
 *   - height = min(tabs.length + 2, rows - detail.y - 3)
 *
 * Row layout (Option C — hybrid):
 *   `* [N]  Label  (kind)`   ← `*` prefix on the ACTIVE tab (slice.tab)
 *   cursor row wears `[reverse]` styling around the whole row text;
 *   when cursor lands on active, both indicators compose (reversed
 *   row still shows the `*`).
 *
 * Slice: `getComponentSlice('detail').tabList = { open, cursor, scroll }`.
 *
 * Lives parallel to overlay/panel-list / overlay/cmdline (dispatch
 * modules don't paint; overlays do).
 */
'use strict';

const { richToAnsi, RESET, esc, visibleLen } = require('../io/ansi');
const { stdout, rows } = require('../io/term');
const { theme } = require('../render/themes');
const { renderPanel } = require('../render/panel');
const { getComponentSlice } = require('../panel/api');
const { getModel } = require('../app/runtime');
const { getTabInfo, getGroupContentTabs } = require('../panel/viewer/tabs');

const MAX_W = 50;
// esc() escapes the literal `[` so richToAnsi doesn't treat `[≡]`
// as an unknown markup tag and EAT the inner glyph (the bug the
// first cut shipped with). Using esc() rather than hardcoding `\[≡]`
// is the convention for ANY literal bracket entering richToAnsi —
// same pattern as overlay/cmdline's _formatMatchLine.
const TRIGGER_GLYPH = esc('[≡]');
const TRIGGER_X_OFFSET = 2;  // after detail's `╭─`
const TRIGGER_VIS_W = 3;     // [, ≡, ]

// Stash so the next render can blank the cells the previous overlay
// occupied (same pattern as overlay/cmdline.js#_lastPanelH).
let _lastPanelH = 0;
let _lastTop = 0;

/** Flat tab list — same order as the tab bar. Each entry:
 *    { tabIdx, label, kind, closeable, closeKind?, closeKey? }
 *  tabIdx is the absolute index (0=Info, then actions, terminals,
 *  content tabs) — the same number `tab_switch` consumes. */
function _flatTabs() {
  const m = getModel();
  const info = getTabInfo();
  const out = [{ tabIdx: 0, label: 'Info', kind: '' }];
  info.actionTabs.forEach(([, a], i) => out.push({
    tabIdx: 1 + i, label: a.label, kind: 'action',
  }));
  const eph = ((getComponentSlice('detail') || {}).ephemeralTerminals || {})[m.currentGroup] || {};
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

/** Detail bounds — null when layout hasn't rendered yet (boot edge). */
function _detailBounds() {
  const l = getComponentSlice('layout');
  return l && l.panelBounds && l.panelBounds.detail;
}

/** Compute overlay geometry from detail bounds + tab count. */
function _geom(tabs) {
  const detailB = _detailBounds();
  if (!detailB) return null;
  const w = Math.min(MAX_W, Math.max(20, detailB.w));
  const ROWS = rows();
  const innerCap = Math.max(1, ROWS - detailB.y - 3);
  const innerH = Math.min(tabs.length, innerCap);
  return {
    x: detailB.x,
    y: detailB.y + 1,
    w,
    innerH,                     // visible rows of the list itself
    h: innerH + 2,              // + top/bottom border
  };
}

/** Rows visible at the top of the overlay's body. Reducer uses this
 *  to keep cursor in [scroll, scroll+vh). */
function viewportRows() {
  const tabs = _flatTabs();
  const g = _geom(tabs);
  return g ? g.innerH : 1;
}

/** Mouse hit-test for the overlay area when open. Returns
 *  { tabIdx, zone: 'label' } if the click lands on a row; null
 *  for clicks on borders / outside the overlay. */
function hitTest(mx, my) {
  const slice = getComponentSlice('detail');
  if (!slice || !slice.tabList || !slice.tabList.open) return null;
  const tabs = _flatTabs();
  const g = _geom(tabs);
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
  // inner digits. Same gotcha as the trigger glyph above; cmdline's
  // _formatMatchLine handles its own display/desc fields the same
  // way.
  const idx = esc(`[${tab.tabIdx}]`);
  const label = esc(tab.label);
  const kind = tab.kind ? `(${tab.kind})` : '';
  // marker(1) + ' '(1) + idx(<= 4) + '  '(2) + label + spaces + kind
  // visibleLen-aware to leave room for kind on the right.
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
 *  repaint cleanly when the overlay shrinks/closes. */
function renderTabList() {
  if (!getModel().modes.tabListMode) {
    _maybeBlank();
    return;
  }
  const slice = getComponentSlice('detail') || {};
  const tabList = slice.tabList || { open: false, cursor: 0, scroll: 0 };
  if (!tabList.open) { _maybeBlank(); return; }
  const tabs = _flatTabs();
  const g = _geom(tabs);
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

/** Bake the `[≡]` trigger into the detail panel's top-border markup so
 *  it rides into paintColumns' single write — eliminates the flicker
 *  class the old paint-on-top suffered (the `[_]` fix's sibling).
 *  Returns the modified panelOutput.
 *
 *  The trigger replaces the `(o)` hotkey display at cols
 *  `detail.x+2..detail.x+4` — both are 3 cells, so the width is
 *  preserved and the right border stays put. We re-emit `[fc]` after
 *  the trigger's `[/]` so the rest of the top row keeps its border
 *  color (the pre-fix paint-on-top didn't touch cells past the glyph,
 *  so they kept fc; a naked `[/]` here would reset them to default).
 *
 *  No-op when:
 *    - panel isn't detail
 *    - detail bounds aren't set or too narrow
 *    - trigger is suppressed (see `_triggerSuppressed`)
 *    - the top row's hotkey display isn't single-char (multi-char
 *      hotkeys would shift the width and aren't worth the complexity
 *      for what is, by convention, always single-char in this codebase)
 */
function injectTabTrigger(panelOutput, p) {
  if (!panelOutput || p.type !== 'detail') return panelOutput;
  const detailB = _detailBounds();
  if (!detailB || detailB.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) return panelOutput;
  if (_triggerSuppressed()) return panelOutput;

  const t = theme();
  const focused = require('../panel/api').getFocus() === 'detail' || getModel().modes.terminalMode;
  const fc = focused ? t.focus : t.dim;
  const isOpen = !!getModel().modes.tabListMode;
  // `reverse` keeps the open-state indication (inverted block) regardless
  // of focus. Otherwise: bright accent when detail is focused, `dim` +
  // color when not — strip the `bold ` prefix from chrome_trigger so the
  // dim attribute composes with the remaining color (bold + dim conflict
  // on most terminals; bold tends to win, defeating the dim).
  const triggerBase = t.chrome_trigger || 'bold cyan';
  const triggerColor = triggerBase.replace(/^bold\s+/, '');
  let triggerOpen;
  if (isOpen)       triggerOpen = '[reverse]';
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
  const m = topRow.match(/^(.*?╭─)\([^)]\)(.*)$/);
  if (!m) return panelOutput;
  return m[1] + triggerMarkup + m[2] + restRows;
}

function _triggerSuppressed() {
  const md = getModel().modes;
  // Suppress in free-config (its own panel-drag gesture lives on this
  // row) and any chain modal that owns the cursor — overlay's own
  // mode is excluded so the trigger keeps its toggle indicator.
  if (md.freeConfigMode) return true;
  if (md.cmdMode || md.confirmMode || md.promptMode || md.menuOpen) return true;
  if (md.filterMode || md.copyMode || md.registerPopupMode || md.detailSearchMode) return true;
  if (md.prefixMode || md.designTitleEditMode) return true;
  return false;
}

/** Hit-test for the trigger click. True if (mx, my) lands on `[≡]`. */
function isTriggerHit(mx, my) {
  if (_triggerSuppressed()) return false;
  const detailB = _detailBounds();
  if (!detailB) return false;
  if (detailB.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) return false;
  return my === detailB.y
      && mx >= detailB.x + TRIGGER_X_OFFSET
      && mx < detailB.x + TRIGGER_X_OFFSET + TRIGGER_VIS_W;
}

function _resetRenderState() { _lastPanelH = 0; _lastTop = 0; }

module.exports = {
  renderTabList, injectTabTrigger, hitTest, isTriggerHit,
  viewportRows, _resetRenderState,
  // Exposed for tests
  _flatTabs, _geom,
};
