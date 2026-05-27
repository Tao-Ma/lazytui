/**
 * App state — config loading, layout initialization, state management.
 * Zero dependencies (uses local modules).
 */
'use strict';

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
  // Sub-mode of designMode. When true, keystrokes drive a single-line
  // edit of the currently-focused panel's title instead of design's
  // navigation keys. Mode chain runs this before designMode.
  designTitleEditMode: false,
  // Prefix (leader) mode — the leader key was pressed and we're waiting
  // for the next key in the sequence. prefixNode points at the current
  // position in the binding tree (a subtree); resolving a leaf runs it
  // and exits, resolving a subtree descends + stays in prefix mode.
  prefixMode: false,
  prefixNode: null,
  prefixSeq: [],              // tokens consumed so far (footer / popup display)
  // List-panel select mode (entered with `v`). While active, `space`
  // toggles the focused row's multi-selection instead of opening the
  // leader. Outside this mode `space` is the leader — see dispatch.
  listSelectMode: false,
  // True iff S.layout has been mutated since the last on-disk YAML
  // sync. Set by design-mode mutations (and any future caller that
  // changes S.layout at runtime); cleared by the `:save-layout`
  // command. Surfaced in the footer as "• unsaved" so the user
  // knows runtime state has diverged from the config file.
  layoutDirty: false,
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
    // In-process JS parser — was an out-of-process `python -m parser`
    // call until the parser was rewritten in JS. Errors thrown by
    // parse() are ParseError subclasses with composed messages; let
    // them propagate so tui.js's top-level handler prints them and
    // exits non-zero (mirrors the old "parser: <msg>" stderr line).
    const { parse } = require('./parser');
    S.config = parse(path.resolve(configPath));
  }
  S.projectDir = S.config.project_dir || '.';
  S.configPath = path.resolve(configPath);
}

// --- Layout initialization ---

/**
 * Build a fresh `{ leftWidth, detailHeightPct, leftPanels, rightPanels }`
 * struct from a parsed config. Pure with respect to S (reads S only for
 * the implicit groups-detection branch when no `layout:` block exists,
 * which initState handles by passing the config explicitly).
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
  const config = S.config;
  setTheme(config.theme || 'default');

  S.layout = rebuildLayoutFromConfig(config);

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
  // Mode flags — cleared from the single registry (js/modes.js) so this
  // can't drift out of sync with the modeChain / overlay / modal lists.
  // Non-flag buffers (filters, prefixNode/Seq, detailSearch object) are
  // reset explicitly below since the registry only flips the booleans.
  require('./modes').resetModes(S);
  S.filters = {};
  S.prefixNode = null;
  S.prefixSeq = [];
  // Detail-panel search — typing phase flag + state. `term`, `matches`,
  // and `idx` live under S.detailSearch (single object); the mode flag
  // (detailSearchMode) is cleared by resetModes above.
  S.detailSearch = { active: false, term: '', matches: [], idx: 0 };
  S.ephemeralTerminals = {};
  S.contentTabs = {};
  S.multiSel = {};
  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default 100.
  // Init is deferred to here (rather than at module-load) so cap reflects
  // the parsed config.
  require('./register').init(config.register || {});
  // Selection state — set/cleared by js/select.js during drag and
  // commit. Stored on S so the render path can see active selections
  // in the detail panel.
  S.select = { active: false, kind: 'char',
               anchor: { line: 0, col: 0 },
               cursor: { line: 0, col: 0 } };
  // Detail cursor — used by keyboard visual-mode (v/V) to track the
  // logical cursor in the detail panel. Mouse-drag bypasses this
  // (anchor + cursor are set directly from screen coords).
  S.detailCursor = { line: 0, col: 0 };
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
  // List-select (v-mode) is armed globally but its operand (multiSel)
  // is group-scoped and just got cleared — drop the mode too so the
  // user doesn't land in a new group with a sticky [select] tag over
  // an empty selection and a dead leader key.
  S.listSelectMode = false;
  // Detail-panel transient state is tied to the OUTGOING group's content
  // (which the new group is about to replace). Drop the visual selection
  // and cursor so a half-made selection / stale cursor doesn't carry a
  // phantom highlight + bogus yank coordinates into the new content.
  // (detailSearch is invalidated by setDetail when the content swaps.)
  if (S.select) S.select.active = false;
  if (S.detailCursor) S.detailCursor = { line: 0, col: 0 };
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
  // Replacing the detail content invalidates any committed search: its
  // matches[] hold line/col offsets into the PREVIOUS content, so the
  // highlight renderer and n/N navigation would point at the wrong
  // lines. Drop the search rather than render stale highlights. (The
  // typing-phase flag detailSearchMode is owned by the search module's
  // own enter/exit; this only clears a committed search.)
  if (S.detailSearch && S.detailSearch.active) {
    S.detailSearch = { active: false, term: '', matches: [], idx: 0 };
  }
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
  S, loadConfig, initState, rebuildLayoutFromConfig,
  allPanels, selectGroup, resetGroupContext, setDetail,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  expandGroup, collapseGroup, recomputeGroups, switchGroupsTab,
};
