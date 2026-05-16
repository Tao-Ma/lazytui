/**
 * Core plugin — history panel.
 *
 * Tracks every action executed through stream.js / actions.js (see
 * ../../history.js for the spec — the ring buffer / hub-backed
 * storage). This file is the *panel* that renders that data.
 *
 * Selecting a row + Enter dumps the captured output back into the
 * detail panel for re-viewing — onKey owns that interaction.
 */
'use strict';

const { S } = require('../../state');
const history = require('../../history');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, decorate,
  getItems: apiGetItems,
} = require('../api');

function getItems() { return history.all(); }

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDuration(entry) {
  if (entry._detached) return '⧉';
  if (entry.endedAt === null) return '⟳';
  const ms = entry.endedAt - entry.startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function statusGlyph(entry) {
  const t = theme();
  if (entry._detached)               return `[${t.dim}]—[/]`;
  if (entry.exitCode === null)       return `[${t.partial}]⟳[/]`;
  if (entry.exitCode === 0)          return `[${t.running}]✓[/]`;
  if (entry.exitCode === 'killed')   return `[${t.partial}]⊗[/]`;
  return `[${t.stopped}]✗[/]`;
}

function getInfo(entry) {
  if (!entry) return [];
  const lines = [`[bold]${esc(entry.label)}[/]`];
  lines.push('', `[dim]started:[/] ${fmtTime(entry.startedAt)}`);
  if (entry.endedAt) lines.push(`[dim]ended:[/]   ${fmtTime(entry.endedAt)} (${fmtDuration(entry)})`);
  lines.push(`[dim]exit:[/]    ${entry._detached ? 'detached' : (entry.exitCode === null ? 'running' : entry.exitCode)}`);
  if (entry.cmd) {
    lines.push('', '[dim]cmd:[/]');
    for (const cl of entry.cmd.split('\n').slice(0, 8)) lines.push(`  ${esc(cl)}`);
  }
  if (entry.output && entry.output.length) {
    lines.push('', `[dim]output (${entry.output.length} lines):[/]`);
    // Show first few; full output is shown on Enter.
    for (const ol of entry.output.slice(0, 12)) lines.push(`  ${esc(ol)}`);
    if (entry.output.length > 12) lines.push('  …');
  }
  return lines;
}

function copyOptions(entry) {
  if (!entry) return [];
  const opts = [
    { label: `Label: ${entry.label}`, content: entry.label },
  ];
  if (entry.cmd) opts.push({ label: 'Command', content: entry.cmd });
  if (entry.output && entry.output.length) {
    opts.push({ label: `Captured output (${entry.output.length} lines)`, content: entry.output.join('\n') });
  }
  return opts;
}

function render(panel, w, h) {
  const items = apiGetItems('history', S);
  const innerW = w - 2;
  const sel = getSel('history');
  const isFocused = S.focus === 'history';
  const lines = items.map((entry, i) => {
    const time = fmtTime(entry.startedAt);
    const dur = fmtDuration(entry).padStart(5, ' ');
    const isSel = i === sel && isFocused;
    const ctx = { panelType: 'history', item: entry, selected: isSel, S };
    const left = decorate('row:left:history', { ...ctx, width: 4 });
    const lhead = left ? `${left} ` : '';
    const gutter = isMultiSel('history', String(entry.startedAt)) ? '*' : ' ';
    let row;
    if (isSel) {
      // Selected row: plain text in [reverse] (no inner markup, see PRINCIPLES §8).
      const plainGlyph = entry._detached ? '—' : entry.exitCode === null ? '⟳' : entry.exitCode === 0 ? '✓' : entry.exitCode === 'killed' ? '⊗' : '✗';
      row = `[${theme().selected}]${gutter}${lhead}${time} ${dur} ${plainGlyph} ${esc(entry.label)}`;
    } else {
      const glyph = statusGlyph(entry);
      row = `${gutter}${lhead}${time} ${dur} ${glyph} ${esc(entry.label)}`;
    }
    const right = decorate('row:right:history', { ...ctx, width: Math.max(0, innerW - visibleLen(row) - 1) });
    return right ? `${row} ${right}` : row;
  });
  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'history',
    focused: isFocused,
    count: items.length ? [sel + 1, items.length] : null,
    scrollOffset: getScroll('history'),
  });
}

/**
 * Enter on a history row: replay the captured output into the detail panel.
 * Prefixed with `$ <label>` like a fresh stream so it reads consistently.
 */
function onKey(key, entry, S) {
  if (!entry) return false;
  if (key === 'return') {
    S.detailLines = [`[dim]$ ${esc(entry.label)}[/]`];
    for (const ol of entry.output || []) S.detailLines.push(esc(ol));
    if (entry._detached) {
      S.detailLines.push('[dim](detached — no captured output)[/]');
    } else if (entry.exitCode === 0) {
      S.detailLines.push('[green]Done.[/]');
    } else if (entry.exitCode !== null) {
      S.detailLines.push(`[red]Exit ${entry.exitCode}[/]`);
    }
    S.detailScroll = 0;
    S.activeTab = 0;
    return true;
  }
  return false;
}

module.exports = {
  panelType: 'history',
  def: {
    mode: 'list', render,
    getItems, getInfo, copyOptions, onKey,
    keyHints: 'Enter view',
    idOf: (entry) => String(entry.startedAt),
  },
};
