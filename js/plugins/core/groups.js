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

const { getModel } = require('../../runtime');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, isMultiSel, decorate,
  statusFor,
  getComponentSlice,
} = require('../api');

// --- pure tree transforms (slice writes + cascade descriptors) ---
//
// Each helper takes `(slice, model, …)`, mutates the slice in place, and
// returns `{ newIdx, newCurrentGroup, groupChanged }` (cascade descriptor).
// Cross-layer writes (model.ui.sel.groups, model.currentGroup, root chrome
// reset) are NOT performed here — update() emits the cross-layer Cmds based
// on the returned descriptor. Single-writer per layer.

/** Visible iff every ancestor is expanded. */
function isVisible(slice, model, path) {
  const all = model.config && model.config.groups;
  if (!all) return false;
  const g = all[path];
  if (!g) return false;
  if (!g.parent) return true;
  return slice.expanded.has(g.parent) && isVisible(slice, model, g.parent);
}

/** Rebuild slice.list (the visible flattened tree) from config.groups + the
 *  expanded set, or the flat pinned list in 'quick'. Pure slice write. */
function recomputeList(slice, model) {
  const all = (model.config && model.config.groups) || {};
  const out = [];
  if (slice.tab === 'quick') {
    for (const path of Object.keys(all)) {
      if (all[path].quick) out.push(all[path]);
    }
  } else {
    for (const path of Object.keys(all)) {
      if (isVisible(slice, model, path)) out.push(all[path]);
    }
  }
  slice.list = out;
}

/** Compute the cursor + currentGroup that should follow a tree-shape change.
 *  Read-only over `slice` + `model` — returns `{ newIdx, newCurrentGroup,
 *  groupChanged }`. update() emits set_panel_cursor / set_current_group /
 *  reset_group_context Cmds as appropriate. */
function resolveCursor(slice, model) {
  const all = (model.config && model.config.groups) || {};
  let target = model.currentGroup;
  let idx = slice.list.findIndex(g => g.name === target);
  while (idx === -1 && target) {
    target = all[target] ? all[target].parent : null;
    if (!target) break;
    idx = slice.list.findIndex(g => g.name === target);
  }
  if (idx === -1) idx = 0;
  const newCurrentGroup = slice.list[idx] ? slice.list[idx].name : '';
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== model.currentGroup };
}

/** Switch the groups panel between 'all' (tree) and 'quick' (flat pinned). */
function switchTab(slice, model, tab) {
  if (tab !== 'all' && tab !== 'quick') return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  if (slice.tab === tab) return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  slice.tab = tab;
  recomputeList(slice, model);
  return resolveCursor(slice, model);
}

/** Expand `path`. When `recursive`, also expand every descendant. No-op for
 *  leaves (empty children). */
function expand(slice, model, path, recursive = false) {
  const all = (model.config && model.config.groups) || {};
  const g = all[path];
  if (!g || !g.children || g.children.length === 0) return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  slice.expanded.add(path);
  if (recursive) {
    for (const childPath of g.children) expand(slice, model, childPath, true);
  }
  recomputeList(slice, model);
  return resolveCursor(slice, model);
}

/** Collapse `path` and (if recursive) every descendant. */
function collapse(slice, model, path, recursive = false) {
  const all = (model.config && model.config.groups) || {};
  const g = all[path];
  if (!g) return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  if (recursive && g.children) {
    for (const childPath of g.children) collapse(slice, model, childPath, true);
  }
  slice.expanded.delete(path);
  recomputeList(slice, model);
  return resolveCursor(slice, model);
}

/** Select the row at `idx`. Returns `{ newCurrentGroup, groupChanged }`.
 *  No slice mutation here — slice doesn't track cursor (that's framework
 *  chrome in model.ui.sel.groups). */
function selectAt(slice, model, idx) {
  if (idx < 0 || idx >= slice.list.length) return { newIdx: -1, newCurrentGroup: model.currentGroup, groupChanged: false };
  const newCurrentGroup = slice.list[idx].name;
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== model.currentGroup };
}

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
    recomputeList(slice, getModel());
    return slice;
  }
  if (msg.type === 'groups_selected') {
    // nav_select for panel:'groups' wrote ui.sel.groups already; we just emit
    // the cascade Cmds (set_current_group + reset_group_context + viewer
    // reset) if the index actually moved the active group.
    const res = selectAt(slice, getModel(), msg.index);
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
      ? collapse(slice, getModel(), msg.name, !!msg.recursive)
      : expand(slice, getModel(), msg.name, !!msg.recursive);
    return [slice, _cascadeCmds(res)];
  }
  if (msg.type === 'toggle_groups_tab') {
    const next = slice.tab === 'quick' ? 'all' : 'quick';
    const res = switchTab(slice, getModel(), next);
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
    const isSel = i === sel && getComponentSlice("layout").focus === 'groups';
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
    focused: getComponentSlice("layout").focus === 'groups',
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
