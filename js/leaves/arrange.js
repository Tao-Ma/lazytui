/**
 * Pure builder for the layout `arrange` struct.
 *
 * `arrange = { columns: [{width?, panels: [...]}], detailHeightPct, pool }`
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
const { hotkeyPoolForColumn } = require('./hotkeys');

/**
 * Build a fresh arrange struct from a parsed config. Pure — reads only
 * the passed-in config and returns a new object.
 *
 * Two paths:
 *   - `config.layout` present (parser output): walk columns[], widen each
 *     pane into the runtime shape (legacy Panel fields alongside Pane
 *     fields, see [[v061-arc]] wide intermediate form). Multi-tab cells
 *     from the parser survive verbatim; single-tab pool refs go through
 *     mpane.wrapAsPane.
 *   - no `config.layout` (JSON callers / pre-pane fixtures): synthesize
 *     the same default the parser produces, plus a matching pool.
 */
function rebuildLayoutFromConfig(config) {
  const ly = config.layout;
  const out = { columns: [], detailHeightPct: 60, pool: {} };

  if (ly) {
    out.detailHeightPct = ly.detail_height_pct || 60;
    // Every configured panel (placed + hidden) keyed by id. Parser
    // always emits one; default to {} for legacy JSON callers.
    // Fresh-spread the map so the runtime slice doesn't share a ref
    // with `config.layout.pool` — a future `pool_rename` or per-entry
    // title mutation would otherwise mutate the parser's output and
    // corrupt the source-of-truth config (undo snapshot is a JSON
    // deep-copy, so a ref-corruption pre-snapshot would persist past
    // `u`). Entries themselves are still shared by id; deep-spread
    // them only when an entry-level mutator lands.
    out.pool = { ...(ly.pool || {}) };
    const N = (ly.columns || []).length;
    // Plugin-specific panel options ride alongside type/title/hotkey/
    // columnIndex so the panel def can read them off `panel` directly.
    // Spread first so the framework keys win on any overlap. `id` plumbs
    // the link back to the pool — pool.js reads it to compute
    // placed vs hidden.
    //
    // Multi-tab cells: when the parser emitted paneId + tabs[] +
    // activeTabId, preserve those verbatim. Single-tab pool refs and
    // JSON callers go through wrapAsPane.
    const widenPane = (p, hotkey, columnIndex) => {
      const wide = {
        ...(p.config || {}),
        id: p.id,
        type: p.type,
        title: p.title || p.type.replace(/_/g, ' '),
        hotkey,
        columnIndex,
      };
      if (p.heightPct !== undefined) wide.heightPct = p.heightPct;
      if (p.collapsed === true)      wide.collapsed = true;
      if (p.paneId && Array.isArray(p.tabs) && p.tabs.length > 0) {
        wide.paneId = p.paneId;
        // Slice() the tabs array so the runtime slice doesn't share
        // a ref with the parser's output — a future `tab_add` /
        // `tab_reorder` reducer mutating in place would otherwise
        // corrupt config.layout.pool's pane entries. Tab objects
        // themselves are still shared (no mutator hits them today).
        wide.tabs = p.tabs.slice();
        wide.activeTabId = p.activeTabId || p.tabs[0].id;
        return wide;
      }
      return mpane.wrapAsPane(wide, mpane.newPaneId(p.id));
    };
    out.columns = (ly.columns || []).map((col, ci) => {
      const isLast = ci === N - 1;
      const pool = hotkeyPoolForColumn(ci, N);
      const explicit = new Set((col.panels || []).map(p => p.hotkey).filter(Boolean));
      const auto = pool.filter(k => !explicit.has(k));
      const panels = (col.panels || []).map((p, i) =>
        widenPane(p, p.hotkey || (auto.shift() || ''), ci));
      const out = { panels };
      // Last column's width is implicit; everyone else carries it.
      if (!isLast && col.width != null) out.width = col.width;
      return out;
    });
  } else {
    // No layout block — defensive fallback for JSON callers or tests
    // that bypass the parser. Synthesize the same 2-column default the
    // parser produces, plus a matching pool.
    const firstColPanels = [];
    const lastColPanels = [];
    const hasContainers = Object.values(config.groups || {}).some(g => g.containers && g.containers.length);
    const hasConfigFiles = config.files && config.files.length;
    let hk = 1;
    const push = (columnIndex, panel) => {
      const arr = columnIndex === 0 ? firstColPanels : lastColPanels;
      arr.push(mpane.wrapAsPane(panel, mpane.newPaneId(panel.id)));
      out.pool[panel.id] = {
        id: panel.id, type: panel.type, title: panel.title, config: {}, _synthesized: true,
      };
    };
    if (hasContainers) {
      push(0, { id: 'containers', type: 'containers', title: 'Containers', hotkey: String(hk++), columnIndex: 0 });
    }
    push(0, { id: 'groups', type: 'groups', title: 'Groups', hotkey: String(hk++), columnIndex: 0 });
    if (hasConfigFiles) {
      push(0, { id: 'files', type: 'files', title: 'Files', hotkey: String(hk++), columnIndex: 0, source: 'declared' });
    }
    push(1, { id: 'actions', type: 'actions', title: 'Actions', hotkey: '7', columnIndex: 1 });
    push(1, { id: 'detail',  type: 'detail',  title: 'Detail',  hotkey: '8', columnIndex: 1 });
    out.columns = [
      { width: 30, panels: firstColPanels },
      { panels: lastColPanels },
    ];
  }
  return out;
}

module.exports = { rebuildLayoutFromConfig };
