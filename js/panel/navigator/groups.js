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
  statusFor, getMergedActions,
  getInstanceSlice, getFocus, instanceKind,
} = require('../api');

// --- pure tree transforms (return-new slice + cascade descriptor) ---
//
// Each tree-shape helper takes `(slice, model, …)` and returns
// `[newSlice, descriptor]` where descriptor =
// `{ newIdx, newCurrentGroup, groupChanged }`. Cross-layer writes (cursor,
// model.currentGroup, root chrome reset) are emitted by update() based on
// the descriptor — single-writer per layer.

/** Visible iff every ancestor is expanded. Takes ctx = {groups, ...}. */
function isVisible(slice, ctx, path) {
  const all = ctx.groups || {};
  const g = all[path];
  if (!g) return false;
  if (!g.parent) return true;
  return slice.expanded.has(g.parent) && isVisible(slice, ctx, g.parent);
}

// v0.6.3 Phase D1 — helpers take `ctx = { groups, currentGroup }`
// instead of the full root model. Reducer arms stay pure of
// getModel(); the bundle is threaded per Msg from the dispatcher.
// `groupsBundle(model)` is the single-line helper at the bundle
// boundary.

function groupsBundle(model) {
  return {
    groups: (model && model.config && model.config.groups) || {},
    currentGroup: (model && model.currentGroup) || '',
  };
}

/** Rebuild slice.list (the visible flattened tree) from config.groups + the
 *  expanded set, or the flat pinned list in 'quick'. Returns the new slice. */
function recomputeList(slice, ctx) {
  const all = ctx.groups || {};
  const out = [];
  if (slice.tab === 'quick') {
    for (const path of Object.keys(all)) {
      if (all[path].quick) out.push(all[path]);
    }
  } else {
    for (const path of Object.keys(all)) {
      if (isVisible(slice, ctx, path)) out.push(all[path]);
    }
  }
  return { ...slice, list: out };
}

/** Compute the cursor + currentGroup that should follow a tree-shape change.
 *  Read-only over `slice` + `ctx` — returns `{ newIdx, newCurrentGroup,
 *  groupChanged }`. update() emits the cascade Cmds. */
function resolveCursor(slice, ctx) {
  const all = ctx.groups || {};
  let target = ctx.currentGroup;
  let idx = slice.list.findIndex(g => g.name === target);
  while (idx === -1 && target) {
    target = all[target] ? all[target].parent : null;
    if (!target) break;
    idx = slice.list.findIndex(g => g.name === target);
  }
  if (idx === -1) idx = 0;
  const newCurrentGroup = slice.list[idx] ? slice.list[idx].name : '';
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== ctx.currentGroup };
}

const _noopDescriptor = (ctx) =>
  ({ newIdx: 0, newCurrentGroup: ctx.currentGroup, groupChanged: false });

/** Switch the groups panel between 'all' (tree) and 'quick' (flat pinned). */
function switchTab(slice, ctx, tab) {
  if (tab !== 'all' && tab !== 'quick') return [slice, _noopDescriptor(ctx)];
  if (slice.tab === tab) return [slice, _noopDescriptor(ctx)];
  const next = recomputeList({ ...slice, tab }, ctx);
  return [next, resolveCursor(next, ctx)];
}

/** Expand `path`. When `recursive`, also expand every descendant. No-op for
 *  leaves (empty children). The `expanded` Set is copied on write. */
function expand(slice, ctx, path, recursive = false) {
  const all = ctx.groups || {};
  const g = all[path];
  if (!g || !g.children || g.children.length === 0) return [slice, _noopDescriptor(ctx)];
  const expanded = new Set(slice.expanded);
  expanded.add(path);
  if (recursive) _expandRecursive(expanded, all, g);
  const withSet = { ...slice, expanded };
  const next = recomputeList(withSet, ctx);
  return [next, resolveCursor(next, ctx)];
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
function collapse(slice, ctx, path, recursive = false) {
  const all = ctx.groups || {};
  const g = all[path];
  if (!g) return [slice, _noopDescriptor(ctx)];
  const expanded = new Set(slice.expanded);
  if (recursive) _collapseRecursive(expanded, all, g);
  expanded.delete(path);
  const withSet = { ...slice, expanded };
  const next = recomputeList(withSet, ctx);
  return [next, resolveCursor(next, ctx)];
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
function selectAt(slice, ctx, idx) {
  if (idx < 0 || idx >= slice.list.length) return { newIdx: -1, newCurrentGroup: ctx.currentGroup, groupChanged: false };
  const newCurrentGroup = slice.list[idx].name;
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== ctx.currentGroup };
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

/** Build the cascade Cmds when a tree-shape change moved currentGroup.
 *  Takes ctx = { tabListMode? }; reducer pure — no getModel(). */
function _cascadeCmds(res, ctx) {
  const cmds = [];
  // Phase 4b — cursor lives on this Component's own nav slice; emit a
  // wrapped set_cursor Msg back to ourselves rather than routing via
  // the (retired) `set_panel_cursor` reducer name.
  if (res.newIdx >= 0) {
    cmds.push({ type: 'msg', msg: require('../api').wrap('groups', { type: 'set_cursor', panel: 'groups', index: res.newIdx }) });
  }
  if (res.groupChanged) {
    // v0.6.2 B5 — viewer_reset_chrome MUST run before set_current_group.
    // The viewer's finalizer captures the leaving tab's view-state on
    // slice.tab transition. If set_current_group runs FIRST, the
    // finalizer's resolveTabKey sees the NEW group and the FROM-capture
    // lands under the WRONG group's key. Reordering keeps the finalizer
    // reading the OLD group at capture time.
    const route = require('../../leaves/route');
    const target = route.resolveTarget('viewer');
    if (target) {
      cmds.push({ type: 'msg', msg: require('../api').wrap(target, {
        type: 'viewer_reset_chrome', tabListMode: !!(ctx && ctx.tabListMode),
      }) });
    }
    cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
    cmds.push({ type: 'msg', msg: { type: 'reset_group_context' } });
  }
  cmds.push({ type: 'show_selected_info' });
  return cmds;
}

// v0.6.3 Phase D1 — every external dispatcher of a groups Msg
// threads msg.ctx = { groups, currentGroup, tabListMode? } via
// groupsBundle (exported below). The reducer arm reads ctx from
// msg and passes to helpers. Reducer is pure of getModel();
// internal cascade Cmds emitted from _cascadeCmds also receive
// the bundle so downstream Msgs stay threaded.
function _msgCtx(msg) {
  return msg.ctx || { groups: {}, currentGroup: '', tabListMode: false };
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs (set_cursor / set_scroll / multisel_*)
  // are handled by the shared leaf so every Navigator's update has the
  // same nav semantics. Non-nav Msgs fall through to this Component's
  // own switch.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'groups_recompute') {
    // Boot / config reload — rebuild list from config.groups + slice state.
    return recomputeList(slice, _msgCtx(msg));
  }
  if (msg.type === 'groups_selected') {
    // nav_select for panel:'groups' wrote the cursor already (Phase 4a:
    // via a wrapped set_cursor Msg into this Component's nav slice); we
    // just emit the cascade Cmds (set_current_group + reset_group_context
    // + viewer reset) if the index actually moved the active group.
    const ctx = _msgCtx(msg);
    const res = selectAt(slice, ctx, msg.index);
    if (res.newIdx < 0) return slice;
    // cursor already written by nav_select — don't re-emit set_panel_cursor.
    const cmds = [];
    if (res.groupChanged) {
      // v0.6.2 B5 — viewer_reset_chrome before set_current_group (see
      // selectAt cascade above for the full rationale: the finalizer's
      // FROM-tab key resolution needs the OLD currentGroup).
      const route = require('../../leaves/route');
      const target = route.resolveTarget('viewer');
      if (target) {
        cmds.push({ type: 'msg', msg: require('../api').wrap(target, {
          type: 'viewer_reset_chrome', tabListMode: !!ctx.tabListMode,
        }) });
      }
      cmds.push({ type: 'msg', msg: { type: 'set_current_group', name: res.newCurrentGroup } });
      cmds.push({ type: 'msg', msg: { type: 'reset_group_context' } });
    }
    return [slice, cmds];
  }
  if (msg.type === 'toggle_group') {
    // `recursive` only matters for the leader-key `"` chord (expand
    // every descendant) — interactive Enter on a row toggles one level.
    const ctx = _msgCtx(msg);
    const [next, res] = slice.expanded.has(msg.name)
      ? collapse(slice, ctx, msg.name, !!msg.recursive)
      : expand(slice, ctx, msg.name, !!msg.recursive);
    return [next, _cascadeCmds(res, ctx)];
  }
  if (msg.type === 'toggle_groups_tab') {
    const target = slice.tab === 'quick' ? 'all' : 'quick';
    const ctx = _msgCtx(msg);
    const [next, res] = switchTab(slice, ctx, target);
    return [next, _cascadeCmds(res, ctx)];
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
  // v0.6.2 — show the same merged set the actions panel + tab strip
  // see, so auto-actions (`status`/`logs`/…) appear in group-info too.
  const acts = Object.values(getMergedActions(group.name));
  if (acts.length) {
    lines.push('', `[dim]actions:[/] ${acts.length}`);
    for (const a of acts) {
      const tag = { spawn: ' ⧉', background: ' ⇱' }[a.type] || '';
      lines.push(`  ${esc(a.label)}${tag}`);
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

function render(panel, w, h, slice, opts) {
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
    chrome: opts && opts.chrome,
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
  groupsBundle,
  // Test-only exports.
  _init: init,
  _update: update,
};
