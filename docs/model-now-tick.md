# `model.now` / tick arc — eliminating the render-side wall-clock read

**Status:** ☑ SHIPPED 2026-06-16. Removed blessed-exception **D**
(`docs/v0.6.5-tea-reaudit.md`): the `Date.now()` default in `render()`. This
doc is now the as-built record (spec + what landed). Chose the **gated tick**
(option b). Pinned by `test-overlay-clock.js` + the `clock_tick` reducer tests
(test-jobs.js / test-diag-log.js). The remaining half of an end-to-end replay
feature — persisting/re-feeding the Msg log (§5) — stays a separate future arc.

> **⚠️ Superseded mechanism (v0.6.6 FIX-3 Phase 6).** This arc shipped the
> clock as a self-re-arming `arm_clock` effect gated on a `model.clockArmed`
> latch (the as-built deltas just below). FIX-3 Phase 6 replaced that with the
> model-conditional **`clock` interval Sub** (`app/state.js#_appSubscriptions`,
> declared while `jobsMode || diagLogMode`): the `arm_clock` effect, the
> `clockArmed` latch, and the `clock_tick` re-arm are all RETIRED. The OUTCOME
> is unchanged — `model.now` advances ~1 s while an age overlay is open, idle
> otherwise — only the cadence owner moved (reducer self-re-arm → declared Sub).
> The rest of this doc is kept accurate to the original arc.

As-built deltas from the spec below (original arc; cadence since superseded — see above):
- `model.now` + `model.clockArmed` added in `js/model/store.js init()`.
- Reducer (`js/app/runtime.js`): `_armClock` helper + `CLOCK_MS=1000`;
  `jobs_open`/`diag_log_open` seed `now` from `msg.now` and arm; `clock_tick`
  arm advances `now` and re-arms while an age overlay is open, else lapses.
- Dedicated **`arm_clock`** effect (`js/dispatch/effects.js`) — NOT the generic
  `tick` (which re-dispatches a verbatim Msg and so can't carry a fresh `now`);
  `arm_clock` reads `Date.now()` in the shell and `applyMsg`s `clock_tick`.
- Handlers stamp `now` on open (`js/dispatch/dispatch.js` leader `j`/`e`).
- `render()` → `render(model = getModel())` + `const now = model.now`; both
  overlay render fns dropped their `Date.now()` defaults.

---
*Original spec follows (design as proposed; the deltas above are what shipped).*

## Why this exists (the problem, restated precisely)

`render(model = getModel(), now = Date.now())` reads the wall clock once at the
frame boundary and threads `now` into the age-displaying overlays (jobs, diag).
The containment is good: `now` is read at exactly one point and the overlay
render fns below it (`overlay/jobs.js:renderJobsOverlay`,
`overlay/diag-log.js:renderDiagLog`) are pure of the clock — a test passes a
fixed `now`.

But the read is **independent of the Msg stream**, and that is the real defect:

- Time enters the MODEL only via `msg.now` (e.g. `dispatch.js:482`
  `jobs_activate` carries `now`; jobs/history record `startedAt`/`endedAt` from
  `Date.now()` at event time). So the model is **fully replayable** from the
  recorded Msg log.
- But `render()` reads `Date.now()` itself, so the **frame** is a pure function
  of `(model, ambient-wall-clock-at-paint)`, NOT of recorded history. Replaying
  the same Msg log at a different wall-clock reproduces bit-identical model
  states with **different frames** (the age overlays show different elapsed
  values).

**Consequence:** this single read is the specific blocker for a render-level
**replay / snapshot-the-pixels** feature — reproduce the exact frames from the
recorded history. It is NOT a correctness bug today; it is the prerequisite for
that feature.

## Target invariant (this arc: the wall-clock half)

> The rendered frame is pure of the WALL CLOCK: the model is a pure function of
> the Msg log, and `render` reads `model.now` (not `Date.now()`), so two replays
> of the same log at different real times paint the same age values.

To get there, wall-clock time must enter the model as data (a Msg), and
`render()` must read `model.now`, never `Date.now()`.

> ⚠️ This arc closes the wall-clock read ONLY. It does NOT make the frame a pure
> function of the *model* — the render path still reads several named off-model
> live stores (jobs / diag-log / history / PTY sessions / theme palette cache)
> that replay does not reproduce. That broader gap is the #D5 *replayability
> boundary*, documented at `model/store.js` (§Replayability boundary) and in §5
> below; "replay reproduces pixels exactly" needs it closed too, not just `now`.

## Design

### 1. `model.now` (root model field)
Add `now` to the root model (`app/runtime.js` initial state). It holds the
last-ticked wall-clock ms. Written by exactly one reducer arm (`tick` Msg) →
single-writer holds.

### 2. `tick` Msg + the existing self-re-arming Cmd
The recurring-timer primitive already exists: the `tick` **effect**
(`effects.js:165`) waits `ms` then re-dispatches a Msg, `unref`'d so it never
keeps the process alive (clean teardown — important for tests and quit). The
self-re-arming pattern is already used by docker/files/config-status polling
loops (`tui.js:284-287`).

Add a root-level clock loop on the same primitive:
- A `clock_tick` Msg whose reducer arm sets `model.now = msg.now` and re-emits
  the `tick` Cmd `{ ms, msg: { type: 'clock_tick' } }`.
- The injected `msg.now` is read by the impure dispatch shell (where `Date.now()`
  already lives for `jobs_activate` et al. — blessed exception **C**, the shell
  is the sanctioned place for the wall-clock read), NOT by the reducer.

### 3. `render()` reads `model.now`
- `paint.js:655` → `function render(model = getModel())`, then
  `const now = model.now;` (drop the `Date.now()` default arg).
- `renderJobsOverlay(now)` / `renderDiagLog(now)` already take `now` as a param —
  pass `model.now`. Drop their `= Date.now()` defaults (`jobs.js:106`,
  `diag-log.js:65`) so a missing `now` fails loudly instead of silently reading
  the clock.

### 4. Gate the tick (don't churn the model when idle) — DESIGN DECISION
A naive always-on 1 s tick means a model mutation + reconcile + frame every
second forever, and a tick entry every second in the replay log. The current
argless `Date.now()` advances age "for free" on natural repaints with zero
Msgs. Two options — **pick during the arc, not now:**

- **(a) Always-on tick** (e.g. 1 s). Simplest; `model.now` is always fresh.
  Cost: steady Msg/reconcile churn + a tick every second in the replay log.
- **(b) Gated tick** (RECOMMENDED). Arm the clock loop ONLY while an age-display
  overlay is open (`md.jobsMode || md.diagLogMode`); stop re-arming when both
  close. The reducer arms on overlay-open, lets the loop lapse on overlay-close.
  Matches the "cadence owned by the model" principle and keeps the idle log
  quiet. Cost: the open/close arming logic; a frame painted between ticks shows
  age as of the last tick (≤ cadence stale — fine for second-resolution age).

Cadence: 1 s matches the current human-visible age resolution (`_fmtAge`).

### 5. Replay completeness (separate, larger prerequisite)
This arc makes the frame pure of the WALL CLOCK — NOT a pure function of the
model. A full pixel-replay feature ALSO needs, beyond `model.now`:
  (a) the Msg log itself persisted and re-feedable end-to-end (record every
      `applyMsg`, including the injected `now`); and
  (b) the off-model live stores the frame reads — `feature/jobs`,
      `io/diag-log`, `feature/history`, `io/terminal.getSession()`,
      the `leaves/themes` palette cache — brought under TEA (a `Sub` feeding
      samples into the model via Msgs) OR explicitly excluded from replay.

> **Update (v0.6.6 FIX-1 + #D8).** The (b) gap is now largely closed: the
> `leaves/themes` palette cache is projected from `model.theme` at the render
> entry (#D8), and `feature/jobs` / `io/diag-log` / `feature/history` are
> mirrored into `model.{jobs,diagLog,history}` by the `store-mirror` Sub exactly
> as (b) anticipated. The only off-model read the frame still makes is the
> terminal island (`io/terminal.getSession()` + `io/term` dims, #D14). So
> `frame = f(model)` holds except that island; (a) — persisting + re-feeding the
> Msg log — remains the open prerequisite for full pixel-replay.

`model.now`/tick is necessary-but-not-sufficient. The (b) gap is the #D5
replayability boundary (see `model/store.js` §Replayability boundary). Scope
THIS arc to the wall-clock half; (a) and (b) are follow-on arcs.

## What stays out of scope
- Persisting/replaying the Msg log (item 5) — separate arc.
- `Date.now()` in event recording (`jobs.js:41,77`, `history.js:60,102`,
  `open-docker.js`): those run in the impure shell / effect handlers at event
  time, are captured INTO the model as data, and are already replay-safe via
  `msg.now`. They are NOT the render leak and need no change.

## Acceptance
- `grep -n "Date.now" js/render js/overlay` returns nothing (the render path is
  clock-free).
- `render()` and both age overlays take/read `now` only from `model.now`.
- A snapshot test: feed a fixed Msg log (with fixed `msg.now` values) → assert
  byte-identical overlay frames across two runs at different real wall-clocks.
- Suite + smoke green; no idle-frame regression when no age overlay is open
  (verifies the gate, option b).

## Pointers
- Blessed exception D: `docs/v0.6.5-tea-reaudit.md` (ledger row D).
- `tick` Cmd primitive: `js/dispatch/effects.js:165`.
- Render boundary read: `js/render/paint.js:655`; consumers `:731-732`.
- Age overlays: `js/overlay/jobs.js:106`, `js/overlay/diag-log.js:65`.
- Existing `msg.now` injection precedent: `js/dispatch/dispatch.js:482`.
