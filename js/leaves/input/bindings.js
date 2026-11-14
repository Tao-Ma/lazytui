/**
 * Footer / help key-hint registry (v0.6.7 Phase 3, E9).
 *
 * A pure, dependency-free leaf — the SINGLE source for the terse key HINTS shown
 * in the footer row. Historically these were typed by hand and scattered through
 * `render/footer.js` (the focus-kind segments and the modal-mode tails). This
 * table is the one place a terse hint is declared; `render/footer.js` projects
 * from it — the same declarative-table-kills-drift pattern as
 * `leaves/input/modes.js`.
 *
 * NOT consumed by `panel/content/help.js`: the help viewer tab is a separate, more
 * detailed reference (`x  Open menu popup`, not the terse `x menu`), built from
 * each panel def's `keyHints` + the dynamic leader-chord walk over
 * `leaves/input/keybindings` — a different, already-single source. Routing it
 * through this terse registry would downgrade it (see docs/v0.6.7.md E9).
 *
 * Scope (E9 "Focused+"): this registry holds KEY HINTS only. The genuinely
 * LIVE status the footer interleaves — a search match count `[3/12]`, the typed
 * filter text, the leader pending-keys, a terminal's name — is NOT a key hint;
 * it stays computed in `footer.js` and is merged around these hints. Dispatch
 * also stays where it is (the `handleNormalKey` switch + each Component's
 * `update`); an entry's `verb`, when present, is documentation of what key the
 * hint refers to, not a dispatch rewrite. A future extensible/powerline footer
 * is a separate segment-composition arc — `footerFor()` becomes its "keys
 * segment" and the live-status functions become other segments.
 *
 * Entry shape:
 *   { context, label, when?, footer?, order }
 *     context — 'list' | 'actions' | 'groups' | 'detail' | 'terminal' (focus-kind) |
 *               a panelType ('docker'/'files'/'history'/'config-status') |
 *               a modal-mode flag ('copyMode'/'menuOpen'/…) — see CONTEXTS.
 *     label   — the rendered hint, e.g. 'x menu', '↑↓ select', 'Enter run'.
 *     when    — optional pure (ctx) => bool guard (ctx = live facts the footer
 *               passes: { total } for detail, { dead, closable, typeable } for
 *               terminal). Absent =
 *               always shown.
 *     footer  — false to hide from the footer (help-only). Default true.
 *     order   — sort key within a context (footer curates by it; limited width).
 */
'use strict';

// Common keys shared by every list-panel focus-kind footer (mirrors the
// repeated head of the old hand-typed strings).
const _LIST_COMMON = [
  { label: '↑↓ select', order: 10 },
  { label: '←→ panel',  order: 20 },
  { label: '/ filter',  order: 30 },
  { label: '+/_ view',  order: 40 },
  { label: 'x menu',    order: 50 },
  { label: 'q quit',    order: 60 },
];

// context → ordered hint entries. A context is a focus-kind, a panelType
// (per-panel extras appended after the focus-kind keys), or a modal-mode flag
// (its static tail; the live prefix is prepended by footer.js).
const BINDINGS = {
  // --- focus-kind footers (non-modal) ---
  list:    _LIST_COMMON,
  actions: [..._LIST_COMMON, { label: 'Enter run',     order: 70 }],
  groups:  [..._LIST_COMMON, { label: 'Enter actions', order: 70 }],
  // The detail (viewer) footer is conditional — guards mirror footer.js's old
  // inline branches exactly. The live search count `n/N [i/n]` is appended by
  // footer.js (it carries a live number); everything else is a key hint here.
  detail: [
    { label: '←→ panel',      order: 10 },
    { label: ']\\[ tabs',     order: 20, when: (c) => c.total > 1 },
    { label: '+/_ view',      order: 30 },
    { label: 'x menu',        order: 40 },
    { label: 'q quit',        order: 50 },
    { label: '/ search',      order: 70 },
  ],
  // A focused `terminal` pane (field report 2026-11-14: it showed the list
  // hints, and nothing said Enter hands the keyboard over). Facts from
  // panel/terminal-surfaces focusedTerminalState: dead / closable / typeable.
  // Enter does nothing on a terminal with no interior (minimized), or where no
  // PTY can run (node-pty absent) → no hint;
  // `x` closes a dead tab only when the slot keeps another (else it's the menu).
  terminal: [
    { label: '←→ panel',        order: 10 },
    { label: '+/_ view',        order: 20 },
    { label: 'x close',         order: 30, when: (c) => c.dead && c.closable },
    { label: 'x menu',          order: 31, when: (c) => !(c.dead && c.closable) },
    { label: 'q quit',          order: 40 },
    { label: 'Enter type here', order: 50, when: (c) => c.typeable && !c.dead },
    { label: 'Enter restart',   order: 51, when: (c) => c.typeable && c.dead },
  ],

  // (Per-panel extras — docker i/L/s, config-status t/s/r, history Enter, files'
  //  computed hint — stay as `keyHints` on the panel DEFS: they are already a
  //  single source the footer AND help both read, so there's no drift to fix.
  //  They aren't focus-kind contexts and would collide with 'actions'/'groups'
  //  here, so they live on the defs, not in this table.)

  // --- modal-mode static tails (live prefix prepended by footer.js) ---
  copyMode:   [{ label: '↑↓ select', order: 10 }, { label: 'Esc cancel', order: 20 }, { label: 'Enter copy', order: 30 }],
  menuOpen:   [{ label: '↑↓ select', order: 10 }, { label: 'Esc close',  order: 20 }, { label: 'Enter run',  order: 30 }],
  prefixMode: [{ label: '<key> select', order: 10 }, { label: 'Esc cancel', order: 20 }],
  filterMode: [{ label: 'Esc clear', order: 10 }, { label: 'Enter ok', order: 20 }],
  detailSearchMode: [{ label: '↑↓ step', order: 10 }, { label: 'Esc cancel', order: 20 }, { label: 'Enter commit', order: 30 }],
  terminalMode: [{ label: 'Ctrl+\\ return to TUI', order: 10 }],
  agentMode: [
    { label: 'Enter send', order: 10 },
    { label: 'Esc interrupt/leave', order: 20 },
    { label: 'PgUp/PgDn scroll', order: 30 },
  ],
};

// Pick a context's entries that pass their guard, sorted by order.
function _active(context, ctx) {
  const entries = BINDINGS[context];
  if (!entries) return [];
  return entries
    .filter(e => (e.when ? e.when(ctx || {}) : true))
    .sort((a, b) => a.order - b.order);
}

/**
 * Footer hint LABELS for a context as a bare array. `ctx` carries the live
 * guard facts. Callers that interleave a LIVE prefix (search count, filter
 * text) join these themselves; `footerFor` wraps it for the common case.
 */
function footerSegs(context, ctx) {
  return _active(context, ctx).filter(e => e.footer !== false).map(e => e.label);
}

/**
 * Footer hints as a ` a | b | c` string (leading space, the footer's assembly
 * convention), or '' when the context has no active entries.
 */
function footerFor(context, ctx) {
  const segs = footerSegs(context, ctx);
  return segs.length ? ' ' + segs.join(' | ') : '';
}

module.exports = { footerSegs, footerFor };
