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

const { setViewerContent } = require('../nav-state');
const { getModel } = require('../../model/store');
const history = require('../../feature/history');
const mnav = require('../../leaves/nav');
const {
  esc, theme, renderPanel,
  getSel, getScroll, isMultiSel,
  getItems: apiGetItems,
  getInstanceSlice, getFocus, instanceKind,
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

function render(panel, w, h, _slice, opts) {
  // v0.6.4 Theme A Phase 5 — per-pane nav reads (panel.paneId) + per-pane
  // focus (opts.focused). history content is a global ring buffer, so
  // multi-instance shares content; cursor/scroll/multiSel are per-pane.
  const items = apiGetItems(panel.paneId, null);
  const sel = getSel(panel.paneId);
  const isFocused = !!(opts && opts.focused);
  const lines = items.map((entry, i) => {
    const time = fmtTime(entry.startedAt);
    const dur = fmtDuration(entry).padStart(5, ' ');
    const isSel = i === sel && isFocused;
    const gutter = isMultiSel(panel.paneId, String(entry.startedAt)) ? '*' : ' ';
    if (isSel) {
      // Selected row: plain text in [reverse] (no inner markup, see PRINCIPLES §8).
      const plainGlyph = entry._detached ? '—' : entry.exitCode === null ? '⟳' : entry.exitCode === 0 ? '✓' : entry.exitCode === 'killed' ? '⊗' : '✗';
      return `[${theme().selected}]${gutter}${time} ${dur} ${plainGlyph} ${esc(entry.label)}`;
    }
    const glyph = statusGlyph(entry);
    return `${gutter}${time} ${dur} ${glyph} ${esc(entry.label)}`;
  });
  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'history',
    focused: isFocused,
    count: items.length ? [sel + 1, items.length] : null,
    scrollOffset: getScroll(panel.paneId),
    chrome: opts && opts.chrome,
  });
}

/**
 * Build the replay-content lines for a history entry. Pure — used by the
 * historyReplay effect on Enter.
 */
function _replayLines(entry) {
  const lines = [`[dim]$ ${esc(entry.label)}[/]`];
  for (const ol of entry.output || []) lines.push(esc(ol));
  if (entry._detached) {
    lines.push('[dim](detached — no captured output)[/]');
  } else if (entry.exitCode === 0) {
    lines.push('[green]Done.[/]');
  } else if (entry.exitCode !== null) {
    lines.push(`[red]Exit ${entry.exitCode}[/]`);
  }
  return lines;
}

// Stateless Component — `history` is a render over the module-private ring
// buffer (../../history.js). The buffer is its own decentralized state home
// (written by stream.js when actions finish); the panel is just the reader.
// Enter on a row replays the captured output into the viewer — that side
// effect is the only thing update() needs to fire.
function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type !== 'key' || msg.key !== 'return') return slice;
  if (instanceKind(getFocus()) !== 'history') return slice;
  const entry = history.all()[getSel('history')];
  // Claim `return` even with no entry — the framework's run_selected
  // default (viewer_show_info) would just re-render the same Info pane
  // we're already on.
  if (!entry) return [slice, [{ type: '_claimed' }]];
  return [slice, [{ type: 'historyReplay', entry }, { type: '_claimed' }]];
}

/** Called from registerComponent after init(). Moving these out of
 *  module-top-level means test lifecycles that clear+reinstall effects
 *  can re-register the per-Component handlers without re-requiring the
 *  file (which would no-op due to module caching). */
function installEffects(registerEffect) {
  registerEffect('historyReplay', (eff) => {
    // v0.6.2 R6 — single dispatch via the extended viewer_set_content
    // (opts.tab=0 lands the user on Info in the same reducer pass that
    // sets the override). Pre-R6 this was two imperative dispatches
    // (setViewerContent + setActiveTab) — handler-orchestrated cascade,
    // visible to the reducer only as two unrelated Msgs.
    setViewerContent(null, _replayLines(eff.entry).join('\n'), { tab: 0 });
  });
}

module.exports = {
  name: 'history',
  // v0.6.1 Phase 3 — single-panel Component, nav stores the entry directly.
  init: () => ({ nav: mnav.init() }),
  update,
  installEffects,
  panelTypes: {
    history: {
      render,
      getItems, getInfo, copyOptions,
      // Enter is handled in update() — claimed via the `_claimed`
      // sentinel effect so run_selected → viewer_show_info doesn't ALSO fire.
      keyHints: 'Enter view',
      idOf: (entry) => String(entry.startedAt),
    },
  },
};
