# Reducer route-topology purity arc — eliminating blessed-exception A

**Status:** ☑ SHIPPED 2026-06-16 (option (a) — Flavor 1 threaded; the two
constant-id Flavor-2 lookups deliberately kept). Removed the focus-routing half
of blessed-exception **A** (`docs/v0.6.5-tea-reaudit.md`, ledger row A): the
root reducer no longer reads `getFocus`/`resolveTarget`/`paneTypeOf`/`hasInstance`.
This doc is now the as-built record (spec + what landed).

As-built deltas from the spec below:
- Added `route.bundle(id) → {compName, panelType, target}` (`panel/route.js`),
  replacing the in-reducer `_navRoute` helper (deleted from `app/runtime.js`).
- Handlers stamp the bundle: `escape`/`list_select` (`dispatch.js`),
  `navSelect` (`dispatch.js`), `_enterFilterMode` (`dispatch.js`); the viewer-tab
  arms get `target` from `_viewerTabBundle` (`actions.js`).
- Arms read `msg.route` (escape/list_select/nav_select) or `msg.target`
  (next_tab/prev_tab). The filter session caches the bundle on
  `modal.filter.route` (added to `model/store.js init`), stamped once at
  `filter_enter` and reused by `filter_key`/`filter_exit` (the filtered pane is
  fixed for the session).
- **Verified:** the only `route.*` topology reads left in `runtime.js` are the
  two Flavor-2 `componentForPanel(<constant>)` lookups (`set_config`,
  `reset_group_context`); a live probe confirmed **0** `getFocus` calls during
  the escape/nav_select/next_tab arms. Contract bullet (`runtime.js`) updated.
- Tests threading bare Msgs now thread the bundle (test-runtime,
  test-immutable-runtime, test-multiselect, test-instance-registry). Suite 1/95
  (xz only), smoke 9/9.

---
*Original spec follows (design as proposed; the deltas above are what shipped).*

## Why this exists (and why it's lower-priority than D)

The reducer is documented as `(model, msg) → [model, cmds]` but a few arms read
the route registry, so its true signature is `(model, msg, routeState)`. F2
already added an honest Contract bullet saying so (`runtime.js:20-28`).

**Crucial framing — A is NOT a replay/correctness hazard (unlike D).** The state
A reads (the layout service slice's `focus`/`arrange`/`lastViewerTab` +
`_instances`/`_panelOwner`) is mutated ONLY through Msg dispatch (Component
`update`s write their slice back via `dispatch/fanout` `_runInstance → setInstanceSlice`;
the lone non-update writer is the `innerH` finalizer — blessed exception B,
which doesn't touch focus/arrange). So route topology is itself a deterministic
function of the Msg log. Replaying the log reconstructs it identically; the
reducer reading it stays deterministic. Therefore:

- D was worth shipping: `Date.now()` was ambient → it broke deterministic frame
  replay. Eliminating it removed the wall-clock blocker — ONE prerequisite for
  pixel-replay (the #D5 off-model live stores the frame reads remain; see
  `model/store.js` §Replayability boundary), not the whole feature.
- A is **signature honesty + locality only**: the reducer depends on more than
  its two declared args, but the dependency is deterministic and replay-safe.
  Eliminating it is architectural tidiness, not a feature unblock.

This arc is therefore OPTIONAL — do it only as a deliberate "push the blessed
set toward empty" pass. It is self-contained and low-risk, but buys less than D.

## Target invariant

> `update(model, msg)` calls nothing from `panel/route`. Every routing fact a
> reducer arm needs (the resolved Cmd target, the focused Component name, the
> panel-type key, whether focus is a live instance) arrives ON the Msg,
> stamped by the impure handler that built it.

The proven mechanism already lives in the codebase: `_viewerTabBundle()`
(`actions.js:42-50`) computes the viewer's tab facts handler-side and threads
them so the `next_tab`/`prev_tab` arms stay (almost) pure. This arc generalizes
that pattern to the focus-routing reads.

## The two flavors of route read in A (they get different treatment)

**Flavor 1 — focus-dependent resolution.** The arm needs "the focused pane and
how to route to it." Sites: `escape`, `list_select`, `nav_select` (when
`panelType` is a paneId), `_navRoute` (filter arms). These read `getFocus()` +
resolve it.

**Flavor 2 — ownership lookup on an id the arm already holds.** The arm has a
fixed id (often a literal constant) and only needs panel-type → Component-name.
Sites: `set_config` (`componentForPanel('config-status')`),
`reset_group_context` (`componentForPanel('actions'|'containers')`). The input
is static; the read is a pure registry lookup, not focus-dependent.

## Design — the route bundle

A single handler-side helper, mirroring `_viewerTabBundle`:

```js
// dispatch/actions.js (or dispatch.js) — impure shell.
// Resolve the full routing bundle for a focused/known pane id, so the
// reducer arm reads msg.route.* and calls nothing from panel/route.
function routeBundle(id) {                 // id = getFocus() or a known pane id
  const compName  = route.componentForPanel(id);
  const panelType = route.paneTypeOf(id) || id;
  const target    = route.hasInstance(id) ? id : compName;
  return { id, compName, panelType, target };
}
```

The handler stamps `msg.route = routeBundle(getFocus())` (Flavor 1) or
`routeBundle('config-status')` (Flavor 2); each arm reads `msg.route.{target,
compName, panelType}` instead of calling route.

### No staleness window
The handler reads route state, builds the Msg, then `applyMsg` runs the reducer
**synchronously** — no other Msg dispatches in between. So the bundle the arm
reads is consistent with the state the arm would have read itself. (Cascades
that re-enter `applyMsg` from `runEffects` build their own Msg with their own
bundle, so they're covered too — see "Cascade entry points" below.)

## Arm-by-arm plan

| Arm | Current route reads | After |
|-----|--------------------|-------|
| `escape` (`:204`) | `getFocus`+`componentForPanel`+`paneTypeOf`+`hasInstance` | handler stamps `msg.route` (the handler at `dispatch.js:558` already reads `getFocus()`/`multiSelCount`); arm reads `msg.route.{target,compName,panelType}` |
| `list_select` (`:235`) | same | toggle/off is dispatched from `dispatch.js:570`; stamp `msg.route` there |
| `nav_select` (`:287`) | `componentForPanel(panelType)`+`paneTypeOf`+`hasInstance` | `navSelect(panelType,index)` handler (`dispatch.js:109`) stamps `msg.route = routeBundle(panelType)`; arm keeps only pure cascade-build + the `groups` branch |
| `next_tab`/`prev_tab` (`_cycleViewerTab :159`) | `resolveTarget('viewer')` | extend `_viewerTabBundle()` to also return `target`; arm reads `msg.target` (removes a *double* resolveTarget — the bundle already calls it) |
| `_navRoute` (`:152`, filter arms `:923/:950/:967`) | `componentForPanel`+`hasInstance`+`paneTypeOf` | filter-mode handlers stamp `msg.route` for the filtered pane |
| `set_config` (`:1011`) | `componentForPanel('config-status')` | Flavor 2 — caller (`state.js`/`:set-config` path) stamps `msg.route` for the constant id, OR keep (see Decision) |
| `reset_group_context` (`:1038`) | `componentForPanel('actions'\|'containers')` | Flavor 2 — emitter (groups Component group-switch) stamps the two owners, OR keep |

## DESIGN DECISION — how far to push (pick during the arc)

- **(a) Flavor 1 only (RECOMMENDED).** Thread the focus bundle for
  `escape`/`list_select`/`nav_select`/`_navRoute`/`next_tab`/`prev_tab`. Leave
  Flavor 2 (`set_config`/`reset_group_context`) AS IS: their input is a literal
  constant and `componentForPanel(constant)` is a static registry lookup with no
  focus dependency — threading it just relocates an unambiguous lookup and
  arguably *reduces* legibility. Net: the reducer's focus-coupling is gone (the
  interesting part); the two constant-id lookups stay, documented as a narrower
  blessed read (registry lookup, not topology/focus).
- **(b) Full elimination.** Thread Flavor 2 too → `update()` imports nothing
  from `panel/route` and the Contract bullet flips to "strictly pure of
  (model,msg)." Cleanest signature, but spreads ownership lookups to callers for
  little gain.

(a) gets ~95% of the value (kills the focus coupling) for ~60% of the churn.
Recommend (a); revisit (b) only if the goal is literally "route import count in
runtime.js == 0."

## Cascade entry points (don't miss these)
`nav_select` is also reachable as a Cmd re-entering `applyMsg` from
`runEffects`? — verified NO today: it's dispatched only via
`dispatch.navSelect` (`dispatch.js:116`), called from key/mouse/intent handlers
(`actions.js:94/110/121`, `input.js:141/145`, `intent.js:74`). `escape`/
`list_select` likewise come only from key handlers. So each has a single
stamping site. RE-VERIFY this at implementation time (a new Cmd-emitting site
would need the bundle too) — a grep for each `type: '<arm>'` construction.

## Tests
Tests that drive these arms directly with a bare Msg must thread `msg.route`,
exactly as the F1 arc updated the docker/files tests to thread `augmentMsg`.
Affected: `test-runtime.js`, `test-immutable-runtime.js`, `test-state-resets.js`,
`test-config-status.js`. Add a `routeBundle` test helper mirroring the shell.

## Acceptance
- `grep -n "route\\.\\(getFocus\\|resolveTarget\\|componentForPanel\\|paneTypeOf\\|hasInstance\\)" js/app/runtime.js`
  returns nothing under option (b); under (a), returns ONLY the two Flavor-2
  constant-id lookups (and the arc updates the Contract bullet to scope the
  remaining read precisely).
- Suite + smoke green; the `escape`/`nav_select`/group-switch behaviors
  unchanged (pin with the existing reducer tests, re-threaded).
- No new staleness: the bundle is built in the same synchronous dispatch as the
  arm it feeds.

## Pointers
- Blessed exception A: `docs/v0.6.5-tea-reaudit.md` (ledger row A).
- Reducer route reads: `runtime.js:152-157, 174, 209-225, 240-248, 296-313,
  1029, 1051`.
- Contract bullet to update: `runtime.js:20-28`.
- Proven bundle precedent: `actions.js:42-50` (`_viewerTabBundle`).
- Route accessors + the state they read: `panel/route.js:445` (`getFocus`),
  `:499` (`resolveTarget`), `:72/:96` (`componentForPanel`/`paneTypeOf`),
  `:269` (`_layoutSvcSlice` — the layout service slice these resolve against).
- F1's augmentMsg threading (same shape, for Components): `feedback` +
  `docs/v0.6.5-tea-reaudit.md` F1.
