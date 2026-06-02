/**
 * Pure builder for the layout `arrange` struct.
 *
 * `arrange = { leftWidth, detailHeightPct, leftPanels, rightPanels, pool }`
 * is the runtime layout state owned by the layout Component's slice.
 * This leaf builds a fresh one from a parsed config — used at boot
 * (state.initState seeds the slice) and again on `:restore-layout`
 * (a pure replay of the same logic without clobbering expanded-groups
 * state, focus, etc.).
 *
 * Dual of `leaves/pool.js`: pool.js DERIVES from arrange; this leaf
 * BUILDS arrange. Both are pure return-new transforms over plain data;
 * tests drive them directly.
 *
 * Zero deps beyond other leaves (pane, hotkeys).
 */
'use strict';

const mpane = require('./pane');
const { RIGHT_HOTKEY_POOL } = require('./hotkeys');

/**
 * Build a fresh arrange struct from a parsed config. Pure — reads only
 * the passed-in config and returns a new object.
 *
 * Two paths:
 *   - `config.layout` present (parser output): walk left_panels /
 *     right_panels, widen each into the runtime pane shape (legacy
 *     Panel fields alongside Pane fields, see [[v061-arc]] wide
 *     intermediate form). Multi-tab cells from the parser survive
 *     verbatim; single-tab pool refs go through mpane.wrapAsPane.
 *   - no `config.layout` (JSON callers / pre-pane fixtures): synthesize
 *     the same default the parser produces, plus a matching pool.
 */
function rebuildLayoutFromConfig(config) {
  const ly = config.layout;
  const out = { leftWidth: 30, detailHeightPct: 60, leftPanels: [], rightPanels: [], pool: {} };

  if (ly) {
    const leftPanelsSrc = ly.left_panels || (ly.left && ly.left.panels) || [];
    const rightPanelsSrc = ly.right_panels || (ly.right && ly.right.panels) || [];
    out.leftWidth = ly.left_width || (ly.left && ly.left.width) || 30;
    out.detailHeightPct = ly.detail_height_pct || 60;
    // Every configured panel (placed + hidden) keyed by id. Parser
    // always emits one; default to {} for legacy JSON callers.
    out.pool = ly.pool || {};
    // Plugin-specific panel options ride alongside type/title/hotkey/
    // column so the panel def can read them off `panel` directly.
    // Spread first so the framework keys win on any overlap. `id` plumbs
    // the link back to the pool — pool.js reads it to compute
    // placed vs hidden.
    //
    // Multi-tab cells: when the parser emitted paneId + tabs[] +
    // activeTabId, preserve those verbatim. Single-tab pool refs and
    // JSON callers go through wrapAsPane.
    const widenPane = (p, hotkey, column) => {
      const wide = {
        ...(p.config || {}),
        id: p.id,
        type: p.type,
        title: p.title || p.type.replace(/_/g, ' '),
        hotkey,
        column,
      };
      if (p.heightPct !== undefined) wide.heightPct = p.heightPct;
      if (p.collapsed === true)      wide.collapsed = true;
      if (p.paneId && Array.isArray(p.tabs) && p.tabs.length > 0) {
        wide.paneId = p.paneId;
        wide.tabs = p.tabs;
        wide.activeTabId = p.activeTabId || p.tabs[0].id;
        return wide;
      }
      return mpane.wrapAsPane(wide, mpane.newPaneId(p.id));
    };
    out.leftPanels = leftPanelsSrc.map((p, i) =>
      widenPane(p, p.hotkey || String(i + 1), 'left'));
    const rightExplicit = new Set(rightPanelsSrc.map(p => p.hotkey).filter(Boolean));
    const rightAuto = RIGHT_HOTKEY_POOL.filter(k => !rightExplicit.has(k));
    out.rightPanels = rightPanelsSrc.map(p =>
      widenPane(p, p.hotkey || (rightAuto.shift() || ''), 'right'));
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

module.exports = { rebuildLayoutFromConfig };
