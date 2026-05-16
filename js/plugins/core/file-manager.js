/**
 * Core plugin — file-manager panel.
 *
 * Reads `S.config.files` (the project's declared file registry — see
 * top-level `files:` in the YAML). The "File contents" copy option
 * uses an async thunk so reading large files only happens when the
 * user actually picks the option, and doesn't block the event loop
 * while doing so.
 */
'use strict';

const { S } = require('../../state');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, getFilter, decorate,
  getItems: apiGetItems,
} = require('../api');

/** Raw files list; filtering applied centrally by api.getItems. */
function getItems() {
  return S.config.files || [];
}

function copyOptions(item) {
  if (!item) return [];
  // Lazy require keeps fs.promises out of the module-load critical path.
  const fsp = require('fs').promises;
  const opts = [
    { label: `Path: ${item.path}`, content: item.path },
  ];
  if (item.var) opts.push({ label: `Var: $${item.var}`, content: item.var });
  // Lazy + async — read on user pick, doesn't block event loop
  opts.push({
    label: 'File contents',
    content: () => fsp.readFile(item.path, 'utf8').catch(() => ''),
  });
  return opts;
}

function getInfo(item) {
  if (!item) return [];
  const lines = [`[bold]${esc(item.path)}[/]`];
  if (item.desc) lines.push('', esc(item.desc), '');
  if (item.var) lines.push(`[dim]var:[/] $${esc(item.var)}`);
  if (item.exclude && item.exclude.length) {
    lines.push(`[dim]exclude:[/] ${esc(item.exclude.join(', '))}`);
  }
  return lines;
}

function render(panel, w, h) {
  const cfiles = apiGetItems('file-manager', S);
  const innerW = w - 2;
  const sel = getSel('file-manager');
  const isFocused = S.focus === 'file-manager';
  const maxPathLen = w - 5;
  const lines = cfiles.map((cf, i) => {
    let p = cf.path;
    if (p.length > maxPathLen) p = '…' + p.slice(-(maxPathLen - 1));
    const isSel = i === sel && isFocused;
    const ctx = { panelType: 'file-manager', item: cf, selected: isSel, S };
    const left  = decorate('row:left:file-manager',  { ...ctx, width: 4 });
    const pathLen = p.length;
    const gutterLen = 2;
    const used = gutterLen + (left ? visibleLen(left) + 1 : 0) + pathLen;
    const right = decorate('row:right:file-manager', { ...ctx, width: Math.max(0, innerW - used - 1) });
    const lhead = left  ? `${left} `  : '';
    const rtail = right ? ` ${right}` : '';
    const gutter = isMultiSel('file-manager', cf.path) ? '* ' : '  ';
    const base = isSel ? `[${theme().selected}]${gutter}${lhead}${p}${rtail}` : `${gutter}${lhead}${p}${rtail}`;
    return base;
  });
  const filterText = getFilter('file-manager');
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType: 'file-manager',
    focused: isFocused,
    count: cfiles.length ? [sel + 1, cfiles.length] : null,
    scrollOffset: getScroll('file-manager'),
  });
}

module.exports = {
  panelType: 'file-manager',
  def: {
    mode: 'list', render,
    getItems, getInfo, copyOptions,
    filterable: true, filterText: cf => cf.path,
    idOf: (cf) => cf.path,
  },
};
