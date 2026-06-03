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

const { getModel } = require('../../app/runtime');
const mnav = require('../../leaves/nav');
const {
  esc, wrapColor, theme, renderPanel,
  getSel, getScroll, isMultiSel,
  statusFor,
  getInstanceSlice, getFocus, instanceKind,
} = require('../api');

// --- pure tree transforms (return-new slice + cascade descriptor) ---
//
// Each tree-shape helper takes `(slice, model, …)` and returns
// `[newSlice, descriptor]` where descriptor =
// `{ newIdx, newCurrentGroup, groupChanged }`. Cross-layer writes (cursor,
// model.currentGroup, root chrome reset) are emitted by update() based on
// the descriptor — single-writer per layer.

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
 *  expanded set, or the flat pinned list in 'quick'. Returns the new slice. */
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
  return { ...slice, list: out };
}

/** Compute the cursor + currentGroup that should follow a tree-shape change.
 *  Read-only over `slice` + `model` — returns `{ newIdx, newCurrentGroup,
 *  groupChanged }`. update() emits the cascade Cmds. */
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

const _noopDescriptor = (model) =>
  ({ newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false });

/** Switch the groups panel between 'all' (tree) and 'quick' (flat pinned). */
function switchTab(slice, model, tab) {
  if (tab !== 'all' && tab !== 'quick') return [slice, _noopDescriptor(model)];
  if (slice.tab === tab) return [slice, _noopDescriptor(model)];
  const next = recomputeList({ ...slice, tab }, model);
  return [next, resolveCursor(next, model)];
}

/** Expand `path`. When `recursive`, also expand every descendant. No-op for
 *  leaves (empty children). The `expanded` Set is copied on write. */
function expand(slice, model, path, recursive = false) {
  const all = (model.config && model.config.groups) || {};
  const g = all[path];
  if (!g || !g.children || g.children.length === 0) return [slice, _noopDescriptor(model)];
  const expanded = new Set(slice.expanded);
  expanded.add(path);
  if (recursive) _expandRecursive(expanded, all, g);
  const withSet = { ...slice, expanded };
  const next = recomputeList(withSet, model);
  return [next, resolveCursor(next, model)];
}

function _expandRecursive(expanded, all, g) {
  for (const childPath of (g.children || [])) {
    const child = all[childPath];
    if (!child || !child.children || child.children.length === 0) continue;
    expanded.add(childPath);
    _expandRecursive(expanded, all, child);
  }
}

/** Collapse `path` and (if recursive) every descendant. */
function collapse(slice, model, path, recursive = false) {
  const all = (model.config && model.config.groups) || {};
  const g = all[path];
  if (!g) return [slice, _noopDescriptor(model)];
  const expanded = new Set(slice.expanded);
  if (recursive) _collapseRecursive(expanded, all, g);
  expanded.delete(path);
  const withSet = { ...slice, expanded };
  const next = recomputeList(withSet, model);
  return [next, resolveCursor(next, model)];
}

function _collapseRecursive(expanded, all, g) {
  for (const childPath of (g.children || [])) {
    const child = all[childPath];
    if (!child) continue;
    _collapseRecursive(expanded, all, child);
    expanded.delete(childPath);
  }
}

/** Select the row at `idx`. Returns `{ newIdx, newCurrentGroup,
 *  groupChanged }`. Read-only — slice has no cursor field (that lives on
 *  slice.nav.groups, written by the nav leaf). */
function selectAt(slice, model, idx) {
  if (idx < 0 || idx >= slice.list.length) return { newIdx: -1, newCurrentGroup: model.currentGroup, groupChanged: false };
  const newCurrentGroup = slice.list[idx].name;
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== model.currentGroup };
}

// --- init ---

function init() {
  return {
    list: [], expanded: new Set(), tab: 'all',
    // v0.6.1 Phase 3 — single-panel Component, nav stores the entry
    // directly. mnav.apply detects shape and routes accordingly.
    nav: mnav.init(),
  };
}

// --- update ---

/** Build the cascade Cmds when a tree-shape change moved currentGroup. */
function _cascadeCmds(res) {
  const cmds = [];
  // Phase 4b — cursor lives on this Component's own nav slice; emit a
  // wrapped set_cursor Msg back to ourselves rather than routing via
  // the (retired) `set_panel_cursor` reducer name.
  if (res.newIdx >= 0) {
    cmds.push({ type: 'msg', msg: require('../api').wrap('groups', { type: 'set_cursor', panel: 'groups', index: res.newIdx }) });
  }
  if (res.groupChanged) {
    cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
    cmds.push({ type: 'msg', msg: { type: 'reset_group_context' } });
    // v0.6.1 Phase 5 — viewer reset routes through resolveTarget so
    // multi-viewer (Phase 6+) hits the right pane. With one viewer
    // (today) this resolves to 'detail' every time. null → no viewer
    // registered, drop the Cmd.
    const route = require('../../leaves/route');
    const target = route.resolveTarget('viewer');
    if (target) {
      cmds.push({ type: 'msg', msg: require('../api').wrap(target, { type: 'viewer_reset_chrome' }) });
    }
  }
  cmds.push({ type: 'show_selected_info' });
  return cmds;
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs (set_cursor / set_scroll / multisel_*)
  // are handled by the shared leaf so every Navigator's update has the
  // same nav semantics. Non-nav Msgs fall through to this Component's
  // own switch.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'groups_recompute') {
    // Boot / config reload — rebuild list from config.groups + slice state.
    return recomputeList(slice, getModel());
  }
  if (msg.type === 'groups_selected') {
    // nav_select for panel:'groups' wrote the cursor already (Phase 4a:
    // via a wrapped set_cursor Msg into this Component's nav slice); we
    // just emit the cascade Cmds (set_current_group + reset_group_context
    // + viewer reset) if the index actually moved the active group.
    const res = selectAt(slice, getModel(), msg.index);
    if (res.newIdx < 0) return slice;
    // cursor already written by nav_select — don't re-emit set_panel_cursor.
    const cmds = [];
    if (res.groupChanged) {
      cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
      cmds.push({ type: 'msg', msg: { type: 'reset_group_context' } });
      // v0.6.1 Phase 5 — viewer reset routes through resolveTarget.
      const route = require('../../leaves/route');
      const target = route.resolveTarget('viewer');
      if (target) {
        cmds.push({ type: 'msg', msg: require('../api').wrap(target, { type: 'viewer_reset_chrome' }) });
      }
    }
    return [slice, cmds];
  }
  if (msg.type === 'toggle_group') {
    // `recursive` only matters for the leader-key `"` chord (expand
    // every descendant) — interactive Enter on a row toggles one level.
    const [next, res] = slice.expanded.has(msg.name)
      ? collapse(slice, getModel(), msg.name, !!msg.recursive)
      : expand(slice, getModel(), msg.name, !!msg.recursive);
    return [next, _cascadeCmds(res)];
  }
  if (msg.type === 'toggle_groups_tab') {
    const target = slice.tab === 'quick' ? 'all' : 'quick';
    const [next, res] = switchTab(slice, getModel(), target);
    return [next, _cascadeCmds(res)];
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
  const sel = getSel('groups');
  const isQuick = slice.tab === 'quick';
  const t = theme();
  const lines = slice.list.map((group, i) => {
    const isSel = i === sel && instanceKind(getFocus()) === 'groups';
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
    // Phase 5 — running/total badge inlined (was a decorator handler).
    // Returns '' for groups with no containers.
    const right = _rowRightGroups(group, isSel);
    const rtail = right ? ` ${right}` : '';
    const isMs  = isMultiSel('groups', group.name);
    const mark  = isMs ? '*' : (isSel ? ' ' : (i === sel ? '>' : ' '));
    const labelText = `${mark} ${treeSeg}${labelStr}${rtail}`;
    if (isSel) return `[${t.selected}]${labelText}`;
    // wrapColor reopens bold_current after any nested `[/]` in
    // labelText (the running/total badge `[color]●[/]` from
    // _rowRightGroups currently sits at the tail, so the inner reset
    // is a no-op today — but moving rtail or appending content after
    // it would silently drop bold_current. wrapColor keeps the
    // invariant.)
    if (i === sel) return wrapColor(t.bold_current, labelText);
    return labelText;
  });
  return renderPanel({
    width: w, height: h, lines,
    title: _groupsTitle(panel.title, slice), hotkey: panel.hotkey,
    panelType: 'groups',
    focused: instanceKind(getFocus()) === 'groups',
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

function _rowRightGroups(group, selected) {
  const containers = group.containers || [];
  const total = containers.length;
  if (total === 0) return '';
  const running = containers.filter(c => statusFor(c) === 'running').length;
  if (selected) return `${running}/${total} ●`;
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
      render,
      getItems, getInfo, copyOptions,
      idOf: (g) => g.name,
    },
  },
  // Test-only exports.
  _init: init,
  _update: update,
};
