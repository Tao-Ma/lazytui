# Reducer / cleanup relocation arc — extracting `app` from the layer SCC (F3)

**Status:** ☑ SHIPPED 2026-06-17 (option (a) — shim kept). `app` is now OUT of
the layer SCC: `dep-walker.js` reports `[feature,overlay,render,panel,dispatch]`
(5, down from 6) for BOTH top-level and all-edges analyses. The reducer + cleanup
moved out of `app/`; this doc is now the as-built record.

As-built deltas from the spec below:
- Reducer `update` + helpers → `js/dispatch/reducer.js` (`git mv` from
  `app/runtime.js`; only `../dispatch/keybindings` → `./keybindings` changed —
  every other `../` path resolves the same from `dispatch/` as from `app/`).
- Cleanup → `js/dispatch/cleanup.js` (`git mv`; `../dispatch/action-runner` →
  `./action-runner`). `app/cleanup.js` deleted (no test imported it).
- `_ghostSuffix` → `js/leaves/ghost.js` as `ghostSuffix` (used by the reducer
  AND `overlay/prompt.js` — a leaf is the shared home; a shim re-export
  wouldn't fix the `overlay→app` edge since that's upward).
- File disposition: **option (a)** — `app/runtime.js` is now a 1-line shim
  (`module.exports = require('../dispatch/reducer')`) so the ~15 tests that
  `require('app/runtime')` are untouched. dep-walker skips `test/`, so the shim
  (imported only by tests) doesn't keep `app` in the SCC.
- Repointed production importers: `dispatch/dispatch.js` (reducer + `q` cleanup),
  `dispatch/actions.js` + `dispatch/input.js` (cleanup), `panel/commands.js`
  (lazy → `../dispatch/cleanup`, now a deferred panel→dispatch edge, was
  panel→app), `overlay/prompt.js` (→ `leaves/ghost`).
- `test-msg-routing.js` now scans `dispatch/reducer.js` (was `app/runtime.js`).
- Stale "reducer lives in app/runtime" comments fixed (`model/store.js`,
  `leaves/pane-tabs.js`, `leaves/cmdline-split.js`, `render/paint.js`).
- **Verified:** suite 1/95 (xz only), smoke 9/9, bench parity (the move is
  logic-free; require-path change is load-time only). No `require('app/runtime')`
  or `require('app/cleanup')` in production (only the shim + comments remain).

Residual 5-cycle `{dispatch,panel,render,overlay,feature}` is UNCHANGED and
out-of-scope, exactly as the spec said (see "Out of scope" below).

---
*Original spec follows (design as proposed; the deltas above are what shipped).*

## Honest scope (read this first)

This arc **extracts `app` from the SCC** — it does NOT dissolve the SCC. After
it, `app/` is a clean top layer (only downward edges) and the cycle shrinks
**6 → 5**. The residual `{dispatch, panel, render, overlay, feature}` 5-cycle
remains and needs a much deeper inversion (see "Out of scope" below). The
re-audit's F3 verdict stands: there is no *cheap* win; this is the *real* one,
and it's partial. Doing it is worth it for the most-depended-on layer (`app`)
becoming a true top, the 1038-line reducer co-locating with its dispatcher, and
the cycle getting smaller — not because it makes the graph a DAG.

## Current state (dep-walker, the acceptance oracle)

`node js/scripts/dep-walker.js`:

```
LAYER SCCs (top-level edges only):
  [["feature","overlay","render","panel","dispatch","app"]]
```

Target layer order (bottom→top): `leaves/model → io → panel → dispatch →
render/overlay/feature → app`. Against that order, **`app` has exactly three
upward edges into it** — the cut targets:

1. `dispatch/dispatch.js:39 → app/runtime` — the reducer (`update`). The big one.
2. `dispatch/input.js:51 → app/cleanup` (also `dispatch.js:554`,
   `actions.js:408`) — teardown.
3. `overlay/prompt.js:14 → app/runtime._ghostSuffix` — a pure 3-line helper.

Those are the ONLY production importers of `app/runtime` + `app/cleanup` from
below (verified: `grep` for non-test requires returns exactly these). Cut all
three and nothing below `app` reaches up into it.

## Phase 1 — the three cuts (the deliverable)

### Cut 1: reducer → `dispatch/reducer.js`
Move `update()` + its pure helpers (`_withModes`, `_withModal`, `_navRoute`,
`_cycleViewerTab`, `_armClock`, `_clampRegisterPopup`, `_parsePtyIdGroup`,
`CLOCK_MS`, …) from `app/runtime.js` into a new `dispatch/reducer.js`. Verified
the reducer's deps all sit at or below `dispatch`, so they become intra-layer or
downward — no new upward edge:
- `dispatch/keybindings` (`kb`) — intra-dispatch ✓ (was app→dispatch, now gone)
- `panel/route`, `panel/navigator/groups` — downward ✓
- `model/store`, `leaves/*`, `io/ansi` — downward ✓

`dispatch/dispatch.js:39` then `require('./reducer')` — intra-layer. The
`dispatch→app` reducer edge disappears.

### Cut 2: cleanup → `dispatch/cleanup.js`
Move the 36-line `app/cleanup.js` to `dispatch/cleanup.js`. Its one
intra-SCC dep, `app/cleanup:17 → dispatch/action-runner` (`killAll`), becomes
**intra-dispatch**. Its other deps (`io/ansi`, `io/term`, `io/terminal`
downward; `panel/api` lazy/downward) are fine. The three importers
(`input.js:51`, `dispatch.js:554`, `actions.js:408`) become `require('./cleanup')`
— intra-layer. The `dispatch→app` teardown edge disappears.

### Cut 3: `_ghostSuffix` → a leaf
It's pure (`(text, ghost) → string`, no deps). Move to `leaves/cmdline-split.js`
(already the home for the cmdline string helpers the reducer uses) or a tiny new
leaf. Both the reducer (now in `dispatch/`) and `overlay/prompt.js:14` import it
from the leaf — downward for both. The `overlay→app` edge disappears.

### File disposition — pick one (DESIGN DECISION)
- **(a) Minimal / RECOMMENDED.** After Cuts 1–3, `app/runtime.js` has no
  production importers from below; what remains is its re-export of
  `init/getModel/setModel` (already just a pass-through of `model/store` since
  the v0.6.5 §1 store extraction). Keep `app/runtime.js` as a thin re-export
  shim (re-export `update` from `dispatch/reducer`, accessors from
  `model/store`) so the ~15 tests that `require('../app/runtime')` keep working
  untouched. Lowest risk; the shim sits in `app/` and points only down, so it's
  out of the SCC.
- **(b) Clean.** Delete `app/runtime.js`; repoint every importer (production:
  `dispatch/dispatch.js`, `overlay/prompt.js`; ~15 test files) to
  `dispatch/reducer` (for `update`) and `model/store` (for accessors). No shim,
  but ~17 require-site edits + test churn.

Recommend (a) for the arc itself (smallest diff that achieves the SCC goal),
with (b) available as an optional follow-up tidy.

## What Phase 1 achieves — verify with the oracle
After the cuts, `dep-walker.js` should report `app` OUTSIDE the SCC:
```
LAYER SCCs: [["feature","overlay","render","panel","dispatch"]]   # 5, not 6
```
and the "edges WITHIN {app,dispatch,panel}" section should show **no
`dispatch→app` and no `overlay→app`** rows. That diff IS the deliverable.

## Out of scope — the residual 5-cycle (`{dispatch,panel,render,overlay,feature}`)

Phase 1 does not touch these; dissolving them is a separate, larger effort.
Enumerated honestly so the arc doesn't over-promise:

- **`panel/api.js:64 → dispatch/stream` (streamCommand re-export).** Upward
  (panel below dispatch). Sole consumer is `docker.js`. Per the F3
  re-verification, dropping the re-export just relocates the edge to
  `docker → dispatch/stream` — same edge, no SCC change. Truly removing it needs
  `stream.js` to leave `dispatch/`, but `stream.js` itself reaches
  `feature/history`, `feature/jobs`, `render/render-queue`, `panel/route`,
  `panel/api` — it's deeply entangled, not a clean lift.
- **`dispatch → feature`** (`dispatch.js:463/481` jobs.list; `stream.js:45-46`
  + `action-runner.js:17-18` history/jobs) **plus `feature → render`**
  (`jobs.js:22 → render-queue`) **and `feature → panel`** (`open-docker.js:36 →
  viewer/tabs`). dispatch reaches up into feature; feature reaches up into
  render/panel — a mutual tangle.
- **`dispatch → render` / `dispatch → overlay`**, and `render ↔ panel`,
  `render ↔ overlay`.

Dissolving these would need a real inversion: dispatch stops reaching up into
feature/render by going through Cmd descriptors + a registry the *top* wires up
(extending what `effects.js` already does), and `stream.js` gets re-homed. That
is its own arch arc — bigger than this one, and NOT justified by F3's findings
today (these are blessed, accepted, documented control-flow edges).

## Risks
- **Hot path.** The reducer is on every Msg dispatch; the move is a file
  relocation, not a logic change — keep the diff to `require` paths + the export
  surface. Re-run the bench (`js/test/bench-*`) to confirm no regression from a
  changed require graph (require resolution cost differs by path depth — the
  v0.6.4 work showed exchange-mount require stats are ~35μs each).
- **Require cycles.** `dispatch/reducer` ↔ `dispatch/dispatch` will be
  intra-layer; confirm no eager-require TDZ (the reducer is required at
  `dispatch.js` module load — keep `dispatch/reducer`'s own requires lazy where
  they already are, e.g. the `groups` require at the cascade site).
- **Test churn.** Option (a) avoids it via the shim; option (b) touches ~15
  test files. Either way, `test-runtime.js` / `test-immutable-runtime.js` import
  `update` — point them at the chosen home.

## Acceptance
- `dep-walker.js` shows `app` OUT of the SCC (cycle 6→5); no `dispatch→app` /
  `overlay→app` rows in the cut-target section.
- Suite + smoke green; bench parity (reducer is hot).
- The F3 ledger row in `docs/v0.6.5-tea-reaudit.md` + the blessed-exceptions
  entry updated: `app` extraction DONE; residual 5-cycle documented as the
  remaining (out-of-scope) blessed layering deviation.

## Pointers
- F3 analysis + verdict: `docs/v0.6.5-tea-reaudit.md` (F3 section + F3 LAYERING
  ledger row).
- The oracle: `js/scripts/dep-walker.js` (its "edges WITHIN {app,dispatch,panel}"
  section is purpose-built for this cut).
- Cut targets: `dispatch/dispatch.js:39`, `dispatch/input.js:51`
  (+`dispatch.js:554`, `actions.js:408`), `overlay/prompt.js:14`.
- Reducer today: `app/runtime.js` (1069 lines); store accessors already live in
  `model/store.js` (v0.6.5 §1).
- `_ghostSuffix`: `app/runtime.js` (pure helper); leaf home candidate
  `leaves/cmdline-split.js`.
