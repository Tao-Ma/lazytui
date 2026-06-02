/**
 * App state — config loading, layout initialization, slice-reset wrappers.
 *
 * No mutable state lives here. The root model lives in runtime.js
 * (getModel()); Component slices live in panel/api.js's registry. This
 * module is the boot/init layer (loadConfig + initState) plus the small
 * set of read/write helpers the rest of the codebase imports from `./state`
 * (getSel / setSel / getScroll / setScroll / toggleMultiSel / allPanels /
 * resetGroupContext / selectGroup / setViewerContent / recomputeGroups / …).
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
const { setTheme } = require('../render/themes');
const { getModel } = require('./runtime');
const mpane = require('../leaves/pane');

// --- Component slice resolution ---
//
// state.js's own init/reset code (initState) writes into Component slices
// directly via these helpers — no longer through the `S` shim. Lazy auto-
// register covers tests that touch state without explicit Component setup;
// production already registers detail + groups at boot (tui.js).
let _detailAutoRegistered = false;
function _detailSlice() {
  const api = require('../panel/api');
  let s = api.getComponentSlice('detail');
  if (!s) {
    if (!_detailAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _detailAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's primary instance
    api.registerComponent(require('../panel/viewer/viewer'));
    s = api.getComponentSlice('detail');
  }
  return s;
}

let _groupsAutoRegistered = false;
function _groupsSlice() {
  const api = require('../panel/api');
  let s = api.getComponentSlice('groups');
  if (!s) {
    if (!_groupsAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _groupsAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's primary instance
    api.registerComponent(require('../panel/navigator/groups'));
    s = api.getComponentSlice('groups');
  }
  return s;
}

// Same lazy-auto-register pattern for the layout (chrome) Component
// added in Phase 1a. Production registers via tui.js boot; tests +
// initState callers that don't go through tui get the slice via this
// helper. The "first-touch" point is initState (sets initial focus +
// viewMode tag), so the helper is called there.
let _layoutAutoRegistered = false;
function _layoutSlice() {
  const api = require('../panel/api');
  let s = api.getComponentSlice('layout');
  if (!s) {
    if (!_layoutAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _layoutAutoRegistered = true;
    }
    api.registerComponent(require('../panel/layout'));
    s = api.getComponentSlice('layout');
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
    const { parse } = require('../parser');
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
  const out = { leftWidth: 30, detailHeightPct: 60, leftPanels: [], rightPanels: [], pool: {} };

  if (ly) {
    const leftPanelsSrc = ly.left_panels || (ly.left && ly.left.panels) || [];
    const rightPanelsSrc = ly.right_panels || (ly.right && ly.right.panels) || [];
    out.leftWidth = ly.left_width || (ly.left && ly.left.width) || 30;
    out.detailHeightPct = ly.detail_height_pct || 60;
    // v0.6 pool: every configured panel (placed + hidden) keyed by id.
    // Parser always emits one; default to {} for legacy JSON callers.
    out.pool = ly.pool || {};
    // Plugin-specific panel options (parser PanelConfig.config) ride
    // alongside type/title/hotkey/column so the panel def can read them
    // off `panel` directly. Spread first so the framework keys win on
    // any overlap. `id` plumbs the link back to the pool — Phase 1
    // derivations (`leaves/pool`) read it to compute placed vs hidden.
    out.leftPanels = leftPanelsSrc.map((p, i) => mpane.wrapAsPane({
      ...(p.config || {}),
      id: p.id,
      type: p.type,
      title: p.title || p.type.replace(/_/g, ' '),
      hotkey: p.hotkey || String(i + 1),
      column: 'left',
    }, mpane.newPaneId(p.id)));
    const { RIGHT_HOTKEY_POOL } = require('../leaves/hotkeys');
    const rightExplicit = new Set(rightPanelsSrc.map(p => p.hotkey).filter(Boolean));
    const rightAuto = RIGHT_HOTKEY_POOL.filter(k => !rightExplicit.has(k));
    out.rightPanels = rightPanelsSrc.map(p => mpane.wrapAsPane({
      ...(p.config || {}),
      id: p.id,
      type: p.type,
      title: p.title || p.type.replace(/_/g, ' '),
      hotkey: p.hotkey || (rightAuto.shift() || ''),
      column: 'right',
    }, mpane.newPaneId(p.id)));
  } else {
    // No layout block — defensive fallback for JSON callers or tests
    // that bypass the parser. Synthesize the same default the parser
    // produces, plus a matching pool.
    const hasContainers = Object.values(config.groups).some(g => g.containers && g.containers.length);
    const hasConfigFiles = config.files && config.files.length;
    let hk = 1;
    const push = (col, panel) => {
      const arr = col === 'left' ? out.leftPanels : out.rightPanels;
      arr.push(mpane.wrapAsPane(panel, mpane.newPaneId(panel.id)));
      out.pool[panel.id] = {
        id: panel.id, type: panel.type, title: panel.title, config: {}, _synthesized: true,
      };
    };
    if (hasContainers) {
      push('left', { id: 'containers', type: 'containers', title: 'Containers', hotkey: String(hk++), column: 'left' });
    }
    push('left', { id: 'groups', type: 'groups', title: 'Groups', hotkey: String(hk++), column: 'left' });
    if (hasConfigFiles) {
      push('left', { id: 'files', type: 'files', title: 'Files', hotkey: String(hk++), column: 'left', source: 'declared' });
    }
    push('right', { id: 'actions', type: 'actions', title: 'Actions', hotkey: '7', column: 'right' });
    push('right', { id: 'detail',  type: 'detail',  title: 'Detail',  hotkey: '8', column: 'right' });
  }
  return out;
}

function initState() {
  const m = getModel();
  const config = m.config;
  setTheme(config.theme || 'default');

  // Force-register the layout / groups / detail Components — production
  // (tui.js) already did, but the test harness path may have skipped them.
  // The lazy auto-register fallbacks here are belt-and-suspenders.
  _layoutSlice();
  _groupsSlice();
  _detailSlice();

  // Seed the layout arrange struct from config via the layout
  // Component's own writer (set_arrange Msg). Single-writer holds at
  // boot too — initState doesn't poke at slice fields directly anymore.
  // All other slice/model state initializes from runtime.init() /
  // Component.init() defaults; only config-derived seeds (arrange,
  // currentGroup, register cap) and the theme set need a write here.
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', {
    type: 'set_arrange',
    arrange: rebuildLayoutFromConfig(config),
    dirty: false,
  }));

  // Rebuild the visible group list from config, then seed currentGroup
  // from the first visible row. recomputeGroups dispatches into the
  // groups Component; set_current_group rides through the root reducer.
  recomputeGroups();
  const groupsAfter = _groupsSlice();
  const firstName = groupsAfter.list.length ? groupsAfter.list[0].name : '';
  require('../dispatch/dispatch').applyMsg({ type: 'set_current_group', name: firstName });

  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default
  // 100. Init deferred to here so cap reflects the parsed config.
  // BLESSED outside-writer (docs/v0.5-layering.md §5).
  require('../feature/register').init(config.register || {});
}

function allPanels() {
  const slice = _layoutSlice();
  const ly = slice ? slice.arrange : { leftPanels: [], rightPanels: [] };
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
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'groups_recompute' }));
}
function switchGroupsTab(/* tab */) {
  // toggle_groups_tab flips All↔Quick (the only transition we use today);
  // explicit-target setters belong to the Component if ever needed.
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_groups_tab' }));
}
function expandGroup(path, recursive = false) {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_group', name: path, recursive }));
}
function collapseGroup(path, recursive = false) {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_group', name: path, recursive }));
}

// Phase 4a — nav chrome (cursor / scroll / multiSel) lives on each
// Navigator Component's slice. v0.6.1 Phase 3 collapses single-panel
// Components to `slice.nav = entry`; multi-panel Components (today:
// files) keep `slice.nav[panelType] = entry`. The helpers walk
// panel-type → owning Component → that Component's slice → nav entry,
// detecting shape by presence of `cursor` on slice.nav.

function _navEntry(panelType) {
  const api = require('../panel/api');
  const compName = api.getComponentOwningPanel(panelType);
  if (!compName) return null;
  const slice = api.getComponentSlice(compName);
  if (!slice || !slice.nav) return null;
  if ('cursor' in slice.nav) return slice.nav;        // single-panel
  return slice.nav[panelType] || null;                // multi-panel
}

function _navDispatch(panelType, msg) {
  const api = require('../panel/api');
  const compName = api.getComponentOwningPanel(panelType);
  if (!compName) return;
  api.dispatchMsg(api.wrap(compName, { ...msg, panel: panelType }));
}

/** Get selection index for a panel type (default 0). */
function getSel(panelType) { const e = _navEntry(panelType); return e ? e.cursor : 0; }

/** Set selection index for a panel type. */
function setSel(panelType, idx) { _navDispatch(panelType, { type: 'set_cursor', index: idx | 0 }); }

/** Get scroll offset for a panel type (default 0). */
function getScroll(panelType) { const e = _navEntry(panelType); return e ? e.scroll : 0; }

/** Set scroll offset for a panel type. */
function setScroll(panelType, offset) { _navDispatch(panelType, { type: 'set_scroll', offset: offset | 0 }); }

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
  // viewer-slice half is its own Msg dispatched to the viewer Component.
  // v0.6.1 Phase 8 — viewer target resolved at dispatch time so multi-
  // viewer (future) wires up correctly; null result drops the reset Cmd.
  const dispatch = require('../dispatch/dispatch');
  const api = require('../panel/api');
  const route = require('../leaves/route');
  dispatch.applyMsg({ type: 'reset_group_context' });
  const target = route.resolveTarget('viewer');
  if (target) api.dispatchMsg(api.wrap(target, { type: 'viewer_reset_chrome' }));
}

/**
 * Set the active group by its index in the visible group list. No-op on
 * out-of-range. Resets per-group transient state via resetGroupContext().
 */
function selectGroup(idx) {
  // Phase 4b — the uniform `nav_select` Msg retired; dispatch.navSelect
  // does the per-Component routing (set_cursor → owning Component +
  // show_selected_info + the groups_selected cascade).
  require('../dispatch/dispatch').navSelect('groups', idx);
}

function setViewerContent(tabId, text) {
  // viewer_set_content is handled by the detail Component's update (Phase B);
  // routes via the Component fan-out. Single-writer for the slice through
  // detail.update; every viewer-content writer (history / config-status /
  // help-text / commands / api save-layout-message) ends up as the same
  // reducer write.
  //
  // v0.6.1 Phase 8 — explicit tabId is the producer-side address. When
  // tabId is null the destination resolves via route.resolveTarget('viewer'):
  // focused viewer-kind tab / lastViewerTab / first viewer in rightPanels /
  // any viewer / null. With one viewer (today) this is always 'detail'.
  if (tabId == null) {
    const route = require('../leaves/route');
    tabId = route.resolveTarget('viewer');
    if (tabId == null) return;   // no viewer registered — drop the write
  }
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap(tabId, { type: 'viewer_set_content', lines: text ? text.split('\n') : [] }));
}

// --- Multi-select (bulk-operation operand) ---
//
// Each Navigator's `slice.nav[panelType].multiSel` is a Set of stable
// item IDs. Identity comes from each panelType's `idOf(item)`
// (panel/api.js#idOf), so selections are robust to filtering and
// re-sorting — you select a thing, not a position. Writes go through
// wrapped Msgs (multisel_toggle / multisel_select_all / multisel_clear)
// so each Component owns its own multiSel Set.

function toggleMultiSel(panelType, itemId) {
  _navDispatch(panelType, { type: 'multisel_toggle', id: itemId });
}

function isMultiSel(panelType, itemId) {
  const e = _navEntry(panelType);
  return !!(e && e.multiSel.has(itemId));
}

function clearMultiSel(panelType) {
  _navDispatch(panelType, { type: 'multisel_clear' });
}

function multiSelCount(panelType) {
  const e = _navEntry(panelType);
  return e ? e.multiSel.size : 0;
}

module.exports = {
  loadConfig, initState, rebuildLayoutFromConfig,
  allPanels, selectGroup, resetGroupContext, setViewerContent,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  expandGroup, collapseGroup, recomputeGroups, switchGroupsTab,
};
