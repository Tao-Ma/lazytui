/**
 * Core Component — groups (Phase C).
 *
 * The last in-tree Plugin migrated to the Component API. Owns the group-tree
 * slice (list / expanded / tab) — panel-private state. The cascade
 * operations (cursor + currentGroup + per-group root-chrome reset + viewer
 * reset) are CROSS-LAYER; each emits an apply_msg / dispatch_msg Cmd.
 *
 * Slice shape:
 *   { list: [], expanded: Set, tab: 'all' | 'quick' }
 *
 * Msgs handled here:
 *   - groups_recompute    — re-derive slice.list from config (dispatched by
 *                           state.initState after config loads).
 *   - groups_selected     — `nav_select panel:'groups'` re-fires this via
 *                           dispatch_msg; emits the cascade Cmds.
 *   - toggle_group        — expand/collapse a node.
 *   - toggle_groups_tab   — All ↔ Quick.
 *
 * Cross-layer Cmds emitted by the cascade:
 *   - apply_msg set_panel_cursor { panel:'groups', index }   (root chrome)
 *   - apply_msg set_current_group { name }                   (app-wide)
 *   - apply_msg reset_group_context                          (root chrome)
 *   - dispatch_msg viewer_reset_chrome                       (detail slice)
 */
'use strict';

const mg = require('../../model-groups');
const { getModel } = require('../../runtime');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, decorate,
  statusFor,
} = require('../api');

// --- init ---

function init() {
  return { list: [], expanded: new Set(), tab: 'all' };
}

// --- update ---

/** Build the cascade Cmds when a tree-shape change moved currentGroup. */
function _cascadeCmds(res) {
  const cmds = [];
  if (res.newIdx >= 0) cmds.push({ type: 'apply_msg', msg: { type: 'set_panel_cursor', panel: 'groups', index: res.newIdx } });
  if (res.groupChanged) {
    cmds.push({ type: 'apply_msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
    cmds.push({ type: 'apply_msg', msg: { type: 'reset_group_context' } });
    cmds.push({ type: 'dispatch_msg', msg: { type: 'viewer_reset_chrome' } });
  }
  cmds.push({ type: 'show_selected_info' });
  return cmds;
}

function update(msg, slice) {
  if (msg.type === 'groups_recompute') {
    // Boot / config reload — rebuild list from config.groups + slice state.
    mg.recomputeList(slice, getModel());
    return slice;
  }
  if (msg.type === 'groups_selected') {
    // nav_select for panel:'groups' wrote ui.sel.groups already; we just emit
    // the cascade Cmds (set_current_group + reset_group_context + viewer
    // reset) if the index actually moved the active group.
    const res = mg.selectAt(slice, getModel(), msg.index);
    if (res.newIdx < 0) return slice;
    // ui.sel.groups already written by nav_select — don't re-emit set_panel_cursor.
    const cmds = [];
    if (res.groupChanged) {
      cmds.push({ type: 'apply_msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
      cmds.push({ type: 'apply_msg', msg: { type: 'reset_group_context' } });
      cmds.push({ type: 'dispatch_msg', msg: { type: 'viewer_reset_chrome' } });
    }
    return [slice, cmds];
  }
  if (msg.type === 'toggle_group') {
    // `recursive` only matters for the leader-key `"` chord (expand
    // every descendant) — interactive Enter on a row toggles one level.
    const res = slice.expanded.has(msg.name)
      ? mg.collapse(slice, getModel(), msg.name, !!msg.recursive)
      : mg.expand(slice, getModel(), msg.name, !!msg.recursive);
    return [slice, _cascadeCmds(res)];
  }
  if (msg.type === 'toggle_groups_tab') {
    const next = slice.tab === 'quick' ? 'all' : 'quick';
    const res = mg.switchTab(slice, getModel(), next);
    return [slice, _cascadeCmds(res)];
  }
  return slice;
}

// --- panel def (render + accessors). ---

function getItems(slice) { return slice ? slice.list : []; }

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

const GLYPH_COLLAPSED = '▸';
const GLYPH_EXPANDED  = '▾';
const GLYPH_LEAF      = '·';

function _glyphFor(group, expanded) {
  if (!group.children || group.children.length === 0) return GLYPH_LEAF;
  return expanded.has(group.name) ? GLYPH_EXPANDED : GLYPH_COLLAPSED;
}

function render(panel, w, h, slice) {
  const m = getModel();
  const sel = getSel('groups');
  const innerW = w - 2;
  const isQuick = slice.tab === 'quick';
  const lines = slice.list.map((group, i) => {
    const t = theme();
    const isSel = i === sel && m.focus === 'groups';
    const ctx = { panelType: 'groups', item: group, selected: isSel };
    const left  = decorate('row:left:groups',  { ...ctx, width: 4 });
    let treeSeg;
    let labelStr;
    if (isQuick) {
      treeSeg = '';
      labelStr = esc(group.name);
    } else {
      const indent = '  '.repeat(group.depth || 0);
      const glyph = _glyphFor(group, slice.expanded);
      treeSeg = `${indent}${glyph} `;
      labelStr = esc(group.label);
    }
    const labelLen = visibleLen(labelStr);
    const used = 2 + (left ? visibleLen(left) + 1 : 0)
                 + visibleLen(treeSeg) + labelLen;
    const right = decorate('row:right:groups', { ...ctx, width: Math.max(0, innerW - used - 1) });
    const lhead = left  ? `${left} `  : '';
    const rtail = right ? ` ${right}` : '';
    const isMs  = isMultiSel('groups', group.name);
    const mark  = isMs ? '*' : (isSel ? ' ' : (i === sel ? '>' : ' '));
    const labelText = `${mark} ${lhead}${treeSeg}${labelStr}${rtail}`;
    if (isSel) return `[${t.selected}]${labelText}`;
    if (i === sel) return `[${t.bold_current}]${labelText}[/]`;
    return labelText;
  });
  return renderPanel({
    width: w, height: h, lines,
    title: _groupsTitle(panel.title, slice), hotkey: panel.hotkey,
    panelType: 'groups',
    focused: m.focus === 'groups',
    count: [sel + 1, slice.list.length],
    scrollOffset: getScroll('groups'),
  });
}

function _groupsTitle(panelTitle, slice) {
  const cfg = getModel().config;
  const all = (cfg && cfg.groups) || {};
  const hasQuick = Object.values(all).some(g => g.quick);
  if (!hasQuick) return panelTitle;
  const active = (slice && slice.tab) || 'all';
  const allTab   = active === 'all'   ? '\\[All]'   : 'All';
  const quickTab = active === 'quick' ? '\\[Quick]' : 'Quick';
  return `${panelTitle}─${allTab}─${quickTab}`;
}

function rowRightGroups(ctx) {
  const group = ctx.item;
  const containers = group.containers || [];
  const total = containers.length;
  if (total === 0) return '';
  const running = containers.filter(c => statusFor(c) === 'running').length;
  if (ctx.selected) return `${running}/${total} ●`;
  const t = theme();
  const color = running === total ? t.running : running > 0 ? t.partial : t.stopped;
  return `${running}/${total} [${color}]●[/]`;
}

module.exports = {
  name: 'groups',
  init,
  update,
  panelTypes: {
    groups: {
      kind: 'navigator',
      mode: 'list', render,
      getItems, getInfo, copyOptions,
      idOf: (g) => g.name,
    },
  },
  decorators: {
    'row:right:groups': rowRightGroups,
  },
  // Test-only exports.
  _init: init,
  _update: update,
};
