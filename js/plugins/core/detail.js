/**
 * Core plugin — detail panel.
 *
 * Content panel (mode: 'content'); no list semantics. Owns the tab
 * title bar (Info | action tabs | terminal tabs), tab click bounds
 * (published into S.panelBounds.detail.tabs for the mouse handler),
 * and a `tab:<labelSlug>` decorator slot per tab so plugins can
 * append markers (e.g. an error count next to a Logs tab).
 *
 * Tab click bounds — published into S.panelBounds.detail.tabs as
 * an array of `{ tabIdx, x, w }` (panel-relative columns) during
 * detailTitle(). input.js's mouse handler reads them from S, so the
 * detail panel doesn't have to expose a private getter back across
 * the plugin/host boundary. Same pattern as the per-panel x/y/w/h
 * bounds.
 */
'use strict';

const { S } = require('../../state');
const { getTabInfo, isTerminalTab } = require('../../tabs');
const {
  esc, visibleLen, renderPanel, decorate,
} = require('../api');

function tabSlot(label) {
  return 'tab:' + label.toLowerCase().replace(/\s+/g, '-');
}

function detailTitle() {
  const tabBounds = [];
  const { actionTabs, termTabs } = getTabInfo();
  // Always publish bounds (empty when "Detail" is the only label).
  // input.js iterates the array; an empty array is a clean no-op.
  if (S.panelBounds.detail) S.panelBounds.detail.tabs = tabBounds;
  if (!actionTabs.length && !termTabs.length) return 'Detail';
  const parts = [];
  // Each tab label can be augmented by `tab:<labelSlug>` decorators
  // (e.g. `tab:logs` could append an error count). Plugin handlers
  // return plain text or Rich markup; the tab title is not embedded
  // in [reverse], so markup is safe.
  const pushTab = (label, isActive, item) => {
    const extra = decorate(tabSlot(label), { tabId: tabSlot(label), item, active: isActive, S });
    const text = extra ? `${esc(label)} ${extra}` : esc(label);
    parts.push(isActive ? `\\[${text}]` : text);
  };
  pushTab('Info', S.activeTab === 0, null);
  actionTabs.forEach(([, action], i) => pushTab(action.label, S.activeTab === i + 1, action));
  const termOffset = 1 + actionTabs.length;
  termTabs.forEach(([, term], i) => pushTab(term.label, S.activeTab === termOffset + i, term));
  // Compute click bounds for each tab (panel-relative cols).
  // Title bar layout: ╭─(hotkey)─titleText───╮
  const dp = S.layout.rightPanels.find(p => p.type === 'detail');
  const hotkey = dp ? dp.hotkey : '';
  let xOffset = 2 + (hotkey ? 2 + hotkey.length : 0) + 1; // ╭─(N)─
  parts.forEach((part, i) => {
    if (i > 0) xOffset += 1; // ─ separator
    const visLen = visibleLen(part);
    tabBounds.push({ tabIdx: i, x: xOffset, w: visLen });
    xOffset += visLen;
  });
  return parts.join('─');
}

function render(panel, w, h) {
  const innerH = h - 2;
  const dp = S.layout.rightPanels.find(p => p.type === 'detail');
  const hotkey = dp ? dp.hotkey : '';
  const isFocused = S.focus === 'detail' || S.terminalMode;
  if (isTerminalTab()) {
    return renderPanel({
      width: w, height: h, lines: [],
      title: detailTitle(), hotkey,
      panelType: 'detail',
      focused: isFocused,
    });
  }
  let count = null;
  if (S.detailLines.length > innerH) {
    count = [S.detailScroll + innerH, S.detailLines.length];
  }
  // When a selection is active in this panel, weave [reverse] into the
  // intersected lines. decorateLines is a no-op when S.select.active is
  // false, so steady-state renders pay no cost.
  const lines = require('../../select').decorateLines(S.detailLines);
  return renderPanel({
    width: w, height: h, lines,
    title: detailTitle(), hotkey,
    panelType: 'detail',
    focused: isFocused,
    count,
    scrollOffset: S.detailScroll,
  });
}

module.exports = {
  panelType: 'detail',
  def: { mode: 'content', render },
};
