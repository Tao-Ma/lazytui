/**
 * Core plugin — actions panel.
 *
 * Reads the current group's `actions` map merged with plugin-contributed
 * defaults (e.g. docker plugin synthesizes compose lifecycle actions).
 * Filtering is centrally applied via api.getItems with the
 * `filterText: ([, a]) => a.label` selector.
 */
'use strict';

const { S } = require('../../state');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, getFilter, decorate,
  getGroupActions, getItems: apiGetItems,
} = require('../api');

/**
 * Raw [key, action] tuples for the current group. Filtering is applied
 * centrally by api.getItems via `filterText: ([, a]) => a.label`.
 */
function getItems() {
  const group = S.config.groups[S.currentGroup];
  if (!group) return [];
  // Merge: plugin-contributed actions first (defaults), then YAML actions.
  // YAML keys override plugin keys so users can customize / omit any.
  const merged = {
    ...getGroupActions(group, S.currentGroup),
    ...(group.actions || {}),
  };
  return Object.entries(merged);
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
function actionRow([key, action], i) {
  const tag = { spawn: ' ⧉', background: ' ⇱' }[action.type] || '';
  const isLast = key === S.lastRunAction;
  const isSel = i === getSel('actions');
  const isFocused = S.focus === 'actions';
  const isMs = isMultiSel('actions', key);
  const mark = isMs ? '*' : ((isLast || (isSel && !isFocused)) ? '>' : ' ');
  const confirmStr = action.confirm ? ' \\[confirm]' : '';
  const argsStr = action.args ? ` <${esc(action.args)}>` : '';
  if (isSel && isFocused) {
    return `[${theme().selected}]${mark} ${esc(action.label)}${tag}${confirmStr}${argsStr}`;
  }
  const confirmDim = action.confirm ? ` [dim]${esc('[confirm]')}[/]` : '';
  const argsDim = action.args ? ` [dim]<${esc(action.args)}>[/]` : '';
  return `${mark} ${esc(action.label)}${tag}${confirmDim}${argsDim}`;
}

function render(panel, w, h) {
  const actions = apiGetItems('actions', S);
  const innerW = w - 2;
  const sel = getSel('actions');
  const isFocused = S.focus === 'actions';
  const lines = actions.map((item, i) => {
    const isSel = i === sel && isFocused;
    const ctx = { panelType: 'actions', item, selected: isSel, S };
    const baseRow = actionRow(item, i);
    const left = decorate('row:left:actions', { ...ctx, width: 4 });
    const used = visibleLen(baseRow) + (left ? visibleLen(left) + 1 : 0);
    const right = decorate('row:right:actions', { ...ctx, width: Math.max(0, innerW - used - 1) });
    // actionRow already starts with the mark+space gutter; left content
    // splices in after the gutter (preserve the existing marker pattern
    // so the row formatter doesn't have to learn about decorators).
    const withLeft = left ? `${baseRow.slice(0, 2)}${left} ${baseRow.slice(2)}` : baseRow;
    return right ? `${withLeft} ${right}` : withLeft;
  });
  const filterText = getFilter('actions');
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType: 'actions',
    focused: isFocused,
    count: actions.length ? [sel + 1, actions.length] : null,
    scrollOffset: getScroll('actions'),
  });
}

module.exports = {
  panelType: 'actions',
  def: {
    mode: 'list', render,
    getItems, getInfo, copyOptions,
    filterable: true, filterText: ([, a]) => a.label,
    idOf: ([key]) => key,
  },
};
