/**
 * Pure group-tree transforms over the groups Component slice (Phase C).
 *
 * Each function takes `(slice, model, …)` — `slice` is the groups Component's
 * state (list / expanded / tab), `model` is the root model (for read-only
 * access to model.config.groups + currentGroup). Functions mutate the slice
 * in place and RETURN a cascade descriptor: `{ newIdx, newCurrentGroup,
 * groupChanged }` where applicable. The caller (groups.update) emits the
 * cross-layer Cmds (set_panel_cursor / set_current_group / reset_group_context /
 * dispatch_msg viewer_reset_chrome) based on the return.
 *
 * Cross-layer writes (model.ui.sel.groups, model.currentGroup, root chrome
 * reset) are NOT performed by these leaves — they're effects of the cascade,
 * not state owned by groups (single-writer per layer; docs/v0.5-layering.md).
 */
'use strict';

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
 *  groupChanged }`. The caller emits set_panel_cursor / set_current_group /
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

/** Switch the groups panel between 'all' (tree) and 'quick' (flat pinned).
 *  Slice writes only — returns cascade descriptor. */
function switchTab(slice, model, tab) {
  if (tab !== 'all' && tab !== 'quick') return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  if (slice.tab === tab) return { newIdx: 0, newCurrentGroup: model.currentGroup, groupChanged: false };
  slice.tab = tab;
  recomputeList(slice, model);
  return resolveCursor(slice, model);
}

/** Expand `path`. When `recursive`, also expand every descendant. No-op for
 *  leaves (empty children). Slice writes only. */
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

/** Collapse `path` and (if recursive) every descendant. Slice writes only. */
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

/** Select the row at `idx`. Returns `{ newCurrentGroup, groupChanged }` — the
 *  caller emits set_panel_cursor (ui.sel.groups = idx) + set_current_group +
 *  reset_group_context Cmds. No slice mutation here (slice doesn't track
 *  cursor — that's framework chrome in model.ui.sel.groups). */
function selectAt(slice, model, idx) {
  if (idx < 0 || idx >= slice.list.length) return { newIdx: -1, newCurrentGroup: model.currentGroup, groupChanged: false };
  const newCurrentGroup = slice.list[idx].name;
  return { newIdx: idx, newCurrentGroup, groupChanged: newCurrentGroup !== model.currentGroup };
}

module.exports = {
  isVisible, recomputeList, resolveCursor,
  switchTab, expand, collapse, selectAt,
};
