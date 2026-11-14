/**
 * Pane helpers.
 *
 * A pane is the unit of placement in the layout grid (a rectangular
 * slot). It holds 1+ tabs; each tab is the content (a panel-type
 * instance). v0.6.1 shipped the panes-as-containers refactor — every
 * `arrange.columns[ci].panels[i]` entry now carries the Pane shape
 * (paneId, tabs[], activeTabId) alongside the legacy Panel fields
 * (id, type, title, hotkey, columnIndex, config, heightPct?,
 * collapsed?) that pool/renderer/free-config still index by.
 *
 * Pane-id format: `pane-<poolId>` for single-mount entries. Stable
 * (1:1 with the placed pool entry) and debugger-friendly. A future
 * multi-mount arc would synth `pane-<poolId>#n`.
 *
 * Zero deps. Used by parser + state.js + leaves/pool + renderer +
 * leaves/free-config — everything that constructs or reads pane shape.
 */
'use strict';

function newPaneId(poolId) {
  return `pane-${poolId}`;
}

/**
 * Inverse of newPaneId: the poolId a `pane-<poolId>` tab-instance id was minted
 * from. Used to turn a terminal's PTY session id (== its tab-instance id) back
 * into the tabPoolId that `remove_tab` + the tab list key on. Passes through an
 * id lacking the prefix unchanged (defensive).
 */
function poolIdOf(instId) {
  return (typeof instId === 'string' && instId.startsWith('pane-')) ? instId.slice(5) : instId;
}

/**
 * Strict focus comparator. v0.6.3 post-arch-arc T3.5 collapsed the
 * Phase-B3 transitional fallback (type/id) — `slice.focus` is now
 * canonically a paneId, seeded by `set_arrange` (which auto-mints
 * `paneId` for panes missing one) and stamped by `_withFocus` on
 * every focus write. Pre-migration callers that hand-set type-form
 * focus must update to paneId-form.
 */
function paneMatchesFocus(p, focus) {
  if (!p || focus == null) return false;
  return p.paneId === focus;
}

/**
 * A pool entry's name — what its pane title / tab-strip entry / terminal footer,
 * the Panels list, the `:hide` / `:show` verbs and a pool drag show: its
 * `title`, else its type's name title-cased (`config_status` → `Config Status`,
 * what the parser has always given a declared pane without a title). The one
 * fallback: the readers used to fall back to the id, the parser to a
 * title-cased type, this to a lower-case one.
 */
function titleOf(entry) {
  if (!entry) return undefined;
  if (entry.title) return entry.title;
  return typeof entry.type === 'string'
    ? entry.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : entry.type;
}

/**
 * THE pane-def shape — the one builder of "this pool entry, placed in a slot".
 *
 *   { ...config, id, type, title, hotkey, columnIndex, config }
 *
 * The entry's own settings (`config`, as the parser keeps them in the pool) are
 * there twice: spread at the top level, so a renderer reads an option straight
 * off `panel` (`panel.topic`), and nested under `config`. Framework keys win over
 * a same-named setting. `title` is titleOf(entry). A setting named like a SLOT
 * field (SLOT_KEYS — `role`, `tabs`, `paneId`, …) stays under `config` only: the
 * slot sets those, and a `role: content` setting made its pane a second content
 * slot (its tabs replaced by Info / Transcript; it took the viewer).
 *
 * Every place that turns a pool entry into a pane def calls this: the parser's
 * layout cells and default layout, boot (arrange.rebuildLayoutFromConfig), a
 * tab switch / add / remove
 * (_rebuildLegacyFields), `:show` + its drag preview
 * (pool.placementFromPoolEntry), the hidden-panel preview (overlay/panel-list),
 * and each tab's init seed (`seed.paneDef`, app/state.js). They built it by hand
 * before and drifted apart — a pane read its settings from `config` after a tab
 * switch but not at boot, and every tab of a multi-tab slot was seeded with the
 * active tab's settings (field report 2026-11-14: a `type: terminal` pane's
 * `title: Dev` never reached its footer).
 *
 * `place` = { hotkey, columnIndex } of the slot. Pure; `entry` is not mutated.
 */
// The fields a SLOT carries on a placed pane (leaves/wm/arrange widenPane,
// _rebuildLegacyFields) — never from a pane's settings.
const SLOT_KEYS = ['paneId', 'tabs', 'activeTabId', 'heightPct', 'collapsed', 'role'];

function paneDef(entry, place) {
  const config = entry.config || {};   // an entry is required (every caller has one)
  const p = place || {};
  const settings = { ...config };
  for (const k of SLOT_KEYS) delete settings[k];
  return {
    ...settings,
    id: entry.id,
    type: entry.type,
    title: titleOf(entry),
    hotkey: p.hotkey,
    columnIndex: p.columnIndex,
    config,
  };
}

/**
 * Return a new pane object with Pane fields minted onto `entry`.
 *
 * Adds:
 *   - paneId       — slot identity (stable across moves / collapse)
 *   - tabs         — array of { id, poolId } (single-tab in default
 *                    placements; multi-tab via the arrange-level tab-add)
 *   - activeTabId  — tabs[0].id
 *
 * Pure: returns a fresh object; the input is not mutated. Aligns with
 * the rest of the leaf pattern (return-new transforms).
 */
function wrapAsPane(entry, paneId) {
  const pane = {
    ...entry,
    paneId,
    tabs: [{ id: entry.id, poolId: entry.id }],
    activeTabId: entry.id,
  };
  // U2e P1a — mark the primary CONTENT slot (the "viewer slot": where Info /
  // action output / opened files / terminals land, and the half/full-view
  // geometry reference) with a STABLE role, decoupled from the instance kind
  // that happens to occupy it. Today that slot is the pane hosting the `detail`
  // kind, so the role is derived from it — behaviour-preserving. `role` is
  // preserved across tab switches / mints (_rebuildLegacyFields) so it survives
  // once the default tab becomes `info` and the `detail` instance is gone (P1b).
  if (entry.type === 'detail') pane.role = 'content';
  return pane;
}

/**
 * Flip a multi-tab pane's active tab. Legacy Panel fields (id/type/
 * title/config + spread config keys) mirror the active tab's pool
 * entry; switching active rebuilds those from the new active's pool
 * entry while preserving placement-only fields (paneId, tabs, hotkey,
 * columnIndex, heightPct, collapsed).
 *
 * Pure: returns a fresh pane object. Callers handle the `arrange`-level
 * splice + undo push + focus follow. Pre-validation (target tab exists,
 * not already active, pool entry exists) is the caller's responsibility.
 */
function setActiveTab(pane, tabPoolId, entry) {
  return _rebuildLegacyFields(pane, pane.tabs, tabPoolId, entry);
}

/**
 * Rebuild a pane's legacy Panel fields (id/type/title/config + spread config
 * keys) from a pool `entry`, with `tabs` + `activeTabId` set explicitly and the
 * placement-only fields (paneId/hotkey/columnIndex/heightPct/collapsed)
 * preserved. Shared by setActiveTab (switch), addTab (append+activate) and
 * removeTab; the pane-def part of the shape is paneDef's.
 */
function _rebuildLegacyFields(pane, tabs, activeTabId, entry) {
  // U2f — a CONTENT slot (role:'content', the viewer slot) has a STABLE identity
  // decoupled from its active tab: `id`/`type`/`title`/`config` stay the slot's
  // ('detail'/'detail'/'Detail'), NOT the active tab's pool entry. The active tab
  // (info / text-view) drives RENDERED content via paneId → active instance; the
  // slot identity is what listings (panelListItems / paneSelectItems / pane-menu),
  // pool_hide, and :save-layout key on. Without this, `pane.id` drifted to
  // `info-<paneId>` on every tab switch — listings showed "Info", and removing the
  // `detail` anchor tab left no stable id to serialize (the P1b follow-up #11).
  // Every OTHER pane keeps mirroring its active tab's entry (the wide-pane shape).
  const isContent = pane.role === 'content';
  const idEntry = isContent
    ? { id: pane.id, type: pane.type, title: pane.title, config: pane.config }
    : entry;
  const next = {
    ...paneDef(idEntry, pane),
    paneId: pane.paneId,
    tabs,
    activeTabId,
  };
  if (pane.heightPct !== undefined) next.heightPct = pane.heightPct;
  if (pane.collapsed === true)      next.collapsed = true;
  // U2e P1a — the content-slot role is a placement-only property of the SLOT, so
  // it rides through a tab switch / mint like paneId/hotkey (the active tab's
  // kind changes; the slot's role does not).
  if (pane.role !== undefined)      next.role = pane.role;
  return next;
}

/**
 * Append a tab `{ id, poolId }` to `pane.tabs` (the U2b mint-into-slot primitive).
 * When `opts.activate`, the appended tab becomes active and the pane's legacy
 * fields rebuild from `entry` (its pool entry); otherwise only `tabs` grows.
 * Pure: returns a fresh pane; the caller handles the arrange splice + focus.
 */
function addTab(pane, tab, entry, opts) {
  const tabs = [...(pane.tabs || []), tab];
  if (opts && opts.activate) return _rebuildLegacyFields(pane, tabs, tab.id, entry);
  return { ...pane, tabs };
}

/**
 * Remove the tab `tabId` from `pane.tabs` (the remove half of the mint-into-slot
 * primitive; mirror of addTab). When the removed tab was the active one, the
 * PREVIOUS tab (index clamped) becomes active and the legacy Panel fields rebuild
 * from its pool entry (resolved from `pool`); a background removal keeps the
 * active tab (its entry re-fetched, so the fields stay consistent). Refuses (→
 * null, caller no-ops) when the tab isn't in the pane, would empty the slot (last
 * tab), or the new-active entry is missing. Pure: returns
 * `{ pane, activeId, wasActive }`.
 */
// Can a tab of this slot be removed? removeTab refuses a slot's LAST tab (a slot
// is never empty), so a pane alone in its slot — a configured `type: terminal`
// or `type: agent` pane — has no close: `x` is the menu there, and nothing may
// offer `x close` for it.
function canRemoveTab(pane) {
  return ((pane && pane.tabs) || []).length > 1;
}

function removeTab(pane, tabId, pool) {
  const tabs = pane.tabs || [];
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0 || !canRemoveTab(pane)) return null;
  const nextTabs = tabs.slice(0, idx).concat(tabs.slice(idx + 1));
  const wasActive = pane.activeTabId === tabId;
  const activeId = wasActive ? nextTabs[Math.min(idx, nextTabs.length - 1)].id : pane.activeTabId;
  const entry = (pool || {})[activeId];
  if (!entry) return null;
  return { pane: _rebuildLegacyFields(pane, nextTabs, activeId, entry), activeId, wasActive };
}

module.exports = {
  newPaneId,
  poolIdOf,
  paneDef,
  titleOf,
  wrapAsPane,
  setActiveTab,
  addTab,
  removeTab,
  canRemoveTab,
  paneMatchesFocus,
  SLOT_KEYS,
};
