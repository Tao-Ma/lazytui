/**
 * App state — config loading, layout initialization, state management.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { setTheme } = require('./themes');

// --- Shared mutable state ---

const S = {
  config: null,
  projectDir: '.',
  layout: { leftWidth: 30, leftPanels: [], rightPanels: [], detailHeightPct: 60 },
  // S.groups is the *visible* flattened tree — recomputed on init and
  // after any expand/collapse via recomputeGroups(). Source of truth is
  // S.config.groups (flat dict, dotted-path keys) + S.expandedGroups.
  groups: [],
  // Set<dottedPath> — every entry's children render below it. Default
  // empty: only top-level groups visible at boot.
  expandedGroups: new Set(),
  // Groups panel sub-tab. 'all' = the tree; 'quick' = flat list of nodes
  // marked `quick: true` in YAML (any depth — a deep leaf surfaces here
  // alongside a flat root). Toggle with `t` when the panel is focused.
  groupsTab: 'all',
  currentGroup: '',         // dotted path of selected group; index = getSel('groups')
  // Generic per-panel selection state
  sel: {},      // panelType -> selected index
  scroll: {},   // panelType -> scroll offset
  lastRunAction: '',
  detailLines: [],
  detailScroll: 0,
  activeTab: 0,
  focus: 'groups',
  // Layout-engine outputs. Both are rewritten in full by calcLayout()
  // (heights) and renderNormal/Half/Full (bounds), so they are only
  // valid AFTER the current frame's layout pass. Reading them inside a
  // panel renderer is implicit coupling — renderers receive width/height
  // as args. Reading them from input/stream/mouse handlers (which fire
  // between frames) is the intended use.
  panelHeights: {},           // type -> rows allocated to panel (incl. borders)
  viewMode: 'normal',
  panelBounds: {},            // type -> { x, y, w, h } screen coordinates
  // Mode flags — read by layout.render()/footer to detect overlay-active.
  // Per-mode transient buffers (typed text, selected index, item lists)
  // live module-private inside their respective mode modules
  // (filter.js, copy.js, menu.js, cmdline.js, design.js).
  menuOpen: false,
  filterMode: false,
  filters: {},                // panelType -> committed filter text
  copyMode: false,
  cmdMode: false,
  confirmMode: false,
  promptMode: false,
  designMode: false,
  terminalMode: false,        // true when keystrokes go to PTY
  ephemeralTerminals: {},     // groupName -> { key -> { cmd, label } } (runtime-added)
  multiSel: {},               // panelType -> Set<itemId> — bulk-operation operand
  // Terminal focus tracking (DEC 1004). Default true so a TUI launched
  // in a non-1004 terminal (no focus reporting) still refreshes. Flips
  // to false on \e[O (focus lost), true on \e[I (focus gained). Read
  // by the refresh loop in tui.js to pause background polling when the
  // user has tabbed away.
  focused: true,
};

// --- Config loading ---

function loadConfig(configPath) {
  const ext = path.extname(configPath);
  if (ext === '.json') {
    S.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    // Run the parser as a Python module — no temp script, no /tmp cleanup.
    // Stderr is left unredirected so parse errors surface to the user.
    // Mirror the `do` shim: prefer the project venv, fall back to system
    // python3 when it's missing (system PyYAML is enough for the parser).
    const parserDir = path.resolve(__dirname, '..');
    const venv = path.join(parserDir, '.venv/bin/python');
    const py = fs.existsSync(venv) ? venv : 'python3';
    const out = execSync(`${JSON.stringify(py)} -m parser ${JSON.stringify(path.resolve(configPath))}`, {
      encoding: 'utf8', timeout: 10000, cwd: parserDir,
    });
    S.config = JSON.parse(out);
  }
  S.projectDir = S.config.project_dir || '.';
  S.configPath = path.resolve(configPath);
}

// --- Layout initialization ---

function initState() {
  const config = S.config;
  setTheme(config.theme || 'default');

  const ly = config.layout;

  if (ly) {
    const leftPanelsSrc = ly.left_panels || (ly.left && ly.left.panels) || [];
    const rightPanelsSrc = ly.right_panels || (ly.right && ly.right.panels) || [];
    S.layout.leftWidth = ly.left_width || (ly.left && ly.left.width) || 30;
    S.layout.detailHeightPct = ly.detail_height_pct || 60;
    // Plugin-specific panel options (parser PanelConfig.config) ride
    // alongside type/title/hotkey/column so the panel def can read them
    // off `panel` directly. Spread first so the framework keys win on
    // any overlap.
    S.layout.leftPanels = leftPanelsSrc.map((p, i) => ({
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
    S.layout.rightPanels = rightPanelsSrc.map(p => ({
      ...(p.config || {}),
      type: p.type,
      title: p.title || p.type.replace(/_/g, ' '),
      hotkey: p.hotkey || (rightAuto.shift() || ''),
      column: 'right',
    }));
  } else {
    const hasContainers = Object.values(config.groups).some(g => g.containers && g.containers.length);
    const hasConfigFiles = config.files && config.files.length;
    S.layout.leftPanels = [];
    let hk = 1;
    if (hasContainers) {
      S.layout.leftPanels.push({ type: 'containers', title: 'Containers', hotkey: String(hk++), column: 'left' });
    }
    S.layout.leftPanels.push({ type: 'groups', title: 'Groups', hotkey: String(hk++), column: 'left' });
    if (hasConfigFiles) {
      S.layout.leftPanels.push({ type: 'file-manager', title: 'Files', hotkey: String(hk++), column: 'left' });
    }
    S.layout.rightPanels = [
      { type: 'actions', title: 'Actions', hotkey: '7', column: 'right' },
      { type: 'detail', title: 'Detail', hotkey: '8', column: 'right' },
    ];
  }

  // Tree state: start collapsed (only top-level nodes visible). The cursor
  // lands on the first visible row, which is the first top-level group.
  S.expandedGroups = new Set();
  S.groupsTab = 'all';
  recomputeGroups();
  S.currentGroup = S.groups.length ? S.groups[0].name : '';
  S.sel = {};
  S.scroll = {};
  S.detailLines = [];
  S.detailScroll = 0;
  S.activeTab = 0;
  S.focus = 'groups';
  // Mode flags — buffers reset inside their owning modules.
  S.menuOpen = false;
  S.filterMode = false;
  S.filters = {};
  S.copyMode = false;
  S.cmdMode = false;
  S.designMode = false;
  S.terminalMode = false;
  S.ephemeralTerminals = {};
  S.multiSel = {};
}

function allPanels() { return [...S.layout.leftPanels, ...S.layout.rightPanels]; }

// --- Group tree (flatten + expand/collapse) ---
//
// S.config.groups is a flat dict keyed by dotted path, in DFS pre-order
// (parent before children). Visibility = "every ancestor is expanded".
// recomputeGroups() rebuilds S.groups in display order based on
// S.expandedGroups; resyncGroupCursor() keeps the cursor / S.currentGroup
// pointing at a still-visible row after the tree shape changes.

function _isVisible(path) {
  const all = S.config && S.config.groups;
  if (!all) return false;
  const g = all[path];
  if (!g) return false;
  if (!g.parent) return true;
  return S.expandedGroups.has(g.parent) && _isVisible(g.parent);
}

function recomputeGroups() {
  const all = (S.config && S.config.groups) || {};
  const out = [];
  if (S.groupsTab === 'quick') {
    // Flat list of pinned nodes regardless of tree shape. YAML order is
    // already DFS pre-order from the parser, which is what users will
    // expect when they scan the list.
    for (const path of Object.keys(all)) {
      if (all[path].quick) out.push(all[path]);
    }
  } else {
    for (const path of Object.keys(all)) {
      if (_isVisible(path)) out.push(all[path]);
    }
  }
  S.groups = out;
}

/**
 * Switch the groups panel between its 'all' (tree) and 'quick' (flat
 * pinned) sub-tabs. Cursor follows the same path if it's still visible
 * in the new tab; otherwise resyncGroupCursor falls back to row 0.
 */
function switchGroupsTab(tab) {
  if (tab !== 'all' && tab !== 'quick') return;
  if (S.groupsTab === tab) return;
  S.groupsTab = tab;
  recomputeGroups();
  resyncGroupCursor();
}

/**
 * After a tree-shape change (expand/collapse), keep S.currentGroup on a
 * still-visible row. If the previously-selected path isn't visible, walk
 * up to the nearest visible ancestor; if even that fails, fall back to row 0.
 * Only fires resetGroupContext when the active group actually changes.
 */
function resyncGroupCursor() {
  const all = (S.config && S.config.groups) || {};
  let target = S.currentGroup;
  let idx = S.groups.findIndex(g => g.name === target);
  while (idx === -1 && target) {
    target = all[target] ? all[target].parent : null;
    if (!target) break;
    idx = S.groups.findIndex(g => g.name === target);
  }
  if (idx === -1) idx = 0;
  const newName = S.groups[idx] ? S.groups[idx].name : '';
  const groupChanged = newName !== S.currentGroup;
  S.sel.groups = idx;
  S.currentGroup = newName;
  if (groupChanged) resetGroupContext();
}

/**
 * Expand `path` (mark it open). When `recursive`, also expand every
 * descendant — useful for "see everything under this branch" with `"`.
 * No-op for leaves (children list is empty).
 */
function expandGroup(path, recursive = false) {
  const all = (S.config && S.config.groups) || {};
  const g = all[path];
  if (!g || !g.children || g.children.length === 0) return;
  S.expandedGroups.add(path);
  if (recursive) {
    for (const childPath of g.children) expandGroup(childPath, true);
  }
  recomputeGroups();
  resyncGroupCursor();
}

/**
 * Collapse `path` and (if recursive) every descendant's expanded state.
 * Recursive collapse strips child entries from S.expandedGroups too so a
 * later non-recursive expand of the same node opens just one level.
 */
function collapseGroup(path, recursive = false) {
  const all = (S.config && S.config.groups) || {};
  const g = all[path];
  if (!g) return;
  if (recursive && g.children) {
    for (const childPath of g.children) collapseGroup(childPath, true);
  }
  S.expandedGroups.delete(path);
  recomputeGroups();
  resyncGroupCursor();
}

/** Get selection index for a panel type (default 0). */
function getSel(panelType) { return S.sel[panelType] || 0; }

/** Set selection index for a panel type. */
function setSel(panelType, idx) { S.sel[panelType] = idx; }

/** Get scroll offset for a panel type (default 0). */
function getScroll(panelType) { return S.scroll[panelType] || 0; }

/** Set scroll offset for a panel type. */
function setScroll(panelType, offset) { S.scroll[panelType] = offset; }

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
 * mode are cleared. Pure mutation of S; doesn't render.
 */
function resetGroupContext() {
  S.sel.actions = 0;
  S.sel.containers = 0;
  S.activeTab = 0;
  S.lastRunAction = '';
  delete S.filters.actions;
  delete S.filters.containers;
  // Group-scoped multi-selections drop on group switch — selecting
  // containers in group A shouldn't follow you into group B.
  delete S.multiSel.actions;
  delete S.multiSel.containers;
  S.terminalMode = false;
}

/**
 * Set the active group by its index in S.groups. No-op on out-of-range.
 * Resets per-group transient state via resetGroupContext().
 */
function selectGroup(idx) {
  if (idx < 0 || idx >= S.groups.length) return;
  S.sel.groups = idx;
  S.currentGroup = S.groups[idx].name;
  resetGroupContext();
}

function setDetail(text) {
  S.detailLines = text ? text.split('\n') : [];
  S.detailScroll = 0;
}

// --- Multi-select (bulk-operation operand) ---
//
// `S.multiSel[panelType]` is a Set of stable item IDs. Identity comes from
// each panelType's `idOf(item)` (plugins/api.js#idOf), so selections are
// robust to filtering and re-sorting — you select a thing, not a position.

function toggleMultiSel(panelType, itemId) {
  if (!S.multiSel[panelType]) S.multiSel[panelType] = new Set();
  const set = S.multiSel[panelType];
  if (set.has(itemId)) set.delete(itemId);
  else set.add(itemId);
  if (set.size === 0) delete S.multiSel[panelType];
}

function isMultiSel(panelType, itemId) {
  return S.multiSel[panelType]?.has(itemId) || false;
}

function clearMultiSel(panelType) {
  delete S.multiSel[panelType];
}

function multiSelCount(panelType) {
  return S.multiSel[panelType]?.size || 0;
}

module.exports = {
  S, loadConfig, initState, allPanels, selectGroup, resetGroupContext, setDetail,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  expandGroup, collapseGroup, recomputeGroups, switchGroupsTab,
};
