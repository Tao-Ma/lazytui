# lazytui — Refactor backlog (round 1 — archived)

> **ARCHIVED — historical record.** All round-1 items shipped on
> 2026-05-01. Phase 2 F (frame stack) was deliberately skipped — the
> if-chain is fine without plugin-registered overlays as a use case.
> This file is kept so future rounds can reference what was already
> tried; it is not an active backlog. New findings go in a fresh
> "## Round 2" section here, or in FUTURE.md if they're feature work.

Found by the architecture / render-engine / code-layout review
(2026-05-01). Items below are structural improvements to existing code,
not new features (those live in FUTURE.md).

Each entry has a phase + severity tag. **Sequencing matters** — the
ordered list below is the execution plan; the per-section detail
follows.

## Execution order

1. ~~**Test harness** (G, medium)~~ — done (2026-05-01).
2. ~~**Plugin API facade + framework defaults** (B + C2, medium)~~ — done (2026-05-01).
3. ~~**Mode-buffer migration** (A, medium)~~ — done (2026-05-01).
4. ~~**corePlugin split** (C1, medium)~~ — done (2026-05-01).
5. ~~**Central frame loop** (phase 2 A+D+E)~~ — done (2026-05-01)
   across three commits. Phase 2 F (frame stack) skipped — the
   if-chain is fine without plugin-registered overlays as a use case.
6. ~~**tabs.js extract** (D, low-med)~~ — done (2026-05-01).
7. ~~**Detail tab bounds in S.panelBounds** (E, low)~~ — done (2026-05-01).
8. ~~**Single stdout.write per overlay paint** (phase 2 C, low)~~ — done (2026-05-01).
9. ~~**Mode enter/exit naming** (F, low)~~ — done (2026-05-01).

---

## Phase 1 — Architecture findings

### B. Plugin API facade — one re-exporter [medium]

**Status:** ✅ done

`plugins/docker.js` imports from 10 host paths (ansi, panel, themes,
state, filter, exec, decorators, stream, terminal, render-queue, ./api).
Half are re-exported via `./api` already (`hub`, `decorators`); the
others aren't. Third-party plugin authors have no documented contract
for "what plugins may call."

**Change:** `plugins/api.js` re-exports the full plugin-facing surface:
`esc`, `visibleLen`, `stripMarkup`, `theme`, `renderPanel`,
`getSel`, `getScroll`, `isMultiSel`, `getFilter`, `execAsync`,
`decorate`, `streamCommand`, `addEphemeralTab`, `scheduleRender`.
Plugins import everything from `./api`. Update PLUGINS.md to enumerate.

**Touches:** `plugins/api.js` (~+30 LOC), `plugins/docker.js` (-9
import lines), `plugins/core.js` (-import lines), PLUGINS.md.

### C2. Framework defaults out of corePlugin [medium]

**Status:** ✅ done

`plugins/core.js` imports `../dispatch` (for `:help → handleAction`)
and `../cleanup` (for `:quit`). Plugin importing dispatch inverts
layering. Symptom: `:help`, `:quit`, `:refresh` are framework actions
treated as plugin commands.

**Change:** Move them into `plugins/api.js` as built-in commands
registered before any user plugin. The api already imports nothing
above L3 so it can hold the wiring.

**Touches:** `plugins/core.js` (-3 commands, -2 imports),
`plugins/api.js` (+~30 LOC framework default commands).

### E. Detail tab bounds via S.panelBounds [low]

**Status:** ✅ done

`input.js` reaches into `plugins/core.js` for `getDetailTabBounds()`.
Plugin module-private state accessed via getter; render side-effect
drives input behavior.

**Change:** detail tab bounds populated in `S.panelBounds.detail.tabs[]`
during render, read during input. Generalizes to other plugins wanting
sub-region click areas later.

**Touches:** `plugins/core.js` (move tab-bounds capture),
`input.js` (read from S, drop import), maybe `state.js` (init shape).

---

## Phase 2 — Render engine findings

### Phase 2 A. Central frame loop with dirty bit [medium]

**Status:** ✅ done (single trailing render at the input-pump level; no
explicit dirty bit was needed — diff-render makes a no-op paint cheap)

`render()` is called from ~40 sites. Effect handlers manually invoke
render(). Choice between `render()` / `redraw()` / `scheduleRender()`
is per-call. Forgetting to render is a recurring bug class.

**Change:** dirty bit + frame loop driven by `scheduleRender`. Effect
handlers mutate state, frame loop reads dirty + paints once per tick.
Strip render() calls from ~30 sites; leave them only in modeChain
where sync paint is needed for cursor placement.

Bundle with phase 2 D (cursor) and phase 2 E (resize) — they trivially
fold in. Plus phase 2 F (frame stack) — same architectural shift.

**Touches:** `layout.js`, `dispatch.js`, all mode modules.
**Size:** ~120 LOC across the bundle.

### Phase 2 D. Cursor visibility derived from state [medium]

**Status:** ✅ done

Cursor show/hide is emitted from multiple sites: boot,
`renderTerminalOverlay`, `renderCmdline`, `exitCmdline`, `saveLayout`.
Forget one and the cursor is stuck.

**Change:** at the end of every `render()`, derive cursor visibility
from state and emit show/hide once: `if (S.terminalMode || S.cmdMode)
showCursor() else hideCursor()`. Remove the per-mode emissions.

**Touches:** `layout.js` (+10 LOC), remove from `cmdline.js`,
`design.js`, `terminal-overlay` path.

### Phase 2 E. Resize debounce [low-med]

**Status:** ✅ done

`process.stdout.on('resize', () => render())` — modern terminals send
30+ events/sec during a window-edge drag. Each runs full calcLayout +
force-full repaint.

**Change:** `scheduleRender()` instead of `render()`. 50 ms debounce
coalesces the burst.

**Touches:** `tui.js` (1 LOC).

### Phase 2 C. Single stdout.write per overlay paint [low]

**Status:** ✅ done

`renderOverlay` (panel.js), `renderDesignOverlay` (design.js), and
`renderCmdline`/`paintMatchRow` (cmdline.js) emit one `stdout.write`
per row. Under SSH or slow TTY, occasional tearing.

**Change:** build one string with embedded `\x1b[row;colH` cursor
moves, write once. Same correctness, fewer syscalls.

**Touches:** `panel.js#renderOverlay`, `design.js#renderDesignOverlay`,
`cmdline.js#paintMatchRow`. ~20 LOC.

### Phase 2 F. Frame stack instead of imperative render() [low]

**Status:** open

`render()` is a long imperative function dispatching viewMode, then
terminal overlay, then footer, then four conditional overlays.
Reading it to figure out paint order takes work.

**Change:** explicit frame stack: `[{ paint, when }]` entries iterated
by render(). Plugins could register entries (debug panel, profiler) —
same contract as decorators.

**Touches:** `layout.js#render` (~25 LOC). Pairs with phase 2 A.

### Phase 2 B. Pass bounds to plugin.render explicitly [low]

**Status:** ✅ done

`calcLayout()` writes `S.panelHeights` and `S.panelBounds`; plugin
renderers read them implicitly. A third-party plugin author has to
know height comes from S, not from the `(panel, w, h, S)` signature.

**Change:** pass `{ width, height, bounds }` explicitly to
plugin.render; drop the `S.panelHeights` reads inside renderers.

**Touches:** `layout.js#rendererFor`, plugin renderers. ~15 LOC.

### Phase 2 G. Footer segments model [low]

**Status:** ✅ done

`renderFooter` is 60 LOC of mode-conditional string concat. Pattern
will degrade as new modes ship. A two-segment model
(`leftSegments[]`, `rightSegments[]`, joined with separator) absorbs
more decorators without if-chains.

**Touches:** `layout.js#renderFooter` (~25 LOC).

---

## Phase 3 — Code layout findings

### A. Mode buffers out of S, into mode modules [medium]

**Status:** ✅ done

S has 12 fields that are mode-specific transient buffers:
`filterText`, `filterPanel`, `copyOptions`, `copyIdx`, `cmdText`,
`cmdSel`, `cmdMatches`, `menuItems`, `menuIdx`. Inconsistent: design.js
already keeps its state module-private.

**Change:** migrate menu/copy/cmdline/filter to design.js's pattern.
Mode owns enter/exit/handle/render plus private state. S keeps only
the `*Mode` flag (so the conductor can detect overlay-active for
force-full-repaint).

Adding a mode = drop a new file + one entry in modeChain.

**Touches:** `state.js` (-12 fields), `menu.js`, `copy.js`,
`cmdline.js`, `filter.js`, `dispatch.js` (modeChain unchanged
shape but reads via mode module). ~80 LOC moved.

### C1. Split corePlugin per panel type [medium]

**Status:** ✅ done

`plugins/core.js` is 556 LOC — largest module in the codebase. Five
panel types in one file.

**Change:**
```
plugins/core/index.js          # registers all
plugins/core/groups.js         # ~80 LOC + row:right:groups decorator
plugins/core/actions.js        # ~80 LOC
plugins/core/file-manager.js   # ~70 LOC
plugins/core/history.js        # ~120 LOC
plugins/core/detail.js         # ~100 LOC
```

Each file is ~the size of plugins/docker.js's panel-type section.
Same shape as a third-party plugin would be.

**Touches:** new directory, `tui.js` (require path unchanged with
`require('./plugins/core')` resolving to `core/index.js`).

### D. Extract tabs.js [low-med]

**Status:** ✅ done

Tab arithmetic (mapping `S.activeTab` integer to `(kind, item)`) is
reimplemented at 5+ sites: terminal.js (×5), detail.js, plugins/core.js,
input.js, layout.js. Adding a third tab kind would need touching all.

**Change:** new `tabs.js`:
```js
function getTabs(groupName)   // [{kind, key, item}]
function activeTab(S)         // current tab object
function cycleTab(S, dir)
function setTabByIdx(S, idx)
function addEphemeralTab(...) // moves from terminal.js
function removeEphemeralTab(...)
```

terminal.js shrinks to PTY-session lifecycle only.

**Touches:** new `tabs.js` (~120 LOC), terminal.js (-50 LOC),
detail.js (-15 LOC), plugins/core.js (-10 LOC), input.js, layout.js.

**Defer until:** a concrete need (third tab kind, tab reordering
feature, etc.) — opportunistic otherwise.

### F. Mode enter/exit naming [low]

**Status:** ✅ done

Five modes, four naming patterns:
- `openMenu / closeMenu`
- `enterCopyMode / exitCopyMode`
- `enterFilter / exitFilter`
- `enterCmdline / exitCmdline`
- `enterDesignMode / (callbacks)`

**Change:** standardize on `<mode>.enter(...)` / `<mode>.exit(...)`.
Module name carries the qualifier.

**Touches:** all 5 mode modules + their callers (dispatch.js mostly).
~5 renames + import-site updates.

### G. Test harness [medium] — BLOCKS THE REST

**Status:** ✅ done

Each `test-*.js` (6 files) hand-rolls assert/eq + manual
`process.exit(fail === 0 ? 0 : 1)`. No describe/it grouping; no
per-section context in failure messages; per-file fresh require cache
only because each file is its own node invocation.

**Change:** ~80 LOC harness in `tests/runner.js` providing:
- `describe(name, fn)`, `it(name, fn)`, `assert(cond, msg)`,
  `eq(a, b, msg)`
- Per-`it` aggregation with section context
- `tests/run.js` discovers and runs every `test-*.js`
- Optional `--watch` mode using `fs.watch`
- Per-file fresh require cache (currently via separate processes;
  harness preserves this option)
- Zero npm deps

Retrofit the 6 existing test files to the new harness — drops ~30 LOC
of boilerplate per file.

**Touches:** new `tests/runner.js`, new `tests/run.js`, all 6
`test-*.js` files.

---

## Tracked but not refactor work

These came up during the review but belong to feature work or
documentation, not refactoring:

- **PLUGINS.md update** — once Plugin API facade (B) ships, document
  the surface. Belongs to that PR, not a separate item.
- **Hub second consumer (stats panel)** — already in FUTURE.md.
- **Syntax highlighting plugin** — already in FUTURE.md (Medium
  Priority section, added 2026-05-01).
