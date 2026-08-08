# Per-pane text selection

Drag-to-select text in **any focused pane** — the component-ports pane, the
groups/actions lists, the wire list — not just the viewer. A drag copies the
selected text to the yank register (and mirrors it to the system clipboard via
OSC 52), highlights it, and offers it to the right-click **Copy selection** and
**Send selection to port…** entries.

This generalizes the viewer's long-standing rich selection to every pane, with
one behavioural rule and one config switch.

## Model — one selection shape, on the owning instance's slice

Selection state lives on the owning pane instance's slice — for every pane:

```js
slice.select = {
  anchor: { line, col },  // absolute content-line index + DISPLAY column
  cursor: { line, col },
  kind: 'char',           // 'char' (drag / vim `v`) — 'line' (vim `V`)
  active,
}
```

`line` is an **absolute content-line index** and `col` a **display column**, so a
selection stays anchored to content as a pane scrolls and maps CJK / wide glyphs
correctly (a click on either cell of a 2-wide glyph grabs the whole glyph). The
selected **text is derived on demand** from the owning pane's content — never
stored — so it rides the WAL and replays like any other state. Ownership is
implicit: a pane owns a selection when its ACTIVE instance carries
`select.active` (`select-view.selectionFor`; more than one pane can own one at
a time — see §Interaction). Every tab is its own instance, so a content tab's
selection is **per-tab persisted by construction** — switch away and back and
it's still there; a hidden tab's selection never owns the app-wide one.

One Msg vocabulary drives it: `select_begin` / `select_extend` / `select_cancel`
(plus the keyboard visual-mode's `select_set_cursor` / `select_scroll_view`),
wrapped to the target pane's active instance. Single-writer = the update spine:
the content panes (info / text-view / agent) claim these arms in their own
Component update, clamped against their buffer (`leaves/text/text-view-update`);
every other pane gets the shared pure transition (`select-core.reduceSelect`)
applied by the loop's generic fallback (`dispatch/runtime/loop._selectFallback`)
— one seam, zero per-Component edits.

## Architecture — three seams, no per-pane render edits

| Concern | Where |
|---|---|
| Pure geometry (display-col ↔ codepoint, selected text, highlight) + the shared state arms (`reduceSelect`) | `leaves/text/select-core.js` |
| Generic per-pane state fallback (unclaimed `select_*` → `slice.select`) | `dispatch/runtime/loop.js` `_selectFallback` |
| Capture each pane's content, apply the highlight, resolve the owner + text | `panel/select-view.js`, hung off the `renderPanel` wrapper in `panel/api.js` |
| Drive the mouse (press → arm, motion → begin/extend, release → settle) | `dispatch/control/input.js` |
| Enablement (global default + per-pane override) | `panel/select-config.js` |

Every pane already draws its box through `panel/api.js`'s `renderPanel`, so that
one wrapper is where content is **captured** (keyed by paneId, per frame) and the
selected range is **decorated** before the border is drawn — universal, with no
edits to any Component's `render()`. paint announces the pane being rendered
(`select-view.enterPane`/`exitPane`) so the wrapper can attribute content to a
paneId without threading it through every call site. Content panes hand
`renderPanel` a pre-windowed buffer (`windowed`, via `buildTextView`) and
self-decorate offset-aware, so the wrapper only captures for them; their text
extraction reads the instance's own full buffer (`slice.lines`, or the agent
pane's `slice.transcript`) instead of the windowed capture. Exception: a
windowed pane that applies a per-line DISPLAY transform (the text-view right-
aligns its completion status rows) records the full display-space buffer as
`fullLines`, which extraction prefers over `slice.lines` — so a yank maps the
captured (display) columns onto the glyphs actually shown, not the stored
left-aligned bytes at shifted columns. Panes with no transform pass no
`fullLines` and keep the `slice.lines` fallback described above.

`select-core` is a pure bottom leaf (depends only on `leaves/text/ansi`) and the
**single source of truth for selection geometry and state transitions** — the
content panes' reducer and the loop's generic fallback both drive
`reduceSelect`, and every consumer resolves display-col ↔ codepoint mapping,
selected-text extraction, and highlight decoration through it.

## Interaction — arm on press, begin on drag

A press **arms** a selection (records the anchor) but does not start one; the
**first motion** begins it. So a plain click still selects a row / activates /
focuses as before, and only a drag starts text selection — on every pane,
content panes included. A drag past the pane's edge pins to the nearest content
row, so dragging to the border extends to the first/last visible line. Not
every interior row is content: a press beyond the pane's **selectable extent**
does not arm, and a drag pins to its last row — the frame capture records the
extent per pane (a windowed pane may declare `selectableRows` when its window
carries non-content rows: the agent pane's status/input chrome and its
provisional streaming preview; a full-content capture simply ends at its last
line). Release
**settles**: a real drag is auto-copied to the register and stays highlighted
(offered to right-click **Copy selection** / **Send selection to port…**); a
no-drag press clears (no stray one-char selection). A fresh press anywhere
clears **every** pane's visible selection before arming.

The content panes additionally drive the same `slice.select` from the keyboard
visual-mode state machine (`v`/`V`/`y`, `leaves/text/text-view-update`) —
scroll-anchored across their full scrollback. Mouse and keyboard are two drivers
of ONE state shape, not two backends.

More than one pane can hold an active selection at a time (a keyboard
visual-mode selection plus a persisted mouse one, or a hidden tab re-owning on
switch-back), so nothing resolves ownership by "the first active one found": the
mouse gesture is scoped to its ARMED pane throughout, the highlight paints on
**every** owning pane, and the right-click menu's **Copy selection** / **Send
selection to port…** resolve the pane under the POINTER first
(`selectionFor`), falling back to `activeSelection()` — the **focused** pane's
own selection, else the first in pane order. Sweeps cancel all owners, at two
scopes: a fresh press clears every **visible** selection (each pane's active
instance), while the group-switch `select_cancel_all` Cmd sweeps the whole
instance **registry** (`allSelections`) — a hidden tab's per-tab-persisted
selection must not survive into a new group, where it would re-own over
whatever content the group loads into that instance on switch-back.

> **Unified (2026-08-01).** Selection previously had two state shapes: the
> content panes' in-slice `select` and a single-owner root `model.selection`
> (+ `mouse_sel_*` reducer arms) for every other pane. A 2026-07-30 review had
> deferred collapsing them because each shape carried a property the other
> lacked — but the one-tab system (U2) had already dissolved the blocker:
> every tab is its own instance, so per-slice selection is per-tab persisted
> *by construction*, and the loop's generic `select_*` fallback preserves the
> universal zero-per-pane-edit property on the slice side. `model.selection`,
> the `mouse_sel_*` arms, and the viewer facade (`panel/content/select.js`)
> are gone; mouse-selection Msgs in old replay recordings no longer fold —
> the released `sel_*` root arms (v0.6.8–v0.6.9) as well as the interim
> `mouse_sel_*` rename.

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
  ports:  { type: component-ports,
            select: false }             # opt this pane out
  groups: { type: groups, select: true } # force on even if the global default is off
```

Resolution: the per-pane `select:` flag wins; otherwise the global `selection:`
default applies (`panel/select-config.selectionEnabledFor`). The gate covers
**mouse** selection on every pane — content panes included (pre-unification the
viewer was exempt). The keyboard visual-mode (`v`/`V`) is a keybinding feature
and stays ungated.

## Tests

- `js/test/test-select-core.js` — the pure core (char/line/CJK selection,
  decorate, the shared `reduceSelect` state arms, the group-switch clear Cmd).
- `js/test/test-select.js` — the content-pane selection driven through the
  production seams (wrapped `select_*` dispatch + `select-view` reads) + the
  keyboard visual-mode state machine.
- `js/test/smoke/pane-select.js` — the real mouse pipeline end-to-end on the
  ports pane: drag → select + copy, highlight paints, click leaves nothing,
  right-click offers Copy selection, and the global / per-pane gate.
- `js/test/smoke/agent-pane.js` — the selectable-extent geometry on the agent
  pane: drag on a transcript row selects + copies, the status/input chrome
  rows never arm, a drag into the streaming preview pins to the settled tail.
