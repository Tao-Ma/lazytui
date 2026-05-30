/**
 * App state — config loading, layout initialization, slice-reset wrappers.
 *
 * No mutable state lives here. The root model lives in runtime.js
 * (getModel()); Component slices live in plugins/api.js's registry. This
 * module is the boot/init layer (loadConfig + initState) plus the small
 * set of read/write helpers the rest of the codebase imports from `./state`
 * (getSel / setSel / getScroll / setScroll / toggleMultiSel / allPanels /
 * resetGroupContext / selectGroup / setDetail / recomputeGroups / …).
 *
 * Historical note: state.js used to export a global `S` object that
 * doubled as both the data home and a facade over the model + Component
 * slices. After the v0.5 single-writer migration, `S` was deleted
 * (chunks A–E): production code reads getModel() / getComponentSlice()
 * directly, and tests do the same.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { setTheme } = require('./themes');
const { getModel } = require('./runtime');

// --- Component slice resolution ---
//
// state.js's own init/reset code (initState) writes into Component slices
// directly via these helpers — no longer through the `S` shim. Lazy auto-
// register covers tests that touch state without explicit Component setup;
// production already registers detail + groups at boot (tui.js).
let _detailAutoRegistered = false;
function _detailSlice() {
  const api = require('./plugins/api');
  let s = api.getComponentSlice('detail');
  if (!s) {
    if (!_detailAutoRegistered) {
      try { require('./effects').installBuiltins(); } catch (_) {}
      _detailAutoRegistered = true;
    }
    api.registerComponent(require('./plugins/core/viewer'));
    s = api.getComponentSlice('detail');
  }
  return s;
}

let _groupsAutoRegistered = false;
function _groupsSlice() {
  const api = require('./plugins/api');
  let s = api.getComponentSlice('groups');
  if (!s) {
    if (!_groupsAutoRegistered) {
      try { require('./effects').installBuiltins(); } catch (_) {}
      _groupsAutoRegistered = true;
    }
    api.registerComponent(require('./plugins/core/groups'));
    s = api.getComponentSlice('groups');
  }
  return s;
}

// --- Config loading ---

function loadConfig(configPath) {
  const m = getModel();
  const ext = path.extname(configPath);
  if (ext === '.json') {
    m.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    // In-process JS parser — was an out-of-process `python -m parser`
    // call until the parser was rewritten in JS. Errors thrown by
    // parse() are ParseError subclasses with composed messages; let
    // them propagate so tui.js's top-level handler prints them and
    // exits non-zero (mirrors the old "parser: <msg>" stderr line).
    const { parse } = require('./parser');
    m.config = parse(path.resolve(configPath));
  }
  m.projectDir = m.config.project_dir || '.';
  m.configPath = path.resolve(configPath);
}

// --- Layout initialization ---

/**
 * Build a fresh `{ leftWidth, detailHeightPct, leftPanels, rightPanels }`
 * struct from a parsed config. Pure — reads only the passed-in config.
 *
 * Extracted so `:restore-layout` can replay the same logic on demand
 * without re-running `initState` (which also resets expanded-groups
 * state, sets focus, etc. — things we don't want to clobber on a
 * layout-only restore).
 */
function rebuildLayoutFromConfig(config) {
  const ly = config.layout;
  const out = { leftWidth: 30, detailHeightPct: 60, leftPanels: [], rightPanels: [] };

  if (ly) {
    const leftPanelsSrc = ly.left_panels || (ly.left && ly.left.panels) || [];
    const rightPanelsSrc = ly.right_panels || (ly.right && ly.right.panels) || [];
    out.leftWidth = ly.left_width || (ly.left && ly.left.width) || 30;
    out.detailHeightPct = ly.detail_height_pct || 60;
    // Plugin-specific panel options (parser PanelConfig.config) ride
    // alongside type/title/hotkey/column so the panel def can read them
    // off `panel` directly. Spread first so the framework keys win on
    // any overlap.
    out.leftPanels = leftPanelsSrc.map((p, i) => ({
      ...(p.config || {}),
      type: p.type,
      title: p.title || p.type.replace(/_/g, ' '),
      hotkey: p.hotkey || String(i + 1),
      column: 'left',
    }));
    // Right-panel hotkeys come pre-assigned from the parser (positional
    // 7/8/9, with explicit YAML overrides honored). Fall back to position
    // here too in case the layout block came from JSON or some other
    // source that didn't go through the parser.
    const rightPool = ['7', '8', '9'];
    const rightExplicit = new Set(rightPanelsSrc.map(p => p.hotkey).filter(Boolean));
    const rightAuto = rightPool.filter(k => !rightExplicit.has(k));
    out.rightPanels = rightPanelsSrc.map(p => ({
      ...(p.config || {}),
      type: p.type,
      title: p.title || p.type.replace(/_/g, ' '),
      hotkey: p.hotkey || (rightAuto.shift() || ''),
      column: 'right',
    }));
  } else {
    const hasContainers = Object.values(config.groups).some(g => g.containers && g.containers.length);
    const hasConfigFiles = config.files && config.files.length;
    let hk = 1;
    if (hasContainers) {
      out.leftPanels.push({ type: 'containers', title: 'Containers', hotkey: String(hk++), column: 'left' });
    }
    out.leftPanels.push({ type: 'groups', title: 'Groups', hotkey: String(hk++), column: 'left' });
    if (hasConfigFiles) {
      out.leftPanels.push({ type: 'file-manager', title: 'Files', hotkey: String(hk++), column: 'left' });
    }
    out.rightPanels = [
      { type: 'actions', title: 'Actions', hotkey: '7', column: 'right' },
      { type: 'detail', title: 'Detail', hotkey: '8', column: 'right' },
    ];
  }
  return out;
}

function initState() {
  const m = getModel();
  const config = m.config;
  setTheme(config.theme || 'default');

  m.layout = rebuildLayoutFromConfig(config);

  // Tree state: start collapsed (only top-level nodes visible). The cursor
  // lands on the first visible row, which is the first top-level group.
  const groups = _groupsSlice();
  groups.expanded = new Set();
  groups.tab = 'all';
  recomputeGroups();
  m.currentGroup = groups.list.length ? groups.list[0].name : '';
  m.ui.sel = {};
  m.ui.scroll = {};
  const detail = _detailSlice();
  detail.lines = [];
  detail.scroll = 0;
  detail.tab = 0;
  m.focus = 'groups';
  // Mode flags — cleared from the single registry (js/modes.js) so this
  // can't drift out of sync with the modeChain / overlay / modal lists.
  // Non-flag buffers (filters, prefixNode/Seq, detailSearch object) are
  // reset explicitly below since the registry only flips the booleans.
  require('./modes').resetModes();
  m.ui.filters = {};
  m.prefixNode = null;
  m.prefixSeq = [];
  // Detail-panel search — typing phase flag + state. `term`, `matches`,
  // and `idx` live under detail slice (single object); the mode flag
  // (detailSearchMode) is cleared by resetModes above.
  detail.search = { active: false, term: '', matches: [], idx: 0 };
  detail.ephemeralTerminals = {};
  detail.contentTabs = {};
  m.ui.multiSel = {};
  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default 100.
  // Init is deferred to here (rather than at module-load) so cap reflects
  // the parsed config.
  require('./register').init(config.register || {});
  // Selection state — set/cleared by js/select.js during drag and
  // commit. Lives in the detail slice so the render path can see active
  // selections in the detail panel.
  detail.select = { active: false, kind: 'char',
                    anchor: { line: 0, col: 0 },
                    cursor: { line: 0, col: 0 } };
  // Detail cursor — used by keyboard visual-mode (v/V) to track the
  // logical cursor in the detail panel. Mouse-drag bypasses this
  // (anchor + cursor are set directly from screen coords).
  detail.cursor = { line: 0, col: 0 };
}

function allPanels() {
  const ly = getModel().layout;
  return [...ly.leftPanels, ...ly.rightPanels];
}

// --- Group tree (flatten + expand/collapse) ---
//
// The groups Component owns the tree slice + cascade logic. These wrappers
// dispatch the right Msgs — slice mutations go through the Component's
// update, and the cross-layer cascade Cmds (set_current_group /
// reset_group_context / viewer_reset_chrome) fire as a consequence.
// Kept here as named exports so non-reducer callers (mouse, recursive `"`
// expand, tests) have a stable surface.
function recomputeGroups() {
  require('./plugins/api').dispatchMsg({ type: 'groups_recompute' });
}
function switchGroupsTab(/* tab */) {
  // toggle_groups_tab flips All↔Quick (the only transition we use today);
  // explicit-target setters belong to the Component if ever needed.
  require('./plugins/api').dispatchMsg({ type: 'toggle_groups_tab' });
}
function expandGroup(path, recursive = false) {
  require('./plugins/api').dispatchMsg({ type: 'toggle_group', name: path, recursive });
}
function collapseGroup(path, recursive = false) {
  require('./plugins/api').dispatchMsg({ type: 'toggle_group', name: path, recursive });
}

/** Get selection index for a panel type (default 0). */
function getSel(panelType) { return getModel().ui.sel[panelType] || 0; }

/** Set selection index for a panel type. */
function setSel(panelType, idx) { getModel().ui.sel[panelType] = idx; }

/** Get scroll offset for a panel type (default 0). */
function getScroll(panelType) { return getModel().ui.scroll[panelType] || 0; }

/** Set scroll offset for a panel type. */
function setScroll(panelType, offset) { getModel().ui.scroll[panelType] = offset; }

/**
 * Sync scroll offset so the selected item is visible within innerH rows.
 * Scrolls down if selection is past the viewport bottom; scrolls up if above.
 */
function syncPanelScroll(panelType, innerH) {
  const sel = getSel(panelType);
  const scroll = getScroll(panelType);
  if (sel >= scroll + innerH) setScroll(panelType, sel - innerH + 1);
  else if (sel < scroll) setScroll(panelType, sel);
}

/**
 * Reset the per-group transient UI state. Called when the user navigates
 * to a different group — selections in group-scoped panels go back to
 * row 0, the detail tab returns to "Info", filters/last-action/terminal
 * mode are cleared. Routes through reset_group_context (root reducer) +
 * viewer_reset_chrome (detail Component).
 */
function resetGroupContext() {
  // Phase C: the root-chrome reset moved to a Msg in runtime.update; the
  // viewer-slice half is its own Msg dispatched to the detail Component.
  const dispatch = require('./dispatch');
  dispatch.applyMsg(getModel(), { type: 'reset_group_context' });
  require('./plugins/api').dispatchMsg({ type: 'viewer_reset_chrome' });
}

/**
 * Set the active group by its index in the visible group list. No-op on
 * out-of-range. Resets per-group transient state via resetGroupContext().
 */
function selectGroup(idx) {
  // Phase C: route through nav_select — the root reducer writes ui.sel.groups,
  // then dispatch_msg → groups Component emits the cascade (set_current_group /
  // reset_group_context / viewer_reset_chrome).
  require('./dispatch').applyMsg(getModel(), { type: 'nav_select', panel: 'groups', index: idx });
}

function setDetail(text) {
  // viewer_set_content is handled by the detail Component's update (Phase B);
  // routes via the Component fan-out. Single-writer for the slice through
  // detail.update; every setDetail caller (detail / tabs / actions / help-text
  // / api save-layout-message) ends up as the same reducer write.
  require('./plugins/api').dispatchMsg({ type: 'viewer_set_content', lines: text ? text.split('\n') : [] });
}

// --- Multi-select (bulk-operation operand) ---
//
// `model.ui.multiSel[panelType]` is a Set of stable item IDs. Identity comes
// from each panelType's `idOf(item)` (plugins/api.js#idOf), so selections are
// robust to filtering and re-sorting — you select a thing, not a position.

function toggleMultiSel(panelType, itemId) {
  const ms = getModel().ui.multiSel;
  if (!ms[panelType]) ms[panelType] = new Set();
  const set = ms[panelType];
  if (set.has(itemId)) set.delete(itemId);
  else set.add(itemId);
  if (set.size === 0) delete ms[panelType];
}

function isMultiSel(panelType, itemId) {
  return getModel().ui.multiSel[panelType]?.has(itemId) || false;
}

function clearMultiSel(panelType) {
  delete getModel().ui.multiSel[panelType];
}

function multiSelCount(panelType) {
  return getModel().ui.multiSel[panelType]?.size || 0;
}

module.exports = {
  loadConfig, initState, rebuildLayoutFromConfig,
  allPanels, selectGroup, resetGroupContext, setDetail,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  expandGroup, collapseGroup, recomputeGroups, switchGroupsTab,
};
