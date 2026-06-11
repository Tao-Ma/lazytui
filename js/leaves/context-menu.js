/**
 * Context-menu entry registry (v0.6.4 Theme F follow-on) — the items shown
 * by a right-click. ONE shared context menu; entries are data, so adding a
 * future action is a one-line push here, not a re-plumb of the menu modal.
 *
 * Each entry is `{ id, show(ctx), build(ctx) }`:
 *   - `show(ctx)`  — the pane/tab-awareness hook. Returns whether this entry
 *                    is offered in the current context. DEFAULT = always on;
 *                    no entry gates on the pane yet (deliberately deferred —
 *                    the hook exists so awareness lands without a re-plumb).
 *   - `build(ctx)` — returns a concrete `[label, action, arg?]` menu row, or
 *                    `null` when the entry has nothing to act on right here
 *                    (e.g. no text under the cursor, no live selection). A
 *                    null row is dropped — applicability, distinct from the
 *                    `show` awareness gate.
 *
 * `ctx` is resolved from the click location by `dispatch/input._resolveContextAt`:
 *   { paneKind, lineText, itemLabel, selectionText }
 *
 * The `action` strings are `handleAction` verbs (here: `copy_text`, whose
 * arg is the text to yank); `menu_activate` routes the chosen row's
 * (action, arg) back through the `menu_action` Cmd. Override surface stays
 * the stable intent/verb edge — same discipline as `keys:` / `mouse:`.
 *
 * Dependency-free leaf — pure, no requires.
 */
'use strict';

// Entries are grouped into sections; buildContextItems drops empty sections
// and inserts a `null` separator between the populated ones. The TARGET
// section is contextual (copy what's under the cursor); the GENERAL section
// is always available — it's what makes a right-click on EMPTY space (no
// copyable target) still open a populated menu, and the seam for future
// global actions. Each entry keeps its `show(ctx)` awareness hook.
const SECTIONS = [
  {
    id: 'target',
    entries: [
      {
        id: 'copy-target',
        show: () => true,
        // Copy the line (viewer/detail) or row label (list pane) under cursor.
        build: (ctx) => {
          const isLine = ctx.lineText != null;
          const text = isLine ? ctx.lineText : ctx.itemLabel;
          if (text == null || text === '') return null;
          return [isLine ? 'Copy line' : 'Copy item', 'copy_text', text];
        },
      },
      {
        id: 'copy-selection',
        show: () => true,
        // Copy the active text selection — live now that a viewer drag-select
        // persists after release (select.settle keeps it active).
        build: (ctx) => {
          if (!ctx.selectionText) return null;
          return ['Copy selection', 'copy_text', ctx.selectionText];
        },
      },
    ],
  },
  {
    id: 'general',
    entries: [
      // Always-available, target-independent actions — present everywhere
      // (incl. empty space). A starter set; extend here as new global mouse
      // actions land. Both map to existing safe handleAction verbs.
      { id: 'refresh', show: () => true, build: () => ['Refresh', 'refresh'] },
      { id: 'help',    show: () => true, build: () => ['Help',    'show_help'] },
    ],
  },
];

// Flat view of every entry — for tests / introspection (id lookup).
const ENTRIES = SECTIONS.flatMap(s => s.entries);

/**
 * Build the context-menu rows for a click context. Each section is filtered
 * by its entries' `show(ctx)` gate then `build(ctx)` (null = inapplicable,
 * dropped); empty sections vanish, and a `null` separator is inserted between
 * the populated ones. Result is a list of `[label, action, arg?]` rows (with
 * `null` separators) ready for `menu_open`.
 */
function buildContextItems(ctx = {}) {
  const out = [];
  for (const sec of SECTIONS) {
    const rows = [];
    for (const e of sec.entries) {
      if (e.show && !e.show(ctx)) continue;
      const row = e.build(ctx);
      if (row) rows.push(row);
    }
    if (!rows.length) continue;
    if (out.length) out.push(null);  // separator between populated sections
    out.push(...rows);
  }
  return out;
}

module.exports = { buildContextItems, SECTIONS, ENTRIES };
