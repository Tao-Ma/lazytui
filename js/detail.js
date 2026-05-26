/**
 * Detail panel helpers — info display, tabs, copy mode.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { S, setDetail, getSel } = require('./state');
const { getPanelDef, getItems } = require('./plugins/api');
const { getTabInfo, isTerminalTab, activeContentTab } = require('./tabs');
const { killCurrentProc, streamCommand } = require('./actions');
const { isStreaming } = require('./stream');

function showSelectedInfo() {
  if (S.activeTab !== 0) return;
  // Don't clobber a live stream's output with focused-item info text.
  // Cmdline's mode wrapper calls showSelectedInfo() after every command
  // to reflect focus changes — but for an action that just started a
  // stream, S.detailLines already holds the run header and async output
  // is about to append. Overwriting here produces "info + output" stacks.
  if (isStreaming()) return;
  // Generic dispatch via plugin API. All panels (core + plugin) provide
  // getItems()/getInfo(); getInfo returns markup-ready Rich-formatted lines.
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return;
  const items = getItems(S.focus, S);
  const item = items[getSel(S.focus)];
  if (!item) return;
  const lines = def.getInfo(item);
  if (lines && lines.length) setDetail(lines.join('\n'));
}

function switchToTab(idx) {
  const { actionTabs, termTabs, contentTabs, total } = getTabInfo();
  if (idx < 0 || idx >= total) return;
  // Kill any streaming run-action so its output doesn't bleed into the new tab
  killCurrentProc();
  S.activeTab = idx;
  S.terminalMode = false;
  if (idx === 0) {
    showSelectedInfo();
    return;
  }
  if (idx <= actionTabs.length) {
    // Action tab — stream script output
    const [key, act] = actionTabs[idx - 1];
    streamCommand(key, act.script);
    return;
  }
  if (idx <= actionTabs.length + termTabs.length) {
    // Terminal tab — content rendered by overlay, clear detail lines.
    setDetail('');
    return;
  }
  // Content tab — load cached lines into detail.
  const ct = activeContentTab();
  if (ct) {
    const [, info] = ct;
    setDetail((info.lines || []).join('\n'));
  }
}

function runTab(direction) {
  const { total } = getTabInfo();
  if (total <= 1) return;
  switchToTab((S.activeTab + direction + total) % total);
}

module.exports = { showSelectedInfo, runTab, switchToTab };
