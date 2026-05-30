/**
 * Detail panel helpers — info display, tabs, copy mode.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { setDetail, getSel } = require('./state');
const { getModel } = require('./runtime');
const { getPanelDef, getItems, getComponentSlice } = require('./plugins/api');
const { getTabInfo, isTerminalTab, activeContentTab } = require('./tabs');
const { killCurrentProc, streamCommand } = require('./actions');
const { isStreaming } = require('./stream');

// `model` is the threaded owned model. showSelectedInfo defaults to
// getModel() because it's called from many not-yet-threaded sites
// (mode handlers, redraw).
function showSelectedInfo(model = getModel()) {
  const detailSlice = getComponentSlice('detail');
  if (detailSlice && detailSlice.tab !== 0) return;
  // Don't clobber a live stream's output with focused-item info text.
  // Cmdline's mode wrapper calls showSelectedInfo() after every command
  // to reflect focus changes — but for an action that just started a
  // stream, the detail body already holds the run header and async output
  // is about to append. Overwriting here produces "info + output" stacks.
  if (isStreaming()) return;
  // Generic dispatch via plugin API. All panels (core + plugin) provide
  // getItems()/getInfo(); getInfo returns markup-ready Rich-formatted lines.
  const def = getPanelDef(model.focus);
  if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return;
  const items = getItems(model.focus);
  const item = items[getSel(model.focus)];
  if (!item) return;
  const lines = def.getInfo(item);
  if (lines && lines.length) setDetail(lines.join('\n'));
}

function switchToTab(model, idx) {
  const { actionTabs, termTabs, contentTabs, total } = getTabInfo();
  if (idx < 0 || idx >= total) return;
  // Kill any streaming run-action so its output doesn't bleed into the new tab
  killCurrentProc();
  // viewer_set_tab → detail Component (dispatchMsg); terminal_exit stays a
  // root-reducer Msg (applyMsg). The latter also emits force_full_repaint Cmd
  // when viewMode was 'full' so the layout reclaims rows.
  require('./plugins/api').dispatchMsg({ type: 'viewer_set_tab', tab: idx });
  require('./dispatch').applyMsg(model, { type: 'terminal_exit' });
  if (idx === 0) {
    showSelectedInfo(model);
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

function runTab(model, direction) {
  const { total } = getTabInfo();
  if (total <= 1) return;
  const tab = getComponentSlice('detail')?.tab || 0;
  switchToTab(model, (tab + direction + total) % total);
}

module.exports = { showSelectedInfo, runTab, switchToTab };
