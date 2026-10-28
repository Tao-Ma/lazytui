# Overlay compositor migration — v0.6.50 → v0.6.52

> **Status**: planned, not started. Written 2026-10-27 after the
> fifth same-day field-caught repaint fix (v0.6.49 shrink class #3).
> User asked for an architectural review; this is the three-release
> plan that resulted.

## Motivation

Between v0.6.33 and v0.6.49 we shipped **six** fixes against variants
of the same bug: overlay cells linger on screen after the overlay's
geometry changes. Each fix added either a one-off `prevXxxSig` tracker
in `js/render/paint.js` or an explicit `force_full_repaint` Cmd in a
reducer arm. The sig-tracker list is at four (`prevMenuItems`,
`prevFabricPickingSig`, `prevReplayView`, `prevPaletteSig`) and
growing. Strike four is a matter of time without a structural fix.

This document plans a three-release migration to a compositor-based
overlay architecture. End state: zero sig trackers, zero per-overlay
paint Cmds, overlays are declarative descriptors.

## Three root causes (independent — fixed across the three releases)

**Class A — overlays bypass the cell-diff baseline.** Main-frame
paint tracks `_frame.prevRows` (markup per row) and emits ANSI only
for changed cells. Overlays write ANSI directly to stdout, bypassing
`newRows` entirely, so `prevRows` has no record that overlay cells
were painted. Next frame, cell-diff sees main-frame === main-frame
and emits nothing → terminal keeps showing stale overlay cells.
`forceFullRepaint` (invalidate `prevRows`) is the universal
workaround.

Symptoms: v0.6.33 fabric-field residue, v0.6.38 popover shrink,
v0.6.49 Brief 1 palette filter.

**Class B — each shape-changing overlay needs a bespoke sig
tracker.** paint.js hand-writes one tracker per shape-changing
overlay. Discoverable only by reading paint.js. Silent failure mode:
new overlay works in tests, ghosts in the field.

Symptoms: strikes 1/2/3 of the overlay-shrink class.

**Class C — `setImmediate`-dispatched `applyMsg` has no trailing
paint.** The input pump owns the trailing render for pump-dispatched
Msgs. Three effect sites use `setImmediate` + eventually call
`applyMsg`: `do_run`, `run_action`, `unrouted_preempt_and_run`.
Reducer arms reachable through those paths need explicit paint Cmds,
or the model updates and nothing paints.

Symptoms: v0.6.48 invisible modal.

## Why not just more sig trackers?

Terminals are dumb cell grids but we have our own compositor buffer
(`newRows`) sitting right there. We just route around it. Mature TUI
frameworks (Lipgloss/Bubble Tea layering, Textual's Compositor class)
composite overlays into their main frame buffer. We took a shortcut
to avoid composition complexity; the bill comes due in sig trackers.
The fix is literally "do what a GUI compositor does."

## End state (after v0.6.52)

```
                          BEFORE (now)                       AFTER (v0.6.52)
paint.js overlay dispatch 15 if-statements                   compositor.paintActive(model, newRows)
Overlay write target      stdout (side-channel)              newRows buffer (same as main frame)
Sig trackers              prevMenuItems, prevFabricPicking,  deleted
                           prevReplayView, prevPaletteSig
Reducer paint Cmds        v0.6.48 explicit emit              deleted (applyMsg always schedules)
Flat-modal invariant      per-arm isChainActive checks        enforced by compositor
                           (honor system)
```

Future overlay author: register descriptor + write pure render fn.
No paint.js edits, no sig trackers, no explicit paint Cmds. Flat-modal
+ z-order enforced structurally.

---

## Release 1 — v0.6.50 — schedule render after every applyMsg

**Target**: close Class C globally.

**Scope** (small, mostly `js/dispatch/runtime/loop.js`):

1. Modify `applyMsg` to call `require('../../leaves/infra/render-queue').scheduleRender()` when `_dispatchDepth === 0` after the reducer step and effect run. Not inside the pump, which already has a trailing render — the schedule's `_renderPending` guard coalesces.
2. Delete the explicit `force_full_repaint` + `render` Cmds from `fabric_form_enter` and `fabric_field_enter` arms (v0.6.48 — now redundant).
3. Delete the "setImmediate hazard" comment reasoning from the two reducer files; add a one-line pointer to the plan.
4. Add a `loop.js` test: `applyMsg` schedules exactly one render per top-level dispatch; nested dispatches do NOT re-schedule.
5. Measure: run `js/test/bench-startup.js` before/after; sample paint count on a representative key burst (10 arrow keys down, measure paint count).

**Exit criteria:**
- Full suite (`run-tests.js` + `run-smoke.js`) green.
- `bench-startup.js` delta ≤ 20ms on both `--help` and `--list` baselines.
- Burst-sample paint count unchanged (debounce coalesces).
- Manual verification of the v0.6.48 regression scenario: empty-resubmit → modal still visible.

**Risk:** low. The debounce + coalesce guard protects against paint storms. One subtle hazard: a cross-layer dispatch chain (A applyMsg → effect → B applyMsg → effect → C applyMsg) at outer depth 0 schedules once; at inner depths does nothing. Covered by the depth gate.

**Estimated**: 1 session, ~5 commits + 1 release commit.

---

## Release 2 — v0.6.51 — overlays composite into `newRows` (Option 1 plumbing)

**Target**: close Classes A + B. Delete all four sig trackers.

**Scope**: `js/leaves/render/draw.js` + each file in `js/overlay/*.js` (15 overlays).

### Mechanism

Augment `renderOverlay()` to accept an optional `targetRows` buffer:

```js
renderOverlay({ lines, title, count, maxWidth, anchor,
                scrollOffset,
                targetRows,     // ← NEW: Array<string> | undefined
                targetCols      // ← NEW: int | undefined (newRows width)
             }) {
  const { offX, offY, menuW, menuH } = overlayBox({...});
  const content = renderPanel({width: menuW, height: menuH, lines, …});
  if (targetRows) {
    // Composite each row of `content` into targetRows[offY..offY+menuH)
    // at columns [offX..offX+menuW), splicing over the existing row.
    _compositeIntoRows(targetRows, targetCols, content, offX, offY, menuW);
    return;
  }
  // Fallback — direct-to-stdout, preserved during migration. Delete at end.
  const out = content.split('\n');
  …
}
```

`_compositeIntoRows` is a new pure helper in `js/leaves/render/row-compositor.js`: `(rows, cols, overlayText, x, y, w) → mutates rows[]`. Splices overlay cells into the existing main-frame row, preserving cells outside the overlay's rect.

paint.js passes `newRows` + `COLS` to each overlay call site.

### Migration order (10 commits for the simple group, then 5 for complex)

**Phase 2.a — simple overlays** (text + title + help line, no sub-overlays): confirm, copy, diag-log, jobs, pane-menu, panel-list, register-popup, which-key. One commit each. (`help` was listed in the original plan but it's a VIEWER-TAB CONTENT PRODUCER, not an overlay — `showHelp()` calls `setViewerContent(helpLines().join('\n'), …)` and the text paints through the normal viewer pane's `composeRects`→`newRows` path, no `renderOverlay` involved. Dropped from the Phase 2.a list; the leader-chord popup `which-key` is the actual help-flavored overlay here.) Pattern:

```
refactor(overlay/confirm): composite into newRows
- renderConfirmOverlay accepts newRows + cols
- No stdout write when newRows provided
- Added test: assert no FULL_CLEAR fires on confirm_enter (cell-diff
  handles the overlay rect naturally)
```

**Phase 2.b — medium overlays** (variable height / shape): action-palette, menu, cmdline. Each gets the base migration + a dedicated test that proves shrink works without sig tracker. Delete the matching sig tracker in the SAME commit:
- `action-palette` + delete `prevPaletteSig`
- `menu` + delete `prevMenuItems`

**Phase 2.c — complex overlays**: `fabric-form` (base), `fabric-form` choices popover sub-layer, `fabric-field`. The picker-within-form needs its own rect protocol — the popover composites into a sub-region of the form overlay's rect, with its own prev-rect tracking inside the compositor's model (not in paint.js). Expect 3–5 commits for this group.
- `fabric-form` + delete `prevFabricPickingSig`

**Phase 2.d — specialized**: `replay-scrubber`. Has highlight tint overlay + custom position. One commit + delete `prevReplayView`.

### Per-overlay commit shape

```
refactor(overlay/<name>): composite into newRows

- renderXxxOverlay accepts newRows + cols; writes composited rows
  into them instead of stdout.
- paint.js call site updated to thread newRows + COLS.
- No stdout write when newRows is provided; stdout path preserved
  for migration-period callers (deleted at end of Release 2).
- Deleted paint.js prevXxxSig tracker (if any) — cell-diff now
  catches the overlay's transitions naturally.
- Added paint-level test: large overlay → re-paint with small
  overlay → vacated cells cleared without FULL_CLEAR.
```

### Test strategy

Invert `test-fabric-form-popover-repaint.js`'s `assertOverlayShrinkForcesRepaint`. Pre-migration: asserts `FULL_CLEAR` fires on shrink. Post-migration: asserts cells are naturally cleared without `FULL_CLEAR` — the cell-diff emits per-cell writes from the row deltas.

Each migrated overlay gets:
1. A unit test that the overlay fn writes nothing to stdout when `targetRows` is provided (identity preservation of newRows outside the overlay rect; mutation inside).
2. A smoke-level paint test that drives a shrink (filter narrow / popover close / selection move past window) and asserts the vacated cells are blank in the next captured frame.

### Delete the stdout fallback

End of Release 2: after all 15 overlays migrated, delete the `if (targetRows) {...} else {...}` branch and the stdout `_writer` call path. `renderOverlay` becomes buffer-only.

### Exit criteria

- All four sig trackers deleted from paint.js.
- No overlay writes to stdout (grep sanity check).
- Full suite + smoke green.
- `test-fabric-form-popover-repaint.js` harness inverted and all current cases pass without `FULL_CLEAR`.
- Manual: open each overlay, resize terminal, open/close/filter — zero visible residue.

**Risk**: medium. Each overlay migration is independently revertable (per-commit); if one surface regresses we revert that commit and investigate without blocking the rest.

**Estimated**: 3–5 sessions, ~20 commits. The complex overlays (fabric-form + fabric-field) are the pacing item — the picker-within-form sub-rect protocol is where the architecture decision gets tested. Prototype the simple overlays first (prove the pattern), then tackle the complex ones.

---

## Release 3 — v0.6.52 — compositor registry (Option 4)

**Target**: close the pattern-level loop. paint.js's imperative if-chain goes away. Overlays become declarative.

**Scope**: new `js/render/overlay-compositor.js` + each overlay's `registerSelf` export + paint.js if-chain replacement.

### Compositor API

```js
// js/render/overlay-compositor.js
module.exports = {
  register: (descriptor) => { … },      // called once per overlay at boot
  paintActive: (model, newRows, cols) => { … },  // called from paint.js
  activeOverlayIds: (model) => [...],   // pure fn for tests
};

// Descriptor shape
{
  id:       'palette',
  isActive: (m) => m.modes.paletteMode,
  render:   (m, rect, newRows) => renderPaletteBody(m, rect, newRows),
  anchor:   'center' | 'cursor' | {x, y},
  modal:    true,          // enforces flat-modal invariant
  zIndex:   10,            // paint order (higher = on top)
  maxWidth: 72,
}
```

### `paintActive` behavior

1. Walk the registered descriptors.
2. Filter to those where `isActive(model)` returns true.
3. Enforce flat-modal invariant: at most ONE descriptor with `modal: true` active per frame. If two → paint the higher `zIndex`, drop the other, log a dev-warn (`console.warn('two modal overlays active — this is a bug', {ids})`).
4. Sort active descriptors by `zIndex`.
5. For each: compute rect from anchor + size, call `render(model, rect, newRows)`.

### paint.js change

Before:
```js
if (md.fabricFormMode) require('../overlay/fabric-form').renderFabricFormOverlay();
if (md.paletteMode) require('../overlay/action-palette').renderActionPalette();
if (md.confirmMode) require('../overlay/confirm').renderConfirmOverlay();
// ... 12 more
```

After:
```js
require('./overlay-compositor').paintActive(model, newRows, COLS);
```

### Boot wiring

`app/tui.js` imports each overlay module and calls `module.registerSelf(compositor)` once at boot, before first paint. Mirrors the `setFeatureHost` / `setConfigAccessors` pattern.

### Flat-modal invariant migration

Reducer arms currently enforce "don't open over a live modal" via `isChainActive(model.modes)`. The compositor's modal gate makes those checks redundant.

Decision point: delete the per-arm checks (compositor is single source of truth) or keep as defense-in-depth? **Recommendation**: keep as defense-in-depth with a `/* belt-and-suspenders */` comment. Reducer-level validation prevents a broken Msg from flipping two modal flags; compositor-level handles live paint. Both cheap.

### Test strategy

- Pure test: `compositor.activeOverlayIds(model)` returns expected set per mode. Table-driven across every combination of mode flags.
- Flat-modal invariant: model with two modal flags set → compositor paints only the higher zIndex, dropped one logs warn.
- Z-order: synthesize a model with palette + help open → help paints over palette.
- Painted-overlay harness: all existing overlay tests pass through the compositor path (migration is behavior-preserving).

### Exit criteria

- paint.js's 15 imperative if-statements for overlays replaced with one `compositor.paintActive()` call.
- Each overlay module exports `registerSelf(compositor)`.
- No overlay-mode `if` statement remains in paint.js.
- All existing tests pass.
- New compositor tests pass (active-set + flat-modal + z-order).

**Risk**:
- Boot order sensitivity. If paint fires before registration completes, overlays never paint. Mitigation: compositor's `paintActive` warns on empty registry (should never be empty at paint time), and app/tui.js's boot has an explicit "overlays registered" assertion before first paint.
- Replay fidelity. Compositor registration happens at boot (same across releases); replay fold reproduces identically. No WAL concern.

**Estimated**: 2–3 sessions, ~15 commits.

---

## Open questions / known uncertainties

1. **Fabric-form choices popover sub-rect protocol.** The picker-within-form composites into a sub-region of the form overlay. In Release 2 this becomes "the form overlay's `render` composites itself into newRows, then internally composites the picker into a child rect inside its own output." Does this stay inside the form overlay's render fn (self-contained), or does the picker register as its own overlay with the compositor and the compositor enforces z-order? **Prefer the former** (self-contained) because the picker is semantically PART of the form, not a sibling overlay. Decide during Release 2.c.

2. **Terminal pane overlay.** The embedded PTY pane's cells are updated out-of-band by the PTY data stream, bypassing `newRows` entirely. The compositor model assumes all overlays composite into `newRows`. Terminal panes are not quite overlays today — they live as pane kinds. Confirm this during Release 3 planning; they probably stay out of the compositor and keep their session.prevFrame caching.

3. **Toast / ephemeral overlays.** Compositor pattern makes toasts (notifications that fade) possible. Not planned for this migration; mentioned so a future "add toasts" task has a known home.

## Rollback plan

- **Release 1**: trivial. One commit reverts `applyMsg` schedule change. v0.6.48 explicit Cmds come back.
- **Release 2**: per-overlay commits are independently revertable. If an overlay regresses, revert its commit and leave the others shipped. The stdout fallback stays alive until the final cleanup commit.
- **Release 3**: compositor is a new file; if we need to abort, delete `paintActive` call from paint.js and restore the if-chain. Overlays' `registerSelf` exports become dead code (harmless).

## Non-goals

- No new overlay features. This is pure infrastructure.
- No changes to overlay content, keybindings, or UX.
- No performance optimization beyond measurement. If measurement shows regression, we investigate; otherwise ship as-is.

## Timeline estimate

Rough: 1–2 weeks of focused work total, across 6–11 sessions. Not time-bound — each release ships when it's green.

---

## Session kickstart

Next session (fresh, zero context) should start with Release 1. Reference docs: this file, plus the five topic files from the 2026-10-27 fix run (project_v0645…v0649) that motivated the plan.
