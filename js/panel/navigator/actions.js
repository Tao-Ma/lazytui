/**
 * Core plugin — actions panel.
 *
 * Reads the current group's `actions` map merged with plugin-contributed
 * defaults (e.g. docker plugin synthesizes compose lifecycle actions).
 * Filtering is centrally applied via api.getItems with the
 * `filterText: ([, a]) => a.label` selector.
 */
'use strict';

const { getModel } = require('../../model/store');
const mnav = require('../../leaves/wm/nav');
const {
  esc, theme, renderPanel,
  getSel, getScroll, isMultiSel, getFilter,
  getMergedActions, getItems: apiGetItems,
} = require('../api');

/**
 * Raw [key, action] tuples for the current group. Filtering is applied
 * centrally by api.getItems via `filterText: ([, a]) => a.label`.
 */
function getItems() {
  // Plugin-contributed defaults + YAML overrides via the canonical
  // accessor (v0.6.2). Same merged set the tab strip, leader
  // resolver, and shadow check now read.
  return Object.entries(getMergedActions(getModel().currentGroup));
}

function copyOptions(item) {
  if (!item) return [];
  const [key, action] = item;
  const opts = [
    { label: `Action key: ${key}`, content: key },
    { label: `Label: ${action.label}`, content: action.label },
  ];
  if (action.script) opts.push({ label: 'Resolved script', content: action.script });
  if (action.desc) opts.push({ label: `Description`, content: action.desc });
  return opts;
}

function getInfo(item) {
  if (!item) return [];
  const [, action] = item;
  const lines = [`[bold]${esc(action.label)}[/]`];
  if (action.desc) lines.push('', esc(action.desc), '');
  else lines.push('');
  lines.push(`[dim]type:[/] ${action.type || 'run'}`);
  if (action.args) lines.push(`[dim]args:[/] <${esc(action.args)}>`);
  if (action.confirm) lines.push(`[dim]confirm:[/] ${esc(action.confirm)}`);
  const scriptLines = (action.script || '').trim().split('\n').slice(0, 8);
  lines.push('');
  for (const sl of scriptLines) lines.push(`  ${esc(sl)}`);
  if (scriptLines.length === 8) lines.push('  …');
  return lines;
}

/**
 * Format one action row. Selected rows are plain text in [reverse] (no
 * inner markup — see PRINCIPLES §8); unselected rows use [dim] for the
 * confirm/args annotations.
 */
function actionRow([key, action], i, paneId, isFocused) {
  const tag = { spawn: ' ⧉', background: ' ⇱' }[action.type] || '';
  const isSel = i === getSel(paneId);
  const isMs = isMultiSel(paneId, key);
  // Actions panel is a clean list of what you CAN run. Runtime status
  // (running / completed / killed) lives in the Running overlay
  // (leader j) + the tab strip's ● indicator + feature/history. The
  // per-row `>` marker that used to track lastRunAction was removed
  // along with the lastRunAction field itself (no readers left).
  const mark = isMs ? '*' : ' ';
  const confirmStr = action.confirm ? ' \\[confirm]' : '';
  const argsStr = action.args ? ` <${esc(action.args)}>` : '';
  if (isSel && isFocused) {
    return `[${theme().selected}]${mark} ${esc(action.label)}${tag}${confirmStr}${argsStr}`;
  }
  const confirmDim = action.confirm ? ` [dim]${esc('[confirm]')}[/]` : '';
  const argsDim = action.args ? ` [dim]<${esc(action.args)}>[/]` : '';
  return `${mark} ${esc(action.label)}${tag}${confirmDim}${argsDim}`;
}

function render(panel, w, h, _slice, opts) {
  // v0.6.4 Theme A Phase 5 — per-pane nav reads (panel.paneId) + per-pane
  // focus (opts.focused). actionRow takes both so its row highlight tracks
  // THIS pane. (actions content is global — currentGroup's action set — so
  // multi-instance shares content, but cursor/scroll are now per-pane.)
  const isFocused = !!(opts && opts.focused);
  const actions = apiGetItems(panel.paneId);
  const sel = getSel(panel.paneId);
  const lines = actions.map((item, i) => actionRow(item, i, panel.paneId, isFocused));
  const filterText = getFilter(panel.paneId);
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType: 'actions',
    focused: isFocused,
    count: actions.length ? [sel + 1, actions.length] : null,
    scrollOffset: getScroll(panel.paneId),
    chrome: opts && opts.chrome,
  });
}

// Stateless Component — `actions` is a pure projection of
// model.config.groups[currentGroup].actions + plugin groupActions, with no
// panel-owned domain state. Registered as a Component (rather than a Plugin)
// for API uniformity; the empty slice + no-op update are the cost paid for
// one panel shape. See docs/v0.5-layering.md.
module.exports = {
  name: 'actions',
  // v0.6.1 Phase 3 — single-panel Component, nav stores the entry
  // directly. The shared leaf in leaves/nav.js handles the Msg shapes.
  init: () => ({ nav: mnav.init() }),
  update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
  panelTypes: {
    actions: {
      render,
      getItems, getInfo, copyOptions,
      filterable: true, filterText: ([, a]) => a.label,
      idOf: ([key]) => key,
    },
  },
};
