/**
 * Core plugin — groups panel.
 *
 * Reads `S.groups` (built from `S.config.groups` at boot). Each row is
 * a group object with name/label/compose/containers/actions; selection
 * here drives `S.currentGroup` via dispatch's selectGroup() helper.
 *
 * Owns the `row:right:groups` decorator that paints the running-count
 * dot — was inline in the renderer originally; moved through the
 * decorator framework so other plugins can override / augment it.
 */
'use strict';

const { S } = require('../../state');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, decorate,
  statusFor,
} = require('../api');

function getItems() { return S.groups; }

function copyOptions(group) {
  if (!group) return [];
  const opts = [
    { label: `Group key: ${group.name}`, content: group.name },
    { label: `Label: ${group.label}`, content: group.label },
  ];
  if (group.compose) opts.push({ label: `Compose: ${group.compose}`, content: group.compose });
  if (group.containers && group.containers.length) {
    opts.push({ label: `Container names (${group.containers.length})`, content: group.containers.join('\n') });
  }
  return opts;
}

function getInfo(group) {
  if (!group) return [];
  const lines = [`[bold]${esc(group.label)}[/]`];
  if (group.name && group.name !== group.label) {
    lines.push(`[dim]path:[/] ${esc(group.name)}`);
  }
  if (group.compose) lines.push('', `[dim]compose:[/] ${esc(group.compose)}`);
  if (group.containers && group.containers.length) {
    lines.push(`[dim]containers:[/] ${group.containers.length}`);
    for (const c of group.containers) lines.push(`  ${esc(c)}`);
  }
  if (group.children && group.children.length) {
    lines.push('', `[dim]children:[/] ${group.children.length}`);
    for (const c of group.children) {
      const local = c.split('.').pop();
      lines.push(`  ${esc(local)}`);
    }
  }
  if (group.actions) {
    const acts = Object.values(group.actions);
    if (acts.length) {
      lines.push('', `[dim]actions:[/] ${acts.length}`);
      for (const a of acts) {
        const tag = { spawn: ' ⧉', background: ' ⇱' }[a.type] || '';
        lines.push(`  ${esc(a.label)}${tag}`);
      }
    }
  }
  return lines;
}

// Tree glyphs — all single-column (charWidth() returns 1) so visibleLen
// stays accurate. ▸ collapsed branch, ▾ expanded branch, · leaf.
const GLYPH_COLLAPSED = '▸';
const GLYPH_EXPANDED  = '▾';
const GLYPH_LEAF      = '·';

function _glyphFor(group) {
  if (!group.children || group.children.length === 0) return GLYPH_LEAF;
  return S.expandedGroups.has(group.name) ? GLYPH_EXPANDED : GLYPH_COLLAPSED;
}

function render(panel, w, h) {
  const sel = getSel('groups');
  const innerW = w - 2;
  // In Quick tab, rows are a flat pinned list — no indent or glyph. The
  // path label tells the user which deeply-nested node they're hitting,
  // which is the whole point of pinning a leaf into Quick.
  const isQuick = S.groupsTab === 'quick';
  const lines = S.groups.map((group, i) => {
    const t = theme();
    const isSel = i === sel && S.focus === 'groups';
    const ctx = { panelType: 'groups', item: group, selected: isSel, S };
    const left  = decorate('row:left:groups',  { ...ctx, width: 4 });
    let treeSeg;
    let labelStr;
    if (isQuick) {
      treeSeg = '';
      // Show the full dotted path so the user knows where the pinned
      // row lives in the tree. For top-level groups (path === label
      // case-insensitive), this is just the label.
      labelStr = esc(group.name);
    } else {
      // Tree shape: 2 spaces per depth level + 1 glyph + 1 space. The glyph
      // tells the user at a glance whether the row is a leaf (·), an open
      // branch (▾), or a closed one (▸).
      const indent = '  '.repeat(group.depth || 0);
      const glyph = _glyphFor(group);
      treeSeg = `${indent}${glyph} `;
      labelStr = esc(group.label);
    }
    const labelLen = visibleLen(labelStr);
    // Row layout: "{mark} {left }{tree}{label} {right}". The mark column
    // (1 char) reserves the gutter for multi-select / focused-but-blurred
    // marker; +1 for the trailing space before content.
    const used = 2 + (left ? visibleLen(left) + 1 : 0)
                 + visibleLen(treeSeg) + labelLen;
    const right = decorate('row:right:groups', { ...ctx, width: Math.max(0, innerW - used - 1) });
    const lhead = left  ? `${left} `  : '';
    const rtail = right ? ` ${right}` : '';
    const isMs  = isMultiSel('groups', group.name);
    // Multi-select wins the gutter glyph (most recent action signal); the
    // existing > mark for "cursor-but-not-focused" stays as fallback.
    const mark  = isMs ? '*' : (isSel ? ' ' : (i === sel ? '>' : ' '));
    const labelText = `${mark} ${lhead}${treeSeg}${labelStr}${rtail}`;
    if (isSel) return `[${t.selected}]${labelText}`;
    if (i === sel) return `[${t.bold_current}]${labelText}[/]`;
    return labelText;
  });
  return renderPanel({
    width: w, height: h, lines,
    title: _groupsTitle(panel.title), hotkey: panel.hotkey,
    panelType: 'groups',
    focused: S.focus === 'groups',
    count: [sel + 1, S.groups.length],
    scrollOffset: getScroll('groups'),
  });
}

/**
 * Compose the groups panel's full title with All/Quick tabs joined by ─
 * (matching detail.js's tab style). Active tab is wrapped in escaped
 * brackets (\[ → literal `[` on screen) — PRINCIPLES §8: no [/] resets
 * inside the title or they'll tangle with the panel border highlight.
 *
 * Falls back to the bare title when no group declares `quick: true`.
 */
function _groupsTitle(panelTitle) {
  const all = (S.config && S.config.groups) || {};
  const hasQuick = Object.values(all).some(g => g.quick);
  if (!hasQuick) return panelTitle;
  const active = S.groupsTab || 'all';
  const allTab   = active === 'all'   ? '\\[All]'   : 'All';
  const quickTab = active === 'quick' ? '\\[Quick]' : 'Quick';
  return `${panelTitle}─${allTab}─${quickTab}`;
}

/**
 * Running-count + dot — `n/total ●` with color reflecting how many of
 * the group's containers are running. Used to be inline in render(),
 * moved to a `row:right:groups` decorator so a plugin can override or
 * augment with the same mechanism that exposes every other row badge.
 */
function rowRightGroups(ctx) {
  const group = ctx.item;
  const containers = group.containers || [];
  const total = containers.length;
  if (total === 0) return '';
  const running = containers.filter(c => statusFor(c) === 'running').length;
  if (ctx.selected) return `${running}/${total} ●`;   // plain text in [reverse]
  const t = theme();
  const color = running === total ? t.running : running > 0 ? t.partial : t.stopped;
  return `${running}/${total} [${color}]●[/]`;
}

module.exports = {
  panelType: 'groups',
  def: {
    mode: 'list', render,
    getItems, getInfo, copyOptions,
    idOf: (g) => g.name,
  },
  decorators: {
    'row:right:groups': rowRightGroups,
  },
};
