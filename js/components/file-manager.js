/**
 * Core plugin — legacy `file-manager` panel (VERBATIM v0.3.0 behavior).
 *
 * The v0.3.0 declared-registry panel. Preserved unchanged so YAMLs with
 * `type: file-manager` see ZERO behavioral difference: substring filter,
 * no onKey, decorate-based row chrome, no shared cwd state, no fs browsing.
 *
 * The unified filesystem/registry/docker browser (`type: files` and the
 * `file-browser` alias) lives in js/components/files.js as a Component — this
 * file is only the back-compat alias. Users wanting the new declared-list
 * behavior should migrate to `type: files, source: declared`.
 */
'use strict';

const { getModel } = require('../runtime');
const mnav = require('../model-nav');
const {
  esc, theme, renderPanel,
  getSel, getScroll, getFilter, isMultiSel,
  getItems: apiGetItems,
  getComponentSlice, getFocus,
} = require('./api');

function _getItems() {
  const cfg = getModel().config;
  return (cfg && cfg.files) || [];
}

function _getInfo(item) {
  if (!item) return [];
  const lines = [`[bold]${esc(item.path)}[/]`];
  if (item.desc) lines.push('', esc(item.desc), '');
  if (item.var) lines.push(`[dim]var:[/] $${esc(item.var)}`);
  if (item.exclude && item.exclude.length) {
    lines.push(`[dim]exclude:[/] ${esc(item.exclude.join(', '))}`);
  }
  return lines;
}

function _copyOptions(item) {
  if (!item) return [];
  const fsp = require('fs').promises;
  const opts = [
    { label: `Path: ${item.path}`, content: item.path },
  ];
  if (item.var) opts.push({ label: `Var: $${item.var}`, content: item.var });
  opts.push({
    label: 'File contents',
    content: () => fsp.readFile(item.path, 'utf8').catch(() => ''),
  });
  return opts;
}

function _render(panel, w, h) {
  const cfiles = apiGetItems('file-manager');
  const sel = getSel('file-manager');
  const isFocused = getFocus() === 'file-manager';
  const maxPathLen = w - 5;
  const lines = cfiles.map((cf, i) => {
    let p = cf.path;
    if (p.length > maxPathLen) p = '…' + p.slice(-(maxPathLen - 1));
    const isSel = i === sel && isFocused;
    const gutter = isMultiSel('file-manager', cf.path) ? '* ' : '  ';
    return isSel ? `[${theme().selected}]${gutter}${p}` : `${gutter}${p}`;
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

// Stateless Component — the legacy v0.3 file-manager is a pure projection of
// model.config.files. No panel-owned domain state; empty-slice + no-op update
// are the API-uniformity cost. See docs/v0.5-layering.md.
module.exports = {
  name: 'file-manager',
  // Phase 4a — nav chrome on the slice; shared leaf handles the five Msgs.
  init: () => ({ nav: { 'file-manager': mnav.init() } }),
  update: (msg, slice) => mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : slice,
  panelTypes: {
    'file-manager': {      render: _render,
      getItems: _getItems,
      getInfo: _getInfo,
      copyOptions: _copyOptions,
      filterable: true,
      filterText: (cf) => cf.path,
      idOf: (cf) => cf.path,
    },
  },
};
