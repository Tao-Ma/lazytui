# Per-pane text selection

Drag-to-select text in **any focused pane** — the component-ports pane, the
groups/actions lists, the wire list — not just the viewer. A drag copies the
selected text to the yank register (and mirrors it to the system clipboard via
OSC 52), highlights it, and offers it to the right-click **Copy selection** and
**Send selection to port…** entries.

This generalizes the viewer's long-standing rich selection to every pane, with
one behavioural rule and one config switch.

## Model — one selection, owned by a pane

A single selection is live at a time. It lives on the root model:

```js
model.selection = {
  paneId,                 // the owning pane — "focused-pane-only" as a single owner
  anchor: { line, col },  // absolute content-line index + DISPLAY column
  cursor: { line, col },
  kind: 'char',           // 'char' (drag) — 'line' reserved
  active,
}
```

`line` is an **absolute content-line index** and `col` a **display column**, so a
selection stays anchored to content as a pane scrolls and maps CJK / wide glyphs
correctly (a click on either cell of a 2-wide glyph grabs the whole glyph). The
selected **text is derived on demand** from the owning pane's captured content
lines — never stored — so it rides the WAL and replays like any other state.

Single-writer = the reducer, via three arms: `sel_begin` / `sel_extend` /
`sel_clear` (`dispatch/update/reducer.js`).

## Architecture — three seams, no per-pane render edits

| Concern | Where |
|---|---|
| Pure geometry (display-col ↔ codepoint, selected text, highlight) | `leaves/text/select-core.js` |
| Capture each pane's content + apply the highlight | `panel/select-view.js`, hung off the `renderPanel` wrapper in `panel/api.js` |
| Drive the mouse (press → arm, motion → begin/extend, release → copy) | `dispatch/control/input.js` |
| Enablement (global default + per-pane override) | `panel/select-config.js` |

Every pane already draws its box through `panel/api.js`'s `renderPanel`, so that
one wrapper is where content is **captured** (keyed by paneId, per frame) and the
selected range is **decorated** before the border is drawn — universal, with no
edits to any Component's `render()`. paint announces the pane being rendered
(`select-view.enterPane`/`exitPane`) so the wrapper can attribute content to a
paneId without threading it through every call site.

`select-core` is a pure bottom leaf (depends only on `leaves/text/ansi`) and the
**single source of truth for selection geometry** — both the per-pane path
(`panel/select-view`) and the viewer's own selection (`panel/viewer/select`)
delegate to it for display-col ↔ codepoint mapping, selected-text extraction, and
highlight decoration.

## Interaction — arm on press, begin on drag

A press **arms** a selection (records the anchor) but does not start one; the
**first motion** begins it. So a plain click still selects a row / activates as
before, and only a drag starts text selection. Release copies a real drag to the
register and keeps it highlighted; a no-drag press clears it (no stray one-char
selection). Right-click surfaces **Copy selection** and **Send selection to
port…** for the active selection.

The **viewer** keeps its own richer in-slice selection (`panel/viewer/select.js`)
— scroll-anchored across its full scrollback, plus visual-mode `v`/`V`/`y`. At
most one of the two backends is active at a time.

The two share the geometry **core** but keep **distinct state shapes**, on
purpose: the viewer's selection is per-content-tab persisted and driven by a
keyboard state machine, which doesn't fit the shared single-owner
`model.selection` field. So `panel/viewer/select.js` is now just the viewer's
coordinate contract + impure service (read the detail slice's `select`, dispatch
the `select_*` Msgs, push a commit to the register), ~125 lines with zero
duplicated geometry — everything computational lives in `select-core`.

### On table panes

Selection copies the pane's rendered content text (markup stripped). A drag lets
you grab an exact substring — e.g. just `0/CAFE` out of a ports row — rather than
a whole padded line. Column padding between fields is literal spaces, so a
selection spanning two columns includes that whitespace.

## Config — on by default, per-pane override

Enabled everywhere by default. Turn it off globally, or per pane:

```yaml
selection: false            # global default (top-level; default: true)

panels:
  logs:   { type: detail }              # viewer — its own selection, unaffected
  ports:  { type: component-ports,
            select: false }             # opt this pane out
  groups: { type: groups, select: true } # force on even if the global default is off
```

Resolution: the per-pane `select:` flag wins; otherwise the global `selection:`
default applies (`panel/select-config.selectionEnabledFor`).

## Tests

- `js/test/test-select-core.js` — the pure core (char/line/CJK selection,
  decorate, the reducer arms).
- `js/test/smoke/pane-select.js` — the real mouse pipeline end-to-end on the
  ports pane: drag → select + copy, highlight paints, click leaves nothing,
  right-click offers Copy selection, and the global / per-pane gate.
