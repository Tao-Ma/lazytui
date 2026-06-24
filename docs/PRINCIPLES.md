# lazytui — Core Principles

Rules for the YAML config and the TUI renderer. Read this before
adding features or modifying either layer.

## 1. YAML defines, TUI renders

The YAML config is the source of truth. It defines what exists, what
it's called, what it does, and how it behaves. The TUI is a generic
renderer and executor — it should never contain domain knowledge.

**Test**: if you delete the TUI and write a new one from scratch, does
the YAML still fully describe the application? If yes, the separation
is correct.

Bad:
```python
# TUI knows what "inspect" means for a container
def _show_container_details(self):
    cmd = f"docker inspect -f '{{{{.State}}}}' {name}"
```

Good:
```yaml
# YAML defines what to run
inspect:
  type: inspect
  script: "docker inspect -f '{{.State}}' {name}"
```
```python
# TUI just executes whatever the YAML said
def _show_info(self, item):
    lines = item.info()
    self._set_output(formatted(lines))
```

## 2. Uniform schema, differentiated by `type`

Every action has the same fields. The `type` field is the only thing
that controls behavior. Don't add new top-level concepts — extend
`type` instead.

```yaml
# Every action, regardless of type, has the same shape:
action_key:
  label: "..."                    # display name (required)
  type: run|spawn|background|...  # execution mode (default: run)
  cmd: "..."                      # simple command
  script: |                       # or multi-line script (with var/helper resolution)
    ...
  desc: "..."                     # description shown in output panel
  confirm: "..."                  # optional confirmation prompt
  args: "..."                     # optional argument hint
```

Adding a new behavior = adding a new `type` value + one handler in
the TUI. No new fields, no new YAML structure, no new parser logic.

## 3. Data models describe themselves

Each dataclass has an `info() -> list[str]` method that returns
plain-text lines for the output panel. The TUI calls `_show_info(item)`
generically — first line bold, rest plain, all escaped for Rich.

The TUI never inspects dataclass fields to build display strings.
If the output needs to change, change `info()` in the dataclass, not
the TUI.

```python
# In parser/runnable.py — the model knows its own details
@dataclass
class ConfigFile:
    path: str
    var: str | None = None
    desc: str | None = None

    def info(self) -> list[str]:
        lines = [self.path]
        if self.desc:
            lines.extend(["", self.desc])
        if self.var:
            lines.append(f"var: ${self.var}")
        return lines

# In tui.py — the TUI knows nothing about ConfigFile fields
def _show_info(self, item):
    lines = item.info()
    formatted = [f"[bold]{_esc(lines[0])}[/]"] + [_esc(l) for l in lines[1:]]
    self._set_output("\n".join(formatted))
```

## 4. YAML order = display order

The order of groups in YAML is the order in panel 2. The order of
actions within a group is the order in panel 0. No sorting, no
priority fields. The YAML author controls layout by ordering entries.

## 5. TUI is a framework, not an application

The TUI provides:
- Panel rendering with borders, focus, scroll
- Keyboard navigation between panels
- Action execution by `type`
- Output display via `info()` or command result

The TUI does NOT provide:
- Knowledge of what containers are or what Docker is
- Knowledge of what any specific action does
- Business logic for any service or workflow
- Hardcoded commands, paths, or service names

## 6. Extend `type`, don't add concepts

When you need new behavior, ask: "can this be a new action `type`?"

| Need | Wrong approach | Right approach |
|------|---------------|----------------|
| Show container details | Add `inspect` field to group | Add `type: inspect` action |
| Stream logs | Add `output: stream` field | Add `type: stream` |
| Run per-container | Add `container_action` field | `type: inspect` with `{name}` template |
| Preview action | Add `preview` field | Add `desc` (same schema, always available) |

## 7. Escape `[` in all markup text

The panel renderer uses Rich-style markup (`[bold]`, `[green]`, etc.)
converted to ANSI escape sequences. Any literal `[` that reaches the
renderer will be misinterpreted as a markup tag — silently vanishing
and breaking `visibleLen()` width calculation, misaligning borders.

**Rule: every string with literal `[` must be escaped.**

- **Dynamic text** (user data, command output, YAML values): use `esc()`
  ```javascript
  setViewerContent(null, `[bold]${esc(action.label)}[/]\n${esc(text)}`);
  ```
- **Static strings** with intentional markup: write `\[`
  ```javascript
  `  \\[1] Containers  Status of containers in selected group`
  ```

`esc()` replaces `[` → `\[`. Defined in `js/leaves/ansi.js` (a pure leaf).

## 8. Selected lines: plain text in `[reverse]`, no inner markup

Selected/highlighted lines use `[reverse]` with NO closing `[/]` —
the panel renderer's padding spaces extend the highlight to fill
the full line width. A `[/]` reset before the right border stops
the bleed.

**Rule: no `[/]`, `[dim]`, `[green]`, or any markup inside a
`[reverse]` line.** Any `[/]` (ANSI reset) kills the reverse.

```javascript
// WRONG — [green]●[/] resets the reverse mid-line
return `[reverse] [green]●[/] ${name}`;

// RIGHT — plain text only, colors on unselected items
if (selected) return `[reverse] ● ${esc(name)}`;
return ` [green]●[/] ${esc(name)}`;
```

## 9. Components read state, they don't hold it

A Component's YAML config carries Component-specific *parameters* —
values that configure how it operates (branch name, output dir,
refresh interval, image list). It does NOT carry the user's *domain
data* — the paths, image refs, container names, or other facts that
already live in the project's top-level state.

When a Component needs to act on state that already exists at the top
level (e.g., `files:`, `vars:`), it should **reference** that state,
not duplicate it.

**Test**: if a path, name, or other user fact appears in two places
in the project YAML — once at the top level and once inside a
Component's config block — one of them is wrong. The duplicate
inevitably drifts; a fix in one place is forgotten in the other.

Bad — `config_branch:` redeclaring the path list:
```yaml
files:
  - { path: client, category: secret }
  - { path: data/cliproxyapi, category: secret, exclude: [data/cliproxyapi/logs/] }

groups:
  config:
    children:
      branch:
        config_branch:
          branch: config
          paths: [client, data/cliproxyapi]      # ← duplicates files
          excludes: [data/cliproxyapi/logs]      # ← duplicates per-file exclude
```

Good — `config_branch:` references `files:`:
```yaml
files:
  - { path: client, category: secret }
  - { path: data/cliproxyapi, category: secret, exclude: [data/cliproxyapi/logs/] }

groups:
  config:
    children:
      branch:
        config_branch:
          branch: config              # plugin parameter — fine
          source: files               # explicit reference
          categories: [secret, config]
```

Component hooks (`groupActions(group, name, config, model)` etc.) receive
the full config AND the live model, so a Component can read top-level
state without snapshotting it. v0.6.2 added the `model` arg — the
contract is that hooks remain pure projections (no IO, no mutation,
same inputs → same outputs); `getMergedActions` calls them transitively
on hot read paths, so a hook that shells out would block the event loop
on every line of stream output. The `groupActions` contract is
**always enforced** (read-only Proxy + timing via `panel/plugin-guard.js`,
in production too), with a `groupActionsMemo: true` opt-in fast path — see
docs/PLUGINS.md §"The groupActions contract".

When a Component must accept the same data both ways (legacy explicit
list *or* reference), expose `source:` as one alternative and validate
at parse time that exactly one of them is set. Never silently fall
back — explicit refusal beats a surprising default.

## 10. Layout framework

The TUI is a **lazytui** framework — a reusable N-column layout for
lazygit/lazydocker-style projects. The layout pattern is fixed at the
structural level (column-major grid, detail/actions anchored to the
last column); the content + column count are YAML-configurable.

- **Fixed**: column-major grid, bordered panels with scrollbars,
  navigation (hotkeys, ↑↓ j/k, ←→ h/l, mouse, `x` menu, `?` help),
  detail panel tabs (`]`/`[`), view modes (`+`/`_`), themes,
  free-config mode (`:free-config`), action execution.
- **Configurable**: panels, panel types, sizes, theme, layout
  (column count + per-column widths + per-pane heights) — via the
  YAML `panels:` (pool, v0.6+) + `layout:` (columns list, v0.6.2+)
  sections.
- **Constraints**: first column soft-cap of 6 panes (hotkeys `1`–`6`
  auto-assigned by position), last column soft-cap of 3 panes
  (hotkeys `7`–`9` auto-assigned). Middle columns (only when N ≥ 3)
  have no auto-hotkey pool — explicit `hotkey: <char>` required.
  Exactly one `detail` tab in the last pane of the last column; at
  most one `actions` tab in the last column. YAML can override per-
  pane via `hotkey: <char>` — auto-assignment skips keys claimed
  explicitly. Soft caps warn at parse but don't refuse.

See **LAYOUT.md** for the full panel-type catalog, YAML schema, and
visual concept. See **PLUGINS.md** for the Component API surface.

## 11. Render is idempotent on equal state

A panel's `render(panel, width, height, slice)` called twice with the
same inputs produces the same output, and the second call observably
does not change anything that would alter a third call. Same for
`render()` at the layout level — calling it back-to-back is a no-op
beyond writing pixels.

This is **weaker than "render is pure"** (no mutation, no I/O). lazytui
once admitted a layout-write impurity here; it has since been retired
(first bullet), leaving the seams that keep render pure (and two narrower
overlay-subsystem reads, called out at the end):

- **Layout geometry is pure-derived, not written** — RETIRED outside-writer
  exception. Pane bounds and per-panel heights are computed on demand from
  `(arrange, dims, viewMode)` via memoized selectors in `leaves/wm/geometry.js`
  — there is no `slice.paneBounds`/`slice.panelHeights` field and no
  calcLayout/render write (blessed-exceptions A.2/A.3 retired the writes;
  #D7 2026-06-18 deleted the `paneBounds` field). The per-Navigator
  keep-in-view scroll clamp likewise no longer rides `calcLayout()`: it runs
  in the post-dispatch finalizer and routes through a `set_scroll` Msg
  (resize-as-Msg arc), so it is a dispatch-time single-writer update, not a
  render-side write. (History: `docs/history/v0.5-layering.md`.)
- **Hub subscriptions** are DECLARED + RECONCILED — canonical TEA
  `subscriptions : Model → Sub` (#D13). A Component exports a pure
  `subscriptions(paneDef, model) → [{topic, window}]`; the framework
  re-evaluates the whole desired set each dispatch (the post-dispatch
  finalizer calls `app/state.js#reconcileSubscriptions`), DIFFS it against the
  live set, and starts/stops the delta — `hub.subscribe` on pane-place,
  `hub.unsubscribe` on pane-remove. Render stays pure; the runtime owns the
  effect. (v0.6.4 Phase D introduced the declared seam wired at mount but with
  no teardown — a placed-then-removed pane leaked a live sub; #D13 made it a
  full reconciler. Stats was the pre-D lazy-subscriber via `_ensureSub`; that
  exception is long retired.) **Initial-state seeding
  — init-injection (v0.6.4 #4).** A Component that needs root/pane facts to
  seed its initial slice receives them as an argument: the mint loop
  (`app/state.js`, the impure first-touch shell) threads a seed
  `{ config, projectDir, paneDef }` into `comp.init(paneId, seed)`.
  config-status (the sole consumer) derives files/projectDir/branch from the
  seed and reads NO globals — `init` is a pure function of `(paneId, seed)`.
  This mirrors `register.init(config.register)` and retired the last
  cross-slice init read (it previously reached for `getModel()` +
  `getInstanceSlice('layout')`). Seed-blind inits arity-ignore the arg.

**Overlay subsystem — the model-clock arc** (`js/overlay/*` +
`leaves/render/draw.js#renderOverlay` + `render/footer.js`). The overlay render
layer originally read both its clocks (dims + time) outside the model, making
overlay renders non-idempotent on equal *model* state. The model-clock arc
resolved both:

- **Terminal dims — RESOLVED.** Overlays + the footer now resolve terminal
  size from the model clock (`layoutSlice.dims`, resize-as-Msg) via
  `leaves/render/draw.js#viewportDims()`, with `io/term.cols()/rows()` kept only as
  a boot fallback. Previously the panel grid read `layoutSlice.dims` while the
  footer + all 8 overlays + `renderOverlay` read the `io/term` singleton (the
  upstream terminal cache), which could lead the model by a frame on resize.
  The source-of-truth is now unified. (Since the render-exit arc moved the panel
  renderer to the `leaves/render/draw` leaf, the model-read is an injected
  `setDimsProvider` seam wired from `panel/api` — the leaf never reaches up into
  panel; see `docs/v0.6.5-render-exit.md`.) Pinned by `test-overlay-dims.js`.
- **Wall-clock age columns — under the model (`model.now`/tick).**
  `renderDiagLog`/`renderJobsOverlay` read `now` threaded from the paint frame,
  never `Date.now()` in their bodies, so each is a pure function of
  (side-store, model, now) — snapshottable given a fixed `now` (pinned by
  `test-overlay-clock.js`). The wall-clock read itself is now under the model:
  `render(model)` reads `model.now` (a pure-by-construction view — no
  `getModel()` default, #D6), and `model.now` is advanced only by the gated
  `clock_tick` reducer arm (the self-re-arming tick runs ONLY while an age
  overlay is open; see `docs/model-now-tick.md`). So the wall clock is
  replay-safe data in the model, not a per-paint read. Residual / root context:
  both overlays render from **out-of-TEA side registries**
  (`feature/jobs.js`'s `_jobs` Map via `jobs.list()`; `io/diag-log.js`'s ring
  buffer via `diag.snapshot()`), NOT the model — so the frame is pure of the
  wall clock but still NOT a pure function of the model. That broader gap (the
  jobs / diag / history / PTY / theme live stores the frame reads) is the **#D5
  replayability boundary** — see `model/store.js` §Replayability boundary.

**Why the rule matters:**

- **Replay tests.** If render output is a function of state alone,
  a stored state snapshot replays to a known string. The
  TEA-inspired event log (planned for v0.2.x) needs this guarantee.
- **Snapshot tests.** Same-state-twice can be asserted in unit
  tests without elaborate setup. `js/test/test-render-idempotent.js`
  is the canonical example.
- **Diff repaint.** `layout.js#paintColumns()` writes only the rows
  that changed since the previous frame. If render were
  non-idempotent the diff cache would silently desync — the user
  sees stale pixels.

**Rule for new panel renders:** read the slice, return a string. Need a
hub subscription? Declare it via the `subscriptions(paneDef)` hook — the
framework wires it at mount (see `stats.js`). Need root/pane facts to seed
the initial slice? Take them from the mint-loop seed — `init(paneId, seed)`
receives `{ config, projectDir, paneDef }` (see config-status); don't reach
for `getModel()` / `getInstanceSlice()` in `init`, and keep `render()` pure
of such reads.

## 12. TEA shape and the Component discipline

Every panel is a **Component**: the framework owns a state slice per
Component, messages arrive through `update(msg, slice)` which returns
either the next slice or `[nextSlice, effects]`. Effects are plain data
descriptors (`{ type, … }`) the effects layer runs: async work, a
viewer write, a repaint, a recurring `tick`, a `msg` re-dispatch
(routed by `msg.kind` — wrapped → Component fan-out, flat → root
reducer). An effect's async result feeds back
as a Msg (`dispatchMsg`). Render receives the slice, not the root
model. Key events arrive as `{ type:'key' }` Msgs — only to the
focused Component, only when no modal owns input.

The earlier "Plugin" shape (stateless renderer + `onKey`) and the
slot-keyed decorator framework retired in v0.5 Phase 5/6. The single
Component API replaces both.

```js
module.exports = {
  name: 'mycomp',
  init: () => ({ items: [], selected: null, loading: false }),
  update: (msg, slice) => {
    switch (msg.type) {
      case 'key':
        if (msg.key === 'down') return { ...slice, selected: nextItem(slice) };
        return slice;
      // Async work is an EFFECT, never done inline (keep update pure):
      case 'refresh':      return [{ ...slice, loading: true }, [{ type: 'fetchItems' }]];
      case 'itemsLoaded':  return [{ ...slice, items: msg.items, loading: false }, [{ type: 'render' }]];
      default:             return slice;
    }
  },
  panelTypes: {
    mycomp: {
      render: (panel, w, h, slice) => { /* reads slice */ },
      // To claim a keystroke, return `{ type: '_claimed' }` as one of
      // the effects from `update()`; the framework consumes it.
    },
  },
};
// register with: api.registerComponent(component); register the fetchItems effect
// with api.registerEffect('fetchItems', fn) — fn does the async work + dispatchMsg.
```

### Rules

- **Reducer arms stay pure of `getModel()`** (v0.6.3 Phase D). Within
  `update(msg, slice) → (next, cmds)`, the arm body MUST NOT call
  `getModel()`; root facts the arm needs are threaded via Msg payload
  by the dispatcher (the `modelBundle` pattern — see
  `[[elm-tea-discipline]]`). Component-level surfaces OUTSIDE arms
  (handlers, finalizers, contributors registered with the framework)
  may still read `getModel()`; the rule applies to the arm body only.
  **The framework provides a seam for Components that need model-derived
  facts in their reducer: an optional `augmentMsg(msg, model)` hook**
  (`api.js`, called at both `comp.update` sites). The impure dispatch shell
  computes the facts ONCE and threads them into the Msg payload, so the
  Component's whole `update` — arms AND finalizer — stays pure of
  `getModel()`. The viewer uses it: `augmentMsg` attaches a
  `pt.viewerModelBundle` (current group, its config, the COMPUTED merged
  actions, yaml terminals) as `msg.viewerModel`, and `viewer.update` derives
  its active-tab lines + tab-transition capture from that bundle via the
  `*FromBundle` readers — **no Component reducer reads `getModel()` anymore**
  (blessed-exceptions #3, 2026-06-15). Render still may (`detailTitle`/
  `render` read the model as their view input — §11).
- **The ROOT reducer (`runtime.update`) is held to the same bar**
  (v0.6.4 Theme C). Its arms may do ROUTING reads via `route`
  (`getFocus` / `componentForPanel` / `paneTypeOf` / `resolveTarget` —
  the blessed chokepoint), but MUST NOT read Component-slice *values*
  (`multiSel.size`, `slice.tab`, `flatTabInfo`, `buildItems(slice)`) to
  branch — those are threaded via Msg payload by the dispatching handler
  (e.g. `escape`'s `hadMultiSel`, `next_tab`'s tab bundle, `menu_open`'s
  `items`). There are now **no exceptions**: `jobs_activate`'s viewer reads
  (the last holdout — they depend on the post-switch `currentGroup`, so
  they couldn't be hoisted to dispatch *time*) were split out in v0.6.4
  Phase C. `jobs_activate` is a pure orchestrator that closes the overlay,
  queues the group switch, and emits a `jobs_route` Cmd; that effect runs
  AFTER the switch commits, reads the now-correct viewer slice in the
  dispatch layer, and threads the resolved tab into the pure `jobs_routed`
  arm. "Not threadable within one Msg" was true — a second Msg makes it
  threadable.
- A Component **never writes** the root model. The Component's own
  slice is the only thing its `update` writes directly. Cross-layer
  writes go out as a `{type:'msg', msg}` effect — a wrapped Msg
  (`{kind, msg}`) fans out to the named Component, a flat Msg
  re-dispatches through the root reducer. The framework runs them,
  so single-writer per layer holds.
- **Msg routing.** `refresh` / `action` fan to every Component's
  `update`. **Key Msgs go ONLY to the Component owning the focused panel, and
  ONLY when no modal mode is active** — a modal (filter / menu / cmdline / …)
  owns input, so the focused panel must not also see the key. To suppress
  the framework's default for a key the Component handles, its `update`
  returns a `_claimed` sentinel as one of the effects (e.g. files claims
  `return`; config-status claims `t s return`). The framework filters
  `_claimed` out of the effect list and skips the global default.
- **Wrapped Msgs.** Component-specific Msgs MUST be wrapped via
  `api.wrap('name', innerMsg)` (so the framework routes to exactly one
  Component); only the three framework signals above fan out unwrapped.
- **Effects stay out of `update`** — return `[slice, effects]`, never perform
  I/O inline (keeps `update` pure + replayable). The framework runs effects;
  an effect's async result re-enters as a Msg.
- **Periodic work is self-driven.** No framework poll loop — a
  Component drives its own cadence by re-emitting a `tick` effect from
  its tick-Msg handler (docker polls this way — the self-re-arming-tick
  Cmd pattern).
- An `update()` returning `undefined` leaves the slice unchanged (no-op
  escape hatch).
- Components also contribute `commands` / `groupActions` / `statusFor` /
  `viewContributions` / `cleanup`, collected by the framework.
- **Single accessor per derived collection.** When state has BOTH a
  YAML-declared half AND a Component-contributed half (today's
  example: `group.actions`), give every reader ONE canonical
  accessor that returns the merged view fresh. Pre-v0.6.2 had
  three merge sites and four direct readers — the inconsistency
  was a bug surface (`pg:status` invisible, etc.). The fix:
  `panel/api.getMergedActions(groupName)` is the single source of
  truth; every reader (tab strip, leader resolver, actions panel,
  shadow check, group-info display, CLI `--list` / `--exec`)
  routes through it. **No config mutation** — the merged set is a
  pure derivation, not a baked-in side effect, so plugin output
  can read live model state without going stale. Apply the same
  shape to any future merged-collection surface.
- **One role per display surface.** When a display surface drifts
  into hosting two semantically different things (v0.6.2 example:
  Info doubling as "selection info" + "unrouted transcript"), the
  shared surface breeds guards / restore branches / divergent
  mirrors. Separate into two surfaces (e.g., Transcript tab took
  over the accumulator from Info). Each role gets a clean reducer
  arm; cross-cutting cascades dissolve.

### Two homes for state

Both *centralized* (root model) and *decentralized* (Component slice)
are legitimate. The choice is per-piece-of-state:

- **Centralized** — state in the root model (`model.modal.*`,
  `model.modes.*`, the in-flight cmdline / prompt / confirm /
  registerPopup buffers), logic in the root reducer
  (`runtime.update`). Cross-cutting modal buffers stay here.
- **Decentralized** — state in a per-Component slice, logic in the
  Component's own `update`. The slice is the encapsulation boundary;
  cross-layer reads go through `getModel()`, cross-layer writes
  through effects.

> **Is this state messy + self-contained enough that isolating it in a
> Component slice (with its own effects) beats folding it into the
> shared root model?**

The genuine isolation wins live on slices: docker's polling loop +
stats + events subprocess; files' per-panel directory browsers;
config-status' git-worktree cache; the viewer's content tabs +
ephemeral terminals; the groups tree's `expanded` Set; per-Navigator
nav chrome (`slice.nav[panel].cursor/scroll/multiSel`, Phase 4a). The
layout Component owns the frame (focus, viewMode, freeConfig, panel
arrangement) — slice-private but loaded via cross-layer Msgs.

> **Producer survives the consumer's tab.** When a long-running
> producer (streamed action, future job entry) outlives the user's
> attention on its tab, give it a per-id buffer in the slice and
> route its writes by id (e.g. `slice.actionTabBuffers[group][key]`).
> The active-tab "viewer" is then a DERIVED view — computed from the
> per-id homes via `pane-tabs.viewerLines` (and search matches via the
> `ms.matchesFor` memo), never stored. Pre-Phase-2 the viewer's
> `slice.lines` doubled as "the active tab's content" AND "the
> streaming producer's sink," forcing kill-on-switch as the only way
> to avoid cross-talk; the v0.6.4 viewer-lines selector arc finished
> the separation by deleting the stored mirror entirely. The pattern:
> canonical content lives in per-id homes; anything computable from
> them is a memoized selector, not a slice field — stored derived
> state carries a standing invariant every reviewer must re-learn and
> every new write path can silently break.

> **Consumer view-state survives the tab switch.** Complement to the
> producer rule: per-tab *view* state (scroll position, search match
> index, selection range, cursor) also wants to outlive the active tab.
> Resist the temptation to mirror it to a per-tab map on every Msg
> (v0.6.2 T3b-e shipped that and the redundancy bit back). Keep the
> live view in `slice.{scroll, search, select, cursor}` as a single
> active mirror, and capture only on transition: a single sync point
> in the **finalizer** compares `next.tab !== originalSlice.tab` and
> writes the leaving tab's view-state into a keyed map
> (`slice.tabState[key]`) exactly once per switch. The capture site
> catches every path that mutates the tab idx — `tab_switch`,
> auto-jump (`stream_start` routed + unrouted), primitive bypasses
> (`viewer_set_tab` from `setActiveTab()`), and the navSelect yank
> (`viewer_show_info`). Generalisation: **when N reducer arms mutate
> the same field and a side-effect should fire on every transition,
> detect the transition in the finalizer, not in each arm.**
>
> *Carve-outs for the capture.* Two cases where the finalizer must
> SKIP the FROM-capture:
>   - **Override active on leave** (B2). When
>     `originalSlice.viewerOverride` is set, `slice.{scroll, search,
>     select, cursor}` belong to the discrete-doc, not to the
>     underlying tab. Capturing them into `tabState[fromKey]` would
>     clobber the user's real saved state on fromKey. The override is
>     a transient lens over whatever tab is active; archiving its
>     state as if it were per-tab is wrong by definition.
>   - **FROM tab removed** (R5). When the leaving tab was destroyed
>     in this same Msg (`removeContent` / `removeEphemeral`), the
>     `tabState[fromKey]` entry was just dropped and there's nothing
>     to come back to. Re-creating the entry from the about-to-vanish
>     view state would silently undo the removal's hygiene. Detection:
>     re-resolve fromKey against `next`'s content/ephemeral stores; if
>     gone, skip.
>
> *Restore lives in multiple arms.* The capture is unified in the
> finalizer; restore is split per kind of transition: `tab_switch`
> runs the full user-initiated cascade (override clear + terminal
> exit + bottomSticky tail-track), `viewer_set_tab` does the
> minimal producer-initiated restore (skips when override is active —
> the override owns view-state), `viewer_show_info` restores Info
> on the navSelect yank. Each arm reads `tabState[toKey]` through
> the same canonical resolver (`pane-tabs.resolveTabKey`).
>
> **Stable string keys outlive numeric indices.** Key per-element maps
> (tabState entries, per-id buffers) by stable string identity
> (`'<group>:action:<name>'`, `'<group>:content:<id>'`), not by
> position. Adding or removing siblings renumbers the strip; stored
> entries should remain correctly addressed. Stable AND unique: when
> per-group surfaces share the same domain key (`test` action in
> every group), prefix with the disambiguator (the group name) so two
> groups don't collide on `tabState['action:test']` (B4 regression —
> pre-fix, group A's view state restored onto group B's tab).

> **Out-of-TEA module-local stores.** Two cross-cutting registries
> live OUTSIDE the slice graph: `feature/history` (completion log
> of every action that's run) and `feature/jobs` (live state of
> every child lazytui spawned — streams, PTYs, background, tmux).
> Both: module-local `Map`, pure public API (`register` / `update` /
> `close` / `list`), `scheduleRender()` on mutation, consumed by
> render-time readers (the history navigator, the Running overlay).
> No Component slice and no Msg fan-out — the data is global by
> nature (cross-pane, cross-group, multi-producer) and forcing it
> through a single-writer slice would be ceremony for no win. The
> guardrail: producers report at lifecycle boundaries only (spawn
> + close), and the registry mutator is the ONLY writer the
> renderer reads from. Reach for this pattern only when the data
> truly spans the slice graph; default to a slice.
>
> *Renderer-only-reader, enforced.* Reducer arms must NOT call
> `feature/jobs.list()` / `feature/history.all()` inline — that
> would break the renderer-only-reader half of the contract and
> import producer-local state into pure-function-of-(slice, msg)
> reducer bodies. Resolve the entry on the handler side and thread
> it into the Msg payload. v0.6.2 R2 fixed exactly this in
> `jobs_activate`: pre-R2 the reducer called
> `require('../feature/jobs').list()` to look up the cursor; post-R2
> the handler (`dispatch.handleJobsKey` at Return) resolves the
> entry and passes it via `msg.job`, keeping the reducer pure.

## 13. Checklist for new features

Before implementing, verify:

- [ ] Is the behavior defined in YAML, not hardcoded in TUI?
- [ ] Does it use the existing action schema (same fields)?
- [ ] If new behavior, is it a new `type` value (not a new field)?
- [ ] Does the dataclass have `info()` for output panel display?
- [ ] Does display order come from YAML order?
- [ ] Can you delete the TUI and rebuild it from the YAML alone?
- [ ] Is every dynamic string passed through `esc()` before markup?
- [ ] Do static strings with literal `[` use `\[`?
- [ ] Do selected lines use plain text in `[reverse]` with no inner markup?
- [ ] Is the `[reverse]` left unclosed (panel renderer adds reset before border)?
- [ ] Does the Component reference top-level state (`source: files`, top-level vars) rather than redeclaring it inside its own config block?
- [ ] Is each Component's `render()` idempotent on equal state? (§11)
- [ ] Does each piece of state live in the right home — Component slice for slice-shaped state with async work, root model for cross-cutting chrome (modes, modal sub-models, currentGroup)? (§12)
- [ ] Does `update()` return a new slice (or `[slice, effects]`) rather than mutate root model, keep effects/I-O out of `update`, and never write any layer it doesn't own? Does it return a `_claimed` sentinel effect for keys it handles? (§12)
- [ ] Are Component-specific Msgs wrapped via `api.wrap('name', msg)` at the dispatch site? (§12)
