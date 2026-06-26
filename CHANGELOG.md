# Changelog

All notable changes to lazytui are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Architecture

This release drives the decision layer to the honest pure-TEA ceiling:
`frame = f(model)` now holds for every panel and overlay except the one
irreducible terminal island (the PTY/xterm screen buffer, which a child
process mutates outside the message loop) — now formalized as the
**foreign-component contract**
([docs/foreign-components.md](docs/foreign-components.md)), with the terminal
as its reference implementation. Spec: [docs/v0.6.6.md](docs/v0.6.6.md).

- **Live external state is now declarative `Model → Sub` for every source.**
  The subscription reconciler (previously hub-topics-only) became
  kind-dispatched, and the four hand-rolled OS sources — the stdout resize
  listener, the terminal-overlay repaint poll, the docker container poll, and
  the `docker events` stream — moved onto it as `resize` / `interval` /
  `process-stream` subscriptions, each started, stopped, and torn down as a
  pure function of the model (on layout change and on quit; a spawned child no
  longer outlives the TUI). The frame clock joined them as a model-conditional
  `interval` subscription, and the self-re-arming-timer pattern was retired.
  Periodic work and external events are subscriptions now, never raw
  `setTimeout`/listeners. (FIX-3.)
- **The three discrete off-model stores are mirrored into the model.** Jobs,
  the diagnostics ring, and command history are sampled into
  `model.{jobs,diagLog,history}` by a `store-mirror` subscription over a uniform
  `{snapshot, setOnChange}` store contract, so the Running overlay, the
  diagnostics window, and the history navigator render from the model instead
  of reaching into module-local stores. (FIX-1.)
- **The stats graph reads the model, not the live metrics bus.** A throttled
  `metrics-mirror` subscription samples the metrics time-series into
  `model.metrics[topic]` at a bounded cadence (one message per window), so the
  stats panel renders as a pure function of the model without re-introducing a
  per-sample dispatch. (Finding B.)
- **The single same-slice finalizer write was retired.** The post-dispatch
  finalizer no longer writes the viewer's derived viewport height onto its
  slice; the value is stamped on each viewer message and committed by the
  viewer's own reducer, so the viewer is the single writer of its own state.
  (FIX-2.)
- **The decision layer is fully pure of the live model.** The viewer's
  tab-switch reducer derives its tab counts from a threaded message bundle
  instead of reading the live model, so every reducer/component-update arm is a
  pure `(state, message) → [state, commands]`. (Finding A.)
- **Render-path diagnostic writes deferred off the read path.** The plugin
  purity/timing guard and the strict-miss tripwire queue their warnings, and the
  dispatch finalizer drains them once per dispatch, so drawing a frame no longer
  triggers a re-entrant dispatch or a wall-clock read. (Finding C.)

### Added

- **Session replay.** A session can be recorded and reconstructed. Recording writes a
  single append-only log of the ordered message stream plus the terminal's output byte
  stream under one global sequence — started by `--record-save <file>` (from boot) or
  the `:record-save` cmdline verb (mid-session, which checkpoints the current state
  first so the file is self-contained), and ended by `:record-stop`. A recording is
  reconstructed by re-applying that log through the pure reducers with side effects
  suppressed — no config needed (the log carries it), no real terminal spawned. Because
  every state change flows through a message, the reconstructed model and frame are
  identical to the original (the embedded terminal is reconstructed from its recorded byte
  stream — the materialized proof of `frame = f(model)` for everything except, and now
  including via the side-channel, the terminal island). **Checkpoints** snapshot the full
  state so reconstruction can seek instead of folding from the start; while recording, one
  is written automatically every ~256 KB of log (a bytes-primary cadence, since re-feeding
  recorded terminal output is what makes a seek expensive — with a high entry-count safety
  ceiling), so even a long session stays fast to recover (a repeated `:record-save` while
  already recording is a no-op). `--record-load <file>` (or the `:record-load` verb in a
  running session) opens the recording in an **interactive control pane** — a float listing
  the checkpoints by timestamp, with a cursor to scrub and play / pause / reverse at any speed
  from **⅛× slow-motion to 16× fast-forward**; the panels underneath reconstruct to the
  current point. The pane cycles three view states (`p`) — full (checkpoint list), **mini** (a
  compact bottom bar with just position + a progress bar you can **click to seek**, so playback
  stays watchable without covering the view), and hidden. (`--record-print <file>`
  is the headless variant — reconstruct, print the frame, exit — for scripts / CI.)
  Playback runs on a **monotonic-anchored presentation clock** (drift-free, self-correcting)
  with a steady ~30 fps scheduler that skips frames that don't change — so speed is smooth
  regardless of per-frame reconstruction cost. Two modes (toggle `m`): **realtime**, which
  reproduces the recording's pacing but **caps idle gaps** (cycle the cap with `i`) so dead
  air never freezes playback, and **even**, a fixed entries/sec review pace. Forward play
  folds only the new entries; reverse uses a bounded per-checkpoint-interval model snapshot
  ladder for flat per-frame cost. Spec: [docs/v0.6.6-replay.md](docs/v0.6.6-replay.md).
- **Replay change highlighting.** The replay scrubber's `d` key cycles a change-highlight
  mode (off → line → cell) that tints what changed since the previously-displayed frame —
  whole changed rows, or (cell mode) just the changed columns, glyph-only. It reuses the
  renderer's existing per-row diff, applies the highlight only to emitted output (never to the
  diff baseline), and is replay-only, so the live paint path is unchanged.
- **Terminal-emulator port.** The embedded terminal's emulator now sits behind a
  defined screen port (`io/term-screen.js`) — the one module that imports it — so the
  session layer, render, and the replay snapshot all reach the screen through a small
  stable interface. Swapping the emulator means reimplementing one adapter.

### Fixed

- **Replay exit restores live terminals.** Exiting an in-session `:record-load`
  replay now restores the live terminal screens, not just the model. Terminal
  session ids are deterministic, so replaying a recording made from the same
  config wrote replay bytes into the live emulator screens; exit previously left
  those panes showing replay output. (The rebuilt screen is frozen at the live
  grid — see [docs/v0.6.6-replay.md](docs/v0.6.6-replay.md).)
- **Multi-viewer viewport height.** Each viewer pane now derives its own
  viewport height; the previous single finalizer write only refreshed the
  primary viewer's, so scroll- and cursor-clamping could use a stale height in a
  layout with two or more viewers.

## [0.6.5] — 2026-06-24

### Added

- **Embedded-PTY scrollback + mouse.** The embedded terminal tab
  (node-pty + xterm-headless, used when spawning outside tmux) now has
  scrollback. The mouse wheel over a terminal pane scrolls its history
  — both when simply viewing the tab and while interacting in terminal
  mode — and `Shift+PageUp`/`PageDown`/`Home`/`End` scroll from the
  keyboard. Mouse forwarding is now smart: bytes reach the child only
  when it enabled mouse reporting (vim, htop, `less --mouse`); otherwise
  the wheel is the framework's scrollback control. A reverse-video
  `[↑N]` indicator shows how far back the view sits, and any keystroke
  at the prompt snaps back to the live bottom. (v0.6.5 §5(a);
  `docs/v0.6.5.md`.)
- **Runtime mint/dispose of per-pane Component instances.** Component
  slice instances are now created and disposed as panes are placed or
  removed at runtime (not just at boot), reconciled once per dispatch
  through the post-dispatch finalizer gate. Backs same-kind multi-pane
  and multi-viewer layouts that change live. (v0.6.5 §5(b).)

### Changed
- **The two `leaves/` modules that reached up into `panel/` no longer do.**
  `leaves/geometry.js`'s `halfProjection` takes the resolved viewer paneId
  as an argument (callers thread `route.resolveViewerPaneId()`) instead of
  reaching for `panel/route`; `leaves/pane-tabs.js` gets its merged-actions
  map from an injected provider (`setMergedActionsProvider`, wired once from
  `panel/api` on load) instead of `require('../panel/api')`. `leaves/` now
  imports only sibling leaves — and pane-tabs' hot paths shed the former
  per-call require resolution. Internal layering cleanup, no behavior
  change. (v0.6.5 §3.)
- **`io/terminal.js` is now a true leaf.** It used to reach *up* into
  `app/runtime` (spawn cwd), `render/render-queue` (post-output repaint),
  and `feature/jobs` (job lifecycle) despite a header claiming otherwise.
  Those are now injected at boot (cwd via an `ensureSession` argument;
  `setRenderHook` / `setJobsHooks` wired from
  `panel/viewer/pty-lifecycle.install`, mirroring `setExitHandler`), so the
  module's only requires are `node-pty` + `@xterm/headless` and `io/` has
  no upward imports. Internal layering cleanup, no behavior change.
  (v0.6.5 §2.)
- **`dispatch/modes.js` re-homed to `leaves/modes.js` and purified.** The
  modal-state registry has no dispatch behavior, so living under
  `dispatch/` made `render → dispatch` read as a layer violation. It's now
  a genuinely pure, dependency-free leaf: the predicates
  (`isModal`/`isOverlayActive`/`isChainActive`/`suppressesChromeClicks`/
  `resetModes`) no longer default their modes-bag via a lazy
  `getModel()` reach into `app/runtime` — callers pass it explicitly
  (internal cleanup, no behavior change). (v0.6.5 §4.)
- **Render reads time from the model, not the wall clock.** The
  render-side `Date.now()` (drag-preview / animation timing) is replaced
  by `model.now`, advanced by a `tick` Msg. Rendering is now a pure
  function of the model, so a recorded Msg log replays deterministically.
  (blessed-exception D; `5488146`.)
- **Theme selection is model state.** The active theme used to live only
  in a `leaves/themes` module global, set imperatively (with a hand-rolled
  `:theme` undo). It's now `model.theme`, updated by a `set_theme` Msg
  whose Cmd syncs the palette cache the pure render leaves read — so the
  cache is a single-writer derived view of the model (the same shape as
  `model.now`). The theme is part of the model snapshot: `:theme`
  preview/restore flow through the Msg, and a recorded Msg log replays the
  theme too. (`a23d785`.)

### Architecture

This release makes the module layer graph **fully acyclic** (`dep-walker`
reports no layer SCCs in either mode) through a sequence of structural
arcs. Specs: [docs/v0.6.5.md](docs/v0.6.5.md), `v0.6.5-tea-reaudit.md`,
`v0.6.5-render-exit.md`, `v0.6.5-dispatch-loop.md`,
`v0.6.5-reducer-cleanup-relocation.md`, `tea-review-2026-06-18.md`.

- **TEA-conformance review #3 (D1–D17).** A fresh doc-/memory-blind re-read
  of the source against canonical TEA produced 17 decisions, all resolved
  on the `tea-review-fixes` branch (ledger:
  [docs/tea-review-2026-06-18.md](docs/tea-review-2026-06-18.md)). The graph
  was already acyclic and stayed so throughout. **Layering/file-layout:**
  the stateful bottom-of-graph residents (`hub`, `render-queue`, `themes`)
  carved into `leaves/infra/` so `leaves/` proper means *pure transform*
  (D1/D3); the rest of `leaves/` sub-grouped by domain —
  `free-config/ render/ text/ input/ wm/` (D2, cosmetic to the layer graph);
  the runtime loop given a single home — `runtime/fanout.js` → `runtime/loop.js`
  with the after-update phase split to `runtime/finalize.js` and the root-Msg
  pump `applyMsg` co-located beside the Component pump (D4). **Purity/correctness:**
  `render(model)` no longer defaults to `getModel()` — pure by construction (D6);
  the theme palette is now *projected from `model.theme` at render entry* and the
  `set_theme` effect retired, so a replayed Msg log reproduces the theme palette,
  not just its name (D8); the root reducer is now pure of the ownership registry
  (handler-stamped `msg.csOwner`/`msg.owners`, D9), `groups.update` reads a
  handler-stamped `viewerTarget` instead of resolving route topology (D10), and the
  dual "refresh viewer info" pathway collapsed to one Msg-driven cascade (D11).
  **Cohesion:** the reducer monolith decomposed into nine per-modal sub-reducers
  under `dispatch/update/modal/`, 1,055 → 343 LOC (D12). **Subscriptions:** a
  canonical `Model → Sub` reconciler re-evaluated each dispatch — a pane leaving the
  layout now tears its subscription down, fixing a placed-then-removed-pane sub leak
  (D13). **Bounded non-TEA islands documented at the site:** the PTY/xterm pane (D14)
  and its 250ms safety-net repaint, which an attempt to remove proved load-bearing
  via `smoke/pty-overlay.js` (D15). Dead code dropped: the unconsumed broadcast
  `{type:'hub'}` Msg that ran N no-op updates per publish (D17). Doc-only
  reconciliations corrected the frame-purity boundary claim (D5) and the stale
  renderer-as-writer / `innerH` history (D7/D16). A post-review hardening closed the
  review's one residual: a use-site alignment guard for the closure-by-index Cmds
  (`copy_commit`/`cmdline_run`) aborts rather than invoke the wrong closure if a held
  closure table ever diverges from the entry the user selected. The selected entry's
  identity (display/label) is captured at reduce time and carried on the Cmd, so the
  guard stays load-bearing even though the submit/select arm has cleared the model
  projection by the time the effect runs (F4.4; `test-index-align.js` pins both
  construction parallelism and the live abort). No intended behavior change beyond the
  D13 leak fix (the guard is an inert tripwire on a healthy build); suite 97/97, smoke
  11/11, acyclic both modes, benches parity per commit. (`tea-review-fixes` branch.)
- **Render-exit (layer SCC 5→4).** The pure render tier moved down into
  `leaves/`: the panel renderer → `leaves/draw.js`, plus
  scrollbar/painter/themes/render-queue; `decor` split into a pure half
  (`leaves/draw`) and the slice-reading hit-tests
  (`panel/chrome-hittest.js`). Dispatch/overlay painting now routes
  through the render-queue seam. `render/` is down to `paint.js` +
  `footer.js`. A follow-up moved the embedded-terminal PTY spawn + resize
  out of the render pass into the dispatch finalizer (the runtime reconcile
  that already derives viewport geometry), so render only READS the session
  buffer — it never creates or sizes external state. (`2bd1c3f`.)
- **Domain-detangle (layer SCC 4→3→0).** `feature` was extracted to the
  bottom via injected seams, then the remaining `{overlay, panel,
  dispatch}` cycle was dissolved with an injected dispatch port
  (`ports/panel-host.js`) wired at boot by `dispatch/host-wiring.js`.
- **Pure injection ports → a `ports/` layer.** The two pure-delegation
  host ports (`panel-host`, `feature-host` — nothing but injected fn slots
  + delegating wrappers, no transform logic) moved out of `leaves/` into a
  dedicated bottom `ports/` layer, so `leaves/` is purely pure-transform
  modules; seam-bearing modules that DO carry real logic (`hub`, `draw`,
  `render-queue`) stay leaves. (`781552a`.)
- **Dispatch-loop relocation.** The Component fan-out + post-dispatch
  finalizer moved from `panel/api.js` to `dispatch/fanout.js` — the
  runtime now lives in the dispatch layer, above the Components it drives.
  Every former panel→runtime call became an explicit injected dispatch
  host (effect handlers, subscriptions, nav-state writers, command
  run-closures, viewer write-helpers). Result: `panel → dispatch` import
  edges = 0. `panel/api.js` is now a pure component-framework surface
  (registry + reads + view contributions).
- **App-SCC extraction (F3).** The root reducer + cleanup relocated from
  `app/runtime.js` to `dispatch/`; `app/runtime.js` is now a thin
  back-compat re-export.
- **TEA re-audit (F1–F5).** The viewer (`y`/`$`), docker, files, and
  history reducer arms are now pure — model facts are threaded through the
  Msg payload (the `augmentMsg` pattern) instead of read via `getModel()`
  inside a reducer. The focus-routing half of blessed-exception A was
  eliminated (route topology is stamped onto the Msg by the handler).
- **`layout.update` no longer reads route topology.** layout was the last
  Component reaching into the global instance/route registry from its
  reducer (`instanceKind`/`isViewerKind`/`resolveTarget`/
  `resolveViewerPaneId`). It now classifies the focused pane from its own
  `slice.arrange` (a new pure `leaves/pool.paneTypeIn`) and reads
  handler-stamped `viewerPaneId`/`viewerTarget` off the Msg. Every
  Component `update` is now pure of route topology. (`70497b8`.)
- **Static-layering pass (§1).** Extracted `model/store.js`; split the
  `app/state` read helpers into `panel/nav-state.js`; re-homed the io
  sinks (`app/exec`, `dispatch/{event,diag}-log`) into `io/`; memoized
  `resolveTarget` / `resolveViewerPaneId` on the per-Msg finalizer path.
- **`leaves/` became the pure-bottom layer.** `io/ansi.js` (pure
  color/escape string transforms) moved to `leaves/ansi.js`, and the two
  latent `leaves → io` edges were severed via injected seams
  (`hub.setRecorder` wired from `io/event-log`; `draw.setWriter` wired from
  paint, with the `io/term` dims fallback moving into the `panel/api` dims
  provider). `leaves/` now imports only sibling leaves, and `io/` can depend
  down on it without a cycle. (`a569ebf`.)
- **`dispatch/` regrouped into `update/` + `runtime/` + `control/` tiers.**
  13 files re-homed by role (reducer vs effect-runtime vs input/control);
  layer-invisible — `dep-walker` keys on the first path segment, so the
  subdirs collapse to `dispatch` and SCCs / cross-layer edges are unchanged.
  (`a569ebf`.)
- **The viewer owns its `/` key.** `viewer.update` claims `/` (enter search)
  itself instead of `dispatch.js` focus-checking and dispatching
  `viewer_search_enter` — the behavior moved into the Component that owns it.
  (`a569ebf`.)

### Fixed

- **Embedded-PTY exit while in terminal mode was silently dropped.** The
  `terminal_exit` Msg was routed through the Component fan-out, which
  drops unwrapped root Msgs (it was error-logged and only cleared on the
  next keystroke). It now goes through the root reducer, consistently with
  every other `terminal_exit` site. (`1a5c018`.)
- **Hidden (pool-only) panes resolved the wrong Component kind.**
  `route.instanceKind` now resolves pool-only / hidden panes instead of
  only placed ones. (v0.6.5 §5(b3); `f465ef8`.)

## [0.6.4] — 2026-06-15

### Added
- **Mouse actions + a unified input intent layer.** Keyboard and mouse
  now converge on one semantic vocabulary (focus / select / activate /
  context / scroll) before reaching a reducer (`dispatch/intent.js`).
  On top of it: **double-click activates** (Enter-equivalent, ~250 ms
  same-cell window), **right-click opens a context menu at the
  cursor**, middle-click is reserved (wired end-to-end as a no-op
  gesture), and the wheel keeps scrolling the pane under the cursor.
  All three button gestures are remappable via a top-level YAML
  `mouse:` block (`double-click` / `right-click` / `middle-click` →
  `activate` / `context` / `noop`, plus `double-click-ms`).
- **Context menu.** Right-click anywhere: on a copyable target the
  menu offers Copy line/item and Copy selection (both land in the yank
  register + system clipboard); a general section (Refresh / Help) is
  always present. Click-outside dismisses; the keyboard `x` command
  menu gained the same click/dismiss behavior. Mouse drag-selections
  now PERSIST like a keyboard `v` visual selection (extend with
  `j`/`k`/`h`/`l`, yank with `y`, Esc clears). Extensible via a
  top-level YAML `context-menu:` block — keys-style verb surface
  (`builtin:` / `action:` / `command:`) plus an optional `pane:` gate.
- **Multiple viewers.** A layout may now declare several detail
  (viewer) panes — the parser's exactly-one / last-column / last-pane
  policy is relaxed to "at least one, each the sole tab of its pane".
  Viewers self-identify by paneId: independent tabs, scroll, content
  routing; free-config drags them like any pane (two viewers swap for
  real); hide/remove refuses only the LAST viewer. Content targets the
  major viewer (the focused one, sticky `lastViewerTab`). Ships with
  `demo/dual-viewer/`.
- **Unified pane menu (`[≡]`).** One dropdown on every pane (panes +
  this pane's tabs, tabs only when there are several), replacing the
  separate pane-select and tab-list overlays. The pick is
  projection-aware: normal view swaps pool entries, half view places
  the pick into the clicked slot, full view switches focus.
- **Half view is a projection.** Half/full are runtime focus-state
  fine-tuning over the declared layout, never serialized. The two
  half-view slots are an ephemeral, API-settable selection
  (`view_place_pane`) defaulting to the historical focused-pane +
  major-viewer derivation; either slot may hold any pane, so two
  viewers can sit side-by-side.
- **Per-pane detail height.** Each detail pane takes its own
  `height: N%` in YAML; the old layout-wide scalar remains as the
  default/fallback. Round-trips through free-config save.
- **Config-status view toggles.** The three internal tabs became two
  orthogonal toggles — `t` flips tree↔flat layout, `s` flips
  all↔tracked scope — exposing all four combinations (the old linear
  cycle couldn't express all·flat). `]`/`[` fall through to the
  framework pane/tab cycle again.
- **Diagnostics window (`<leader> e`).** A browsable log of the
  warnings and errors raised during a session — opened with the leader
  chord `e`, navigated like the register / Running overlays
  (`j`/`k`/`g`/`G`, `Esc` to close). `y` copies the highlighted entry
  (`[level] code: message`) to the yank register + system clipboard;
  `c` clears the buffer; `s` saves it to `lazytui-diagnostics.json` for
  a bug report. Backed by a dedicated
  in-memory ring buffer (`dispatch/diag-log.js`) kept separate from the
  event-log replay firehose, so a diagnostic isn't evicted by key/mouse
  noise before you can read it. Producers today: boot config warnings,
  ambiguous same-kind slice reads (a `pane-collapse` warning when a
  kind-name read would silently collapse two same-kind panes onto the
  primary — the multi-instance footgun guard), and every runtime error
  funneled through the effects-layer error sink. Other call sites adopt
  `diag.warn()` / `diag.error()` opportunistically.

### Changed
- **The `groupActions` Component contract is now always-enforced, with an
  opt-in memoized fast path.** `groupActions(group, name, config, model)`
  must be a pure projection (no mutation/IO); the framework now wraps its
  args in a read-only Proxy and times every call **in production** (the old
  `LAZYTUI_STRICT_PLUGINS` dev-only gate is retired) — a mutation or a slow
  (IO-ish) call is surfaced to the diagnostics window (`leader e`) without
  corrupting state or hard-failing. A Component sets `groupActionsMemo: true`
  to declare its hook a pure function of `group`: it is then run once per
  group (still guarded) and cached, so a pure Component pays the guard cost
  once while a non-memoized one pays it per call. See
  `docs/PLUGINS.md` §"The groupActions contract". (Completes the
  blessed-exception elimination arc — the eliminable set is now empty.)

- **`slice.lines` and `slice.search.matches` are deleted — viewer
  content and search matches are now derived, not stored** (the
  viewer-lines selector arc, `docs/viewer-lines-selector.md`). Info-tab
  content gets a canonical home (`slice.infoLines`, written by
  `viewer_show_info` from dispatcher-computed `msg.lines`); displayed
  lines derive from the active tab's per-id home via
  `pane-tabs.viewerLines`; search matches derive via the
  `ms.matchesFor(lines, term)` memo, so they can never go stale against
  content — the finalizer transition-detect and recompute machinery is
  deleted with them. The per-Msg plugin `getItems`/`getInfo` call is
  gone from the viewer finalizer (bench: parity-or-better, +19% on
  append-from-empty). Two warts die structurally: committed-search
  highlights lost on ref-equal Info refreshes, and the closed-content-
  tab stale-repaint guard.

- **The auto-generated docker `Logs` action pipes through a pager.**
  The spawned window (tmux window, or embedded PTY tab outside tmux)
  now runs `… logs -f | less --mouse -R +F` — follow like tail, wheel
  to scroll back, `F` resumes the follow, `q` quits. Falls back to
  `less -R +F` on older less and to the previous raw follow when less
  is absent.

### Architecture
- **Multi-instance spine.** Two same-kind panes are now genuinely
  independent. Arc 1: the read path resolves per-pane slices
  (`route.sliceForPane`) — cursor / scroll / filter / multi-select /
  items / focus styling keyed by paneId across all navigators. Arc 2:
  `files` mints one instance per pane (`init(paneId)` self-identity;
  per-panelType maps gone; refresh / effects address the originating
  pane). Arc 3: docker's host-global status/stats + events stream run
  on ONE content-owner instance; placed panes carry nav only — two
  docker panes drive exactly one fetch loop.
- **WM geometry refactor.** Layout math is pure and re-homed:
  `calcLayout` / `boundsFor` / `getPanelViewportH` take an explicit
  `(layoutSlice, dims)`, the `render/geometry.js` facade is deleted
  (importers route math vs paint directly), and the math lives in
  `leaves/geometry.js`. Logical require-cycles through the geometry
  math: 1535 → 0.
- **Resize is a Msg; render dispatches nothing.** Terminal dimensions
  live in the model (`layout.dims`), written only by the new
  `term_resized` arm; the stdout resize listener dispatches it.
  The keep-in-view scroll clamp moved from the render pass to a
  post-dispatch finalizer — every state change is a dispatch, resize
  included, so the safety net needs no Msg enumeration and a terminal
  shrink re-clamps before the repaint even fires. The render-side
  `set_scroll` exception in DATAFLOW.md is CLOSED; render is a pure
  Model → frame function (pinned by test).
- **Render restructure.** `render/layout.js` split along its one-way
  seam into geometry math + `render/paint.js`; footer extracted to
  `render/footer.js`; the triplicated chrome-glyph setup folded into
  `_chromeContext`.
- **paneBounds keyed by paneId only.** The legacy type-keyed dual
  write is retired; half/full visible bounds reach viewer-tab readers
  via the new `route.resolveViewerPaneId()` bridge.
- **Root-reducer purity.** The remaining root-reducer slice reads are
  threaded via Msg payload (escape / tab-cycle / menu_open);
  `jobs_activate` stays the one documented blessed exception. Chrome
  click suppression became a declarative `suppressChrome` column on
  the MODES table.

### Fixed
- **multiSel landed on the kind's primary, not the focused pane** —
  the four multi-select verbs now route by focused paneId (reachable
  on the dual-browser demo).
- **A bare viewer click yanked one character and trapped visual
  mode** — a no-drag click now cancels instead of settling a 1-char
  selection.
- **Tab-list `[≡]` was dead on any non-first viewer** — trigger
  hit-test, overlay rows, and nav clamps now resolve the clicked
  pane's own paneId.
- **Triple-click double-fired activate** — the classifier resets its
  click memory after emitting a double.
- **Opening a second file on a focused second viewer loaded forever**
  — a hardcoded `'detail'` in the tab-Msg context stole focus back to
  the primary viewer; it now threads the pane's own identity.
- **Half/full view lost the focus border** after the per-pane focus
  migration — `renderHalf`/`renderFull` thread `opts.focused` again.
- **One-frame resize clamp lag** — the scroll clamp judged against the
  previous frame's pane heights; after a terminal shrink the selected
  row could sit off-screen until the next render. Clamps immediately
  now (subsumed by the resize-as-Msg redesign above).
- **Plugin `tab: true` group actions were invisible** in panes whose
  merged-action projection dropped them (`getMergedActions` is now the
  single accessor).

### Performance
- **Hot-path require memoization sweep.** A bare lazy `require()` in a
  per-keystroke / per-dispatch path re-resolves the module path every
  call — ~35 µs of filesystem stats on slow-stat mounts (measured
  1000× the work it guards). Memoized module refs in pane-tabs
  (~130×), the nav read/write trio in `app/state`, and the render
  path. The post-dispatch finalizer memoizes its layout on
  `(arrange, dims, viewMode)` reference identity — correct because
  reducers update those immutably. Bench: every hot-path case within
  noise of the pre-arc baseline; single-dispatch latency slightly
  better than before the resize-as-Msg arc.

## [0.6.3] — 2026-06-10

### Architecture (deep arch arc, 2026-06-07)
- **Phase D — TEA completion.** 16 `getModel()` reads in
  `viewer.js` reducer arms + 5 in `groups.js` retired via Msg-
  payload threading (the `modelBundle` pattern — dispatcher reads
  model at dispatch time, threads facts via Msg). Boot-time direct
  root-model writes in `app/state.js` routed through `set_config`
  / `set_register` Msgs. Cross-slice `tabBounds` read in
  `panel/layout.js` + in-place render-time mutation in `viewer.js`
  retired. Dead `flatTabInfo` compute killed in the streaming hot
  path (D2 — was a 71µs/op per-append finding).
- **Phase B core — slice keying by paneId.** Component slice
  instances mint at PLACE time (per-pane in `initState`'s arrange
  walk) instead of register-time-by-kind; the `route` table now
  keys instances by `pane.paneId`, with `_primaryByKind` derived
  as a fallback for legacy kind-name lookups. `slice.focus`
  redefined as a paneId via `_withFocus(slice, focus)`
  normalization. New `mpane.paneMatchesFocus(p, focus)`
  transitional comparator (paneId-first, type/id fallback)
  supports pre-migration callers during the unwind.
- **Phase A1 — vocabulary rename.** Slice field
  `panelBounds → paneBounds` (98 substitutions across 23 files).
  v0.6.1 introduced the pane abstraction; this catches up the
  field name.
- **Phase C1 — mouse-routing registry.** Inline modal mouse
  blocks in `handleMouse` (`tabListMode`, `paneSelectMode`,
  `freeConfigMode` — ~200 LOC of straight-line branches) lifted
  into a `_modeMouseHandlers` registry mirroring the keyboard
  `_modeHandlers` shape. `_dispatchActiveModeMouse` walks an
  explicit precedence array with wedge-guard (`mode_clear` on
  throw, same as keyboard). `handleMouse` 440 → 244 lines. Each
  handler owns its `render()` call so consume-no-render perf
  optimizations (P5.10 motion-without-drag, panel-list no-op
  click) preserve their pre-refactor semantics.

Spec for the arch arc + the deferred Phase B2 / A2 / C2 +
Track-3 hygiene items: [docs/v0.6.3-arch.md](docs/v0.6.3-arch.md).

### Fixed (Round-6 post-arch-arc adversarial review)
- **Wheel-over-focused-pane downgrade.** Post-B3 `getFocus()` returns
  a paneId; the wheel handler still compared `p.type === getFocus()`,
  which never matched → wheel on the focused pane silently fell
  through to side-panel behavior (no auto-yank-or-refresh, no detail
  update). Now uses `mpane.paneMatchesFocus`.
- **Help overlay focus loss.** Same root cause: help title showed
  `'TUI'` instead of the focused pane's title and list-mode
  keybindings (j/k/g/G/PgUp/PgDn) disappeared from the help body
  because `getPanelDef(getFocus())` keyed by panel-type returned
  null. Now resolves focus → pane → type via `route.instanceKind`.
- **Files panel lost focused highlight.** `getFocus() === panelType`
  in `_renderFor` never matched. Now compares via `route.instanceKind`.
- **`getPanelViewportH` half/full-view full-height bump broken.**
  `panelType === visiblePanel` never matched (panelType is type-form,
  visiblePanel is paneId) → focused half/full pane fell back to
  `boundsFor` for content height, breaking scroll math. Fixed via
  `instanceKind(visiblePanel) === panelType`.
- **Producer leaks writing type-form focus.** Four sites still wrote
  `panel.type` instead of paneId, masked downstream by the tolerant
  comparator but violating the B3 invariant: free-config mouseDown,
  `navSelect`, `set_arrange` + `free_config_enter` stale-focus
  fallbacks, and the `set_active_tab` `wasFocused` predicate. All
  fixed to write `paneId || type`.
- **`_resolvePaneIdForFocus` inactive multi-tab id resolution.**
  `pane.id` / `pane.type` mirror the ACTIVE tab; an inactive tab's
  pool id lives in `pane.tabs[].id` / `.poolId`. Added a tabs[] scan
  as the third fallback before returning unchanged so a pre-migration
  caller passing an inactive tab id no longer leaks it into focus.
- **C1 extra-render perf regressions.** Two pre-C1 `return;` paths
  intentionally skipped `render()`: panel-list overlay
  header/footer/essential row click (no-op) and free-config motion
  without an in-flight drag (P5.10 — continuous while cursor moves).
  The C1 dispatcher rendered on every truthy return, breaking those
  optimizations. Restored per-handler `render()` ownership so
  consume-no-render paths can `return true` without painting.
- **C1 precedence-order defense in depth.** `_dispatchActiveModeMouse`
  walked CHAIN_MODES which orders `freeConfigMode` first (idx 3),
  inverting the pre-C1 source order (tabList → paneSelect →
  freeConfig). Today the three modes are mutually exclusive by
  invariant so this is observationally moot — pinned an explicit
  `_MOUSE_MODE_PRECEDENCE` array so a future invariant relax
  doesn't silently flip behavior.

### Added
- **Pane-select dropdown.** Every non-detail panel now sports a
  `[≡]` glyph at its top-left. Click it and a centered overlay opens
  listing every pool entry tagged by status — `[here]` (current
  cell), `[in col N]` (placed elsewhere), `[hidden]` (in pool but
  unplaced). Pick one to swap which pool entry occupies that cell.
  Picking a placed entry SWAPs the two slots; picking a hidden
  entry REPLACEs (the displaced occupant becomes hidden). Navigate
  with `j`/`k` / arrows / `g`/`G` / `PgUp`/`PgDn`, pick with Enter,
  dismiss with Esc; mouse wheel scrolls the cursor, click on a row
  picks, click outside closes. Invariants (detail can't be picked;
  actions can't end up outside the last column; detail / actions
  slots can't be replaced) are enforced at pick time. Detail's
  `[≡]` still opens the tab-list overlay (unchanged).

### Changed
- **Render engine — Layout as value + single Frame struct.**
  `model/layout.js` now returns a `Layout {rects, availH, viewMode,
  …}` value; non-leaf readers route through `boundsFor(paneId)`.
  Six render-side module-locals collapse into a single `Frame`
  struct sharing one cache invalidation surface. `paintColumns`
  retires in favor of a rect-list painter (`render/painter.js` —
  `composeRows` / `composeRects` / `paintFrame`); rect-paint and
  legacy paths shipped behind a feature gate, golden-tested for
  ANSI parity, then the old path deleted. No user-visible change;
  internal cleanup that makes overlay layering tractable.

- **Module splits.** `render/panel-widgets.js` splits into
  `render/decor.js` (chrome helpers + hit-tests) and
  `panel/viewer/tab-strip.js` (`buildTabStrip`).
  `feature/register.js` folds three ways — pure helpers to
  `leaves/register.js`, production callers inlined, test wrappers
  to `js/test/_helpers/register.js`. `leaves/free-config.js`
  (1231 LOC) splits into `leaves/free-config-core.js` (358 — shared
  helpers + hotkeys), `leaves/free-config.js` (333 — keyboard
  transforms), `leaves/free-config-mouse.js` (632 — drag math).
  All 9 importers migrated; no re-export shim.

### Fixed
- **Committed search recomputes on a lines change.** When the
  displayed `lines` array changes (e.g. switching back to a tab
  whose action accumulated new output), the finalizer re-runs the
  committed search incrementally so navigation doesn't reference
  stale row offsets.

- **`:open <"quoted path">` strips only matched outer quote
  pairs.** Previously a single mismatched leading quote could
  consume the closing quote of an embedded string. The regex is
  now anchored to balanced outer quotes only.

- **Pane-select multi-tab preservation (pre-release fix).** A SWAP
  through pane-select now splices the existing pane object between
  slots, preserving `tabs[]` / `paneId` / `activeTabId` for
  multi-tab panes. The pre-fix shape re-minted via the pool entry
  and silently collapsed multi-tab panes to single-tab. In the
  same arc, non-active multi-tab tabs are excluded from the
  pane-select list (managed via tab-list on detail, not
  pane-select) — picking one previously routed through REPLACE
  and double-placed the id.

- **Pane-select overlay mouse routing.** The overlay now handles
  wheel scrolling (cursor nav), row clicks (`pool_swap_by_id`),
  and click-outside (close). Previously only Esc/Enter and the
  `[≡]` toggle path dismissed; clicks fell through to the
  panel-under-overlay handler.

- **Pane-select reducer polish.** Re-opening on the same target
  is a no-op (cursor / scroll preserved). `set_arrange` now emits
  `mode_clear` when it defensively clears `slice.paneSelect`,
  keeping the flag / slice pair consistent.

### Fixed (post-arch-arc tag-prep, 2026-06-08 → 10)

Adversarial smoke + code-review pass on top of the arch-arc closure
caught a class of paneId / panel-type comparator drift the audit
hadn't reached.

- **`[x]` tab close — hit-zone offset + stale content.** Two bugs
  in the postgres demo's file-tab flow: clicking `[x]` did nothing
  (hit-rect 3 cells left of the painted glyph because
  `buildTabStrip` didn't account for renderPanel's `[≡]` trigger
  injection between hotkey and title), and closing a tab left the
  file's content visible (the Info-fallback `viewerLines` re-served
  the closed tab's `slice.lines`; `removeContent` now clears
  `slice.lines` when the active tab was closed AND fallback is to
  Info).
- **Six paneId / panel-type comparator mismatches.** Post-Phase-B3
  `getFocus()` returns a paneId; six sites still compared against
  type literals (`=== 'detail'`, `=== 'containers'`, etc.) and
  silently disagreed. Sites: docker render (uses `instanceKind` for
  the panel-type compare), wheel-on-focused (uses
  `paneMatchesFocus`), files focus highlight, `getPanelViewportH`
  half/full-view bump, help-overlay title resolution,
  `_renderFor`'s focused-pane border. The audit-fix arc realigned
  all six and instance lookups (`instanceKind` now walks the
  arrange to resolve docker-style paneIds whose Component name
  differs from their panel-type).
- **`dispatchMsg` accepts paneId target.** `wrap(target, msg)` with
  a paneId in target no longer triggers "unknown Component" + chain
  break; the dispatcher resolves through `componentForPanel` /
  `route.resolveTarget`.
- **Boot default focus.** `set_arrange` no longer races with the
  initial focus seed; first-paint focus honors the `groups` default
  instead of falling through to the last-mounted pane.
- **Framework API helpers accept paneId.** `getFilter`, `getItems`,
  `getPanelDef` consume paneId-form input via `route.paneTypeOf`;
  pre-fix, paneId input silently returned the panel's default for
  multi-panel Components (`files` / `file-browser`).
- **Strict T3.5 paneId migration + audit.** `panel/layout.js`,
  `panel/viewer/viewer.js`, and `app/state.js` lookups that survived
  Phase B / C / D switched from kind-name singleton convention to
  paneId-keyed instance store. A systematic 3-agent audit found 6
  more sibling paneId / type comparator drifts (docker / files /
  actions / runtime / api / commands) and fixed them in one batch.
- **Multisel + filter wrapped Msgs route to the right nav entry.**
  `dispatch.js` `toggleMultiSelOnFocused` (Space-toggle row in
  list-select), `selectAllVisible` (`*` shortcut), and
  `_enterFilterMode` (`/`-filter) wrapped Msgs to the Component
  with `panel: getFocus()` (paneId). The files Component is
  multi-panel — `nav.apply`'s entry lookup indexes `slice.nav` by
  panel-type, so paneId input silently dropped. All three call
  sites now translate via `route.paneTypeOf` (mirrors the existing
  pattern in `runtime.js` arms 285 / 308 / 366).
- **`[/]` cycle on groups panel threads `_groupsCtx`.** The chord
  dispatched `toggle_groups_tab` with no `ctx` payload; the post-D1
  contract requires every dispatcher to thread the `groupsBundle`
  so the reducer arm stays pure of `getModel()`. Without the
  bundle, `recomputeList` iterated an empty groups map → cleared
  `slice.list` → cursor fell to idx 0 / `currentGroup` ''. Routes
  through the existing `state.switchGroupsTab()` which already
  threads `_groupsCtx()`.
- **Three-way resolver consolidation in `route.js`.** `componentForPanel`
  / `paneTypeOf` / `instanceKind` previously carried three
  independent copies of the arrange-walk arm — the same docker-
  style fallback got patched four times across separate commits.
  Extracted `_typeByArrangePaneId` as the shared walk; the three
  resolvers project from it. No semantic change; future fixes land
  in one place.
- **`getPanelDef` walks the arrange once, not twice.** Pre-fix called
  `componentForPanel` + `paneTypeOf` separately with the same
  paneId input — each can walk the arrange for docker-style paneIds.
  Now resolves panelType first via `paneTypeOf`, then looks up the
  Component by panel-type (hits the `_panelOwner` direct map).
  Affects every renderer + every dispatch chokepoint that asks for
  a panel def.
- **`renderFooter` resolves focus once per paint.** `focusKind`
  hoisted in `footerKeys` and `focus` + `focusDef` hoisted at the
  top of `renderFooter`; pre-fix called `instanceKind(getFocus())`
  3× + `getPanelDef(getFocus())` 2× per paint with identical
  arguments.

### Added (post-arch-arc tag-prep)
- **Pre-release smoke harness.** `js/test/smoke/` ships 5
  end-to-end scenarios (`routing.js` 26 tests, `lifecycle.js` 17,
  `hit-zones.js` 10, `action-tab.js` 16, `drag.js` 24) that drive
  the real `dispatch` / `render` path to catch the bug class the
  unit suite misses — paneId / type comparator drift, stale-content
  on close, `[x]` hit-zone offset, producer-survives-switch, drag
  via `dispatchMsg`. Aggregator at `js/scripts/run-smoke.js` mirrors
  `run-tests.js`; opt-in before tag (`node js/scripts/run-smoke.js`
  — ~530 ms total). Helper at `_helpers/smoke.js` (boot + capture +
  step + driver wrappers; `stripAnsi` handles CSI / OSC / alt-
  charset).

## [0.6.2] — 2026-06-06

### Changed (BREAKING)
- **YAML layout shape.** `layout.left:` / `layout.right:` blocks are
  replaced by an ordered `layout.columns:` list. v0.6.1 configs do
  not parse — the SchemaError points at
  [`docs/v0.6.2-migrate.md`](docs/v0.6.2-migrate.md). One mechanical
  edit per config: wrap the two existing blocks in a `columns:` list
  and drop the `left:`/`right:` keys. Per-cell shape (bare pool-id,
  `tabs: [...]`, `height: 60%`, `heightPct`, `collapsed`, explicit
  `hotkey:`) is unchanged. Last column's `width:` is ignored (warns
  at parse — last column takes the remainder).

  ```yaml
  # v0.6.1 — no longer parses
  layout:
    left:  { width: 30, panels: [groups] }
    right: { panels: [detail] }

  # v0.6.2
  layout:
    columns:
      - { width: 30, panels: [groups] }
      - { panels: [detail] }
  ```

### Added
- **N-column layouts.** The hardcoded two-column shape retires.
  `arrange = { columns: [{width?, panels: [...]}], detailHeightPct,
  pool }` ordered left-to-right. The last column's width is implicit
  (takes the remainder); every other column carries an explicit
  `width:` in cells. Hotkey pool per column: first column gets
  `1`-`6`, last gets `7`-`9`, middle columns get no auto-pool (panes
  must specify hotkeys explicitly). Detail + actions panes still
  anchor to the LAST column by invariant; "must be in the right
  column" error strings now say "must be in the last column."

- **Drag-edge spawn.** In free-config mode, dragging a pane (or a
  pool entry from the `w` overlay) within 2 cells of the terminal's
  left edge or an internal column boundary spawns a fresh column at
  that position. The right edge is NOT hit-tested as a spawn zone —
  the rightmost cells fall through to the last column's in-column
  3-zone hit; `:add-column N_cols+1` mirrors the refusal at the
  cmdline (would push detail off the last column). Detail / actions
  sources are refused for all new-column drops (they're reserved to
  the last column). New column's width is stolen from the adjacent
  column(s); source columns that go empty are auto-removed.

- **`:add-column [N]` / `:remove-column <N>` cmdline verbs.** Insert
  an empty column at 1-based position `N` (default: just before the
  last column — internal position N-1); remove the column at 1-based
  index `N` (refused for the last column, for non-empty columns, and
  for out-of-range indices). Drag panes in afterwards.

- **Status notices.** `slice.freeConfig.notice` gains a sibling
  `noticeKind` field (`'info'` | `'error'`, defaults to `'error'`).
  The footer paints info notices green and error notices red. New
  column actions emit info notices on success; column-edit refusals
  emit error notices.

- **Running overlay (`<leader> j`).** Modal popup listing every live
  child lazytui spawned — streamed actions (routed + unrouted),
  ephemeral PTY sessions, `type:background` detached spawns, and
  tmux windows from `type:spawn` under `$TMUX`. Tracks
  `{kind, label, pid, owner, status, exitCode, startedAt, endedAt}`
  per job. Navigate with `j`/`k` / arrows, `g`/`G`, `PgUp`/`PgDn`;
  Enter jumps to the relevant tab (action tab for streams, terminal
  tab for PTYs, viewer info card for background/tmux); Esc or `J`
  closes. Backed by an out-of-TEA `feature/jobs` registry — same
  pattern as `feature/history` (slice-less producers report via
  `register` / `update` / `close`).

- **Action tab `●` running indicator.** Tab strip prefixes a yellow
  `●` to action tabs whose stream-routed job is alive in the
  current group. Glanceable hint without opening the overlay.

### Changed
- **Msg signatures.** `pool_show({column: 'left'|'right'})` →
  `pool_show({columnIndex: int})`. Drag target shape `{kind, column,
  index, …}` → `{kind, columnIndex, index, …}`.
  `free_config_move_col({col: 'left'|'right'})` →
  `free_config_move_col({dir: -1|+1})`. New Msgs:
  `pool_show_new_column({id, position})`,
  `add_column({position})`, `remove_column({columnIndex})`.

- **`pane.column: 'left'|'right'` → `pane.columnIndex: int`.** Every
  pane carries its column index as an integer. The legacy string
  form is gone.

- **Hit-test edge naming.** `'resizing-left-boundary'` and
  `'resizing-right-boundary'` fold into `'resizing-panel-boundary'`
  carrying `columnIndex` and (when on a column boundary)
  `boundaryIndex`. Corner-resize at the column separator now checks
  both flanking columns for a panel boundary at `my` instead of just
  the cursor's column.

### Fixed
- **Action tab activation is view-only.** Clicking an action tab no
  longer auto-runs the command. The Enter gesture on a focused
  detail panel sitting on an action tab now runs the action (same
  path as actions-panel Enter — `args:` / `confirm:` still apply).
  Empty action tabs paint a `[press Enter to run]` placeholder.

- **Per-action-tab output buffer (`slice.actionTabBuffers`).** Each
  tabbed action streams into
  `actionTabBuffers[groupName][actionKey] = { lines }`. Switching
  away no longer kills the producer; the buffer keeps growing in
  the background and `tab_switch` back restores `slice.lines` from
  it with scroll pinned to the live tail (bottom-stick keeps
  tracking subsequent appends). Singleton-stream invariant
  preserved — a new run via Enter or `:run` still preempts the
  previous one, stamping `Killed by next run.` +
  `Press Enter to run again.` into the preempted buffer.

- **Routed `stream_start` / `viewer_append`.** Both Msgs accept
  optional `{tabKey, groupName}`. With them set: write the buffer
  unconditionally, mirror to `slice.lines` only when the active
  tab is that action's. With them unset: legacy `slice.lines`
  write (preserved for ad-hoc verbs — docker logs/inspect, etc.).
  `stream_start`'s routed path auto-jumps `slice.tab` to the
  action's index AND emits `terminal_exit` so `terminalMode` doesn't
  leak across the jump.

- **`Press Enter to run again.` footer.** A finished or
  killed-by-preempt routed stream appends the affordance text into
  its buffer, so a stale tab doesn't look like a frozen log.

- **`kill_proc` Cmd retired.** No emitter left after Phase 3 — the
  preempt path inside `streamCommand` handles its own kill;
  `tab_switch` no longer fires it. Effect registration removed.

- **`isUnroutedStreaming()`** replaces `isStreaming()` for the
  `viewer_show_info` gate — Info-pane refresh under a routed
  (tabbed) stream is now safe (routed streams don't write to
  `slice.lines`).

- **`config-branch` check-stale surfaces per-file diff.** The
  generated script ran `diff -qr` to detect changes but redirected
  the per-file output to `/dev/null`, leaving consumers with a bare
  `DIFF: conf` label and no way to tell which file under `conf/`
  had changed. The output is now captured and emitted indented
  beneath each path label (`  Only in conf: ca.passthrough`,
  `  Files .../serial and .../serial differ`, …). Registry-path
  grouping is preserved; the `STALE=1` / `exit "$STALE"` contract
  is unchanged.

- **Mouse paths join the auto-yank — keyboard / mouse parity.**
  Pre-fix, the auto-yank from `30e24ec` only fired on keyboard j/k
  because non-`groups` mouse handlers in `input.js` bypassed
  `navSelect` (used `setSel` directly + a manual
  `showSelectedInfo()` follow-up). Mouse-scrolling or clicking the
  actions panel while parked on Transcript scrolled the cursor but
  left the viewer stuck. Now: click on any list panel routes
  through `navSelect`; wheel on the focused list panel does too
  (unfocused wheel still uses `setSel`/`selectGroup` to preserve
  the "side-panel wheel doesn't clobber detail" rule). The
  trailing `showSelectedInfo()` in the click handler is dropped —
  `navSelect` dispatches it.

- **Nav cursor auto-yanks viewer back to Info from a non-Info tab.**
  When the detail panel is parked on Transcript (or an action tab,
  terminal, content tab) and the user moves the cursor in a list
  panel (`j`/`k` in actions / groups / files / containers), the
  viewer now auto-switches back to Info so the selection-info
  actually appears. Pre-fix: `viewer_show_info` bailed when off-Info,
  so navigation cursor moves silently dropped on the floor and the
  user kept staring at last command's transcript with no way to
  refresh Info except a manual `tab_switch`. Scoped to `navSelect`
  in `dispatch.js`, NOT folded into `showSelectedInfo` — the
  focus-set cascade after `addContentTab` also fires
  `show_selected_info`, and that path MUST stay on the freshly-
  opened content tab (yanking it back to Info would defeat the
  open).

- **Docker auto-`status` drops `tab: true`.** The docker plugin's
  auto-generated `status` action (`docker compose ps`) carried
  `tab: true`, making it the only auto-action with a dedicated tab
  (asymmetric with `up`/`down`/`build`/`restart`/`logs`). Pre-
  Transcript that flag was the only way to make output "stick";
  post-Transcript the one-shot snapshot fits the catch-all
  accumulator. Output now flows into the Transcript tab like other
  ad-hoc one-shots. `tab: true` stays available for YAML actions
  whose output is substantial (long streams, multi-action
  concurrency, diffable across runs).

- **Transcript tab + unbundle Info's double-booking.** Pre-fix Info
  hosted two semantically different things on one display surface:
  selection info (cursor-driven; refreshes as you navigate
  actions/groups/files) and the unrouted transcript (accumulates as
  you run `type:run` streams + spawn-status + cmdline outcomes).
  The shared surface bred a tower of guards in `viewer_show_info`
  + a "restore from buffer" branch in `tab_switch idx=0` + a
  divergent `slice.lines` mirror in `viewer_append`. Each new
  producer (v0.6.2 spawn-status accumulator, etc.) added another
  edge case. User-reported symptom: after running one command, j/k
  in actions stopped updating Info — the transcript had won and
  wouldn't yield. **Fix** — separate the surfaces. A new
  **Transcript** tab (placed at idx 1, right after Info) now owns
  the unrouted accumulator (`slice.viewerStreamBuffer`). The two
  global tabs sit adjacent so Transcript stays next to Info no
  matter how long the per-group strip grows. Info is pure
  selection-info; its reducer arm is 5 lines, no guards. Unrouted
  `stream_start` / `viewer_append` / `viewer_append_lines` mirror
  to `slice.lines` only when on Transcript; `tab_switch idx=0`
  just clears + dispatches `viewer_show_info`; `tab_switch idx=1`
  (Transcript) restores from buffer with bottom-pin scroll (empty
  buffer → `(no transcript yet)` placeholder). `appendViewerLines`
  (the spawn/cmdline status helper) lands in the same buffer,
  reachable via the Transcript tab. **Tab strip layout:**
  `[Info] [Transcript] [actionTabs...] [termTabs...] [contentTabs...]`
  — per-group tabs shift +1 (action tabs now start at idx 2).

- **Plugin-synthesized tab:true actions are visible to the tab
  system.** The detail tab strip, the leader-shadow check, and
  group-info hover all read `group.actions` directly; plugin
  Components contributed via `groupActions` but the tab system
  never saw them. Symptom in postgres demo: `pg:status` (docker
  auto-action with `tab: true`) ran when invoked from the actions
  panel, but its routed `viewer_append` output landed in
  `slice.actionTabBuffers.pg.status` with no corresponding tab in
  the strip — operator saw nothing. v0.6.1 and earlier hid this
  because every stream wrote to `slice.lines` (Info); routed
  buffers in v0.6.2 surfaced it. **Fix** — single canonical
  accessor `panel/api.getMergedActions(groupName)` returns a fresh
  `{ ...plugin-synth, ...YAML }` object on every call; seven
  readers (tab strip, `actionTabCount`, actions panel, leader
  resolver, shadow check, group-info display, CLI `--list` /
  `--exec`) now route through it. The pre-existing
  `applyPluginGroupActions` config-mutation trick is retired —
  TEA-correct, `model.config` stays immutable. Plugin contract
  extended to `groupActions(group, name, config, model)` —
  backward compatible (existing plugins ignore unused args).
  Plugins MUST be pure projections (no IO, no mutation) since
  `getMergedActions` is called transitively on hot read paths
  (`viewer_append` per output line).

### Migration

Hand-conversion per [`docs/v0.6.2-migrate.md`](docs/v0.6.2-migrate.md);
the parser's SchemaError points at the same file.

## [0.6.1] — 2026-06-02

### Changed (BREAKING)
- **YAML layout cell schema.** Layout cells are now bare pool-id
  strings (single-tab pane shorthand) or `{tabs: [pool-id, ...]}`
  mappings; the v0.6.0 inline `{type: ...}` form is rejected at parse
  time. Every pool entry must be declared under the top-level
  `panels:` block before a `layout:` cell can reference it. Hand-
  migrate per [`docs/v0.6.1-migrate.md`](docs/v0.6.1-migrate.md) — the
  parser's SchemaError points at the same file. No silent rewrite.

  ```yaml
  # v0.6.0 — no longer parses
  layout:
    right:
      panels:
        - type: detail
          title: Detail
          height: 60%

  # v0.6.1
  panels:
    detail: { type: detail, title: Detail }
  layout:
    right:
      panels:
        - { tabs: [detail], height: 60% }
  ```

### Added
- **Panes as containers, tabs as content.** Every cell in the grid is
  a **pane** (placement slot) holding 1+ **tabs** (panel-kind
  instances). The singleton-detail assumption that threaded through
  v0.5/v0.6 retires: every pane can host any tab kind, the slice
  store keys by tab id (instance) instead of by Component name, and
  `getFocus()` returns a tab id rather than a panel-type string.
  Detail is just another tab kind — same pool/cell mechanics, same
  drag/hide/show verbs.

  Configs that look exactly like v0.6.0 (one tab per pane, detail in
  the right column's last pane) migrate to v0.6.1 in two mechanical
  steps: split each inline cell into a pool entry + a bare-string
  cell reference; lift `height: N%` onto the cell as
  `{ tabs: [detail], height: N% }`. See the migration guide.

- **Instance-keyed slice registry.** A new `route._instances` map
  keys panel state by tab id (`getInstanceSlice(tabId)`); the prior
  Component-name-keyed shim retired in Phase 8. Producer-side viewer
  writes route through a single `resolveTarget('viewer')` chokepoint
  (`leaves/route.js`) — focused viewer-kind → `lastViewerTab` →
  first viewer-kind in `rightPanels` → any viewer-kind → null. v0.7
  workflow features extend this seam; no role / channel metadata
  shipped in v0.6.1.

- **Multi-tab panes via YAML.** A `{tabs: [docker, logs]}` cell mounts
  two tabs in one pane; `activeTab` picks the boot-active tab (defaults
  to `tabs[0]`). Switch the active tab at runtime via the new
  `:switch-tab <pool-id>` cmdline verb (autocomplete restricts to the
  focused pane's other tabs). Keyboard / mouse UX deferred to v0.7 (see
  `docs/v0.6.1-panes-tabs.md` §Decisions #4). Layout cells reject
  duplicate kinds inside a pane.

- **`:switch-tab <pool-id>` cmdline verb.** Direct active-tab flip for
  the focused pane. No-op on single-tab panes.

### Changed
- **Serializer always writes both blocks.** `:save-layout` always
  emits the `panels:` pool block and the `layout:` block in v0.6.1
  shape — the v0.6.0 "keep the legacy inline form when nothing
  requires the pool block" gate is gone. Idempotent: parse → save →
  parse → save produces identical bytes.

- **`setDetail` retires in favor of `setViewerContent(tabId, text)`.**
  Producer-side writers (action runner, commands, history, config-
  status, help-text, file-loader) call `state.setViewerContent(null, text)`
  to write to whatever viewer `resolveTarget` selects. The dead
  `'setDetail'` effect handler in `dispatch/effects.js` retires.

- **`getFocus()` returns a tab id, not a panel-type string.** For
  singleton-instance kinds (today's default configs) the tab id
  coincides with the Component name, so existing comparison sites
  like `getFocus() === 'detail'` keep working byte-for-byte. Kind-
  intent comparisons should go through `instanceKind(getFocus()) ===
  '<kind>'` (resilient to multi-instance, where tab id ≠ kind).
  External Components reading `slice.focus` directly should audit.

- **Navigator slice shape — `slice.nav` collapses to a single entry
  for single-panel navigators.** v0.6 had `slice.nav[panelType] =
  entry`; v0.6.1 single-panel Components (groups, docker, actions,
  config-status, history) store the entry directly at `slice.nav`.
  The files Component, which owns multiple panel types, keeps the
  `slice.nav[panelType]` shape. Shape is detected by `'cursor' in
  slice.nav`. External plugins reading nav state need a one-line
  branch.

- **Pane shape on arrange entries.** `arrange.leftPanels[i]` and
  `arrange.rightPanels[i]` now carry `paneId` (slot identity),
  `tabs: [{id, poolId}]`, and `activeTabId` alongside the legacy
  `id/type/title/config` fields. Anyone scripting against
  `:save-layout` output sees these additional keys. Legacy fields
  mirror the active tab's pool entry and stay populated through
  v0.6.1 for compat; Phase 10+ retire them.

### Migrated
- **Live demos and test fixtures.** `test/test.yml`,
  `demo/postgres/tui.yml`, and `demo/cloudberrydb/tui.yml` ship in
  v0.6.1 form. The PGDATA `files` panel in postgres keeps id `files`
  with title `PGDATA` — id is the round-trip key, title is the UI
  label.

## [0.6.0] — 2026-06-01

### Added
- **Free-config mode + panel pool.** The v0.5 design mode evolves
  into "free-config mode" — a layout editor with a configurable
  trigger and an explicit save command. The new top-level `panels:`
  block declares a POOL of panel definitions; the `layout:` block
  picks a subset of those by id. Pool entries that aren't placed in
  the grid are *hidden* — still configured, surfaced in the panel-
  list overlay so users can summon them back. More panels available
  under the hood than the grid shows at once.

  ```yaml
  panels:                 # the pool
    docker: { type: docker }
    logs:   { type: tail, file: /var/log/syslog }
    notes:  { type: viewer, title: Notes }   # hidden by default
    actions: { type: actions }
    detail:  { type: detail }

  layout:                 # the grid (id-refs into the pool)
    left:  { panels: [docker, logs] }
    right:
      panels:
        - actions
        - { id: detail, height: 60% }
  ```

  Legacy configs with inline `{ type: ... }` cells continue to parse
  and round-trip unchanged — the pool synthesizes implicitly at load
  time, and `:save-layout` only writes the new `panels:` block when
  the legacy inline form can't express the state (hidden entries OR
  a user-declared pool).

- **Panel-list overlay.** A modal popup inside free-config (open by
  pressing `w`, or automatically when the pool has hidden entries on
  mode entry). Shows every pool entry with its status — placed /
  essential (detail) / hidden — and lets the user toggle membership
  in the grid:

  - **Keyboard**: arrow keys nav, `Enter` to context-pick (placed →
    hide; hidden → show + place; detail no-op).
  - **Mouse**: drag a list item onto the grid. Drop on a cell →
    REPLACE (occupant returns to the pool). Drop in a column area
    (between or below cells) → APPEND to that column. Drop outside
    the layout → cancel.

- **`:hide <id>` / `:show <id>` cmdline verbs.** Direct pool↔grid
  mutation from the command line; same Msgs the overlay drives.
  Detail refuses to hide (the layout invariant requires exactly one);
  pool_show refuses to place a second detail / actions panel or
  exceed column caps. Autocomplete restricts to valid ids.

- **`:free-config` cmdline verb.** Opens the layout editor. `:design`
  remains as a v0.5 alias for muscle memory. The boot-time `--design`
  CLI flag now auto-enters free-config after the first paint instead
  of gating cmdline visibility — the mode is always available.

### Changed
- **Mode flag renamed.** `model.modes.designMode` → `freeConfigMode`
  throughout (26 references across 13 files). Mechanical rename;
  behavior under the old flag preserved. External plugins reading
  the flag name need a one-line update.

- **Freeze gate during free-config mode.** While the mode is active,
  the dispatch layer drops broadcast Msgs (refresh / hub / action)
  and wrapped Msgs targeting non-`layout` components. Components
  render their last snapshot until the user exits, so the canvas
  stays stable under drag / resize / pool mutations — matches the
  tmux prefix-mode mental model. Mode entry/exit ride the root
  reducer, not the gated dispatch path, so the mode itself always
  transitions cleanly.

- **`:save-layout` writes the `panels:` block when needed.** Legacy
  configs (every entry synthesized AND placed) continue to write the
  v0.5 inline form, byte-for-byte where possible. Configs with
  hidden entries or a user-declared pool write both blocks; layout
  cells become id-refs. Round-trip is idempotent — parse → save →
  parse → save produces the same bytes.

- **Chrome glyphs on every panel.** Top-border row now hosts up to four
  small interactive icons, theme-coloured (Mac traffic-light convention):

  - `[X]` red — quick-hide. Free-config only. Click → `pool_hide` for
    that panel (occupant goes to the pool; layout stays open).
  - `[_]` yellow — collapse. Always visible. Click → `panel_collapse_toggle`.
  - `[+]` green — expand a collapsed panel back to full height. Same
    click semantics as `[_]`, just the glyph differs by state.
  - `[≡]` theme accent — tab-list trigger, painted at detail's top-left
    only. Click → opens the centered tab switcher (see below).

  Glyphs are baked into the panel's top-border markup so they ride into
  the same `paintColumns` write as the row's content — no second
  cursor-move-and-overpaint pass. Pre-fix the glyphs visibly flickered
  as `─` on every detail-scroll frame (paint-on-top happened after
  paintColumns wrote the row). Glyphs are suppressed during any drag
  (the drag affordance owns the screen) and during overlay-owning
  modes (cmdline, menu, confirm, prompt, register popup, etc.).

- **Tab-list overlay.** The `[≡]` glyph at detail's top-left opens a
  centered popup listing every tab in the detail panel — Info,
  action tabs, terminal tabs, content tabs. Cursor navigates,
  `Enter` switches to the selected tab, `Esc` / click-outside / re-click
  the trigger close. Working state lives on `slice.tabList`
  (`{open, cursor, scroll}`); the trigger renders open-state via
  `[reverse]` when `tabListMode` is on. Available in every view
  mode (normal, half, full).

- **`(o)[≡]` layout on detail.** The trigger glyph sits adjacent to the
  hotkey — `╭─(o)[≡]─Detail─…─╮` — preserving both the keyboard
  reference and the mouse affordance. Earlier in v0.6 the trigger
  replaced `(o)`; now both are visible side-by-side. The trigger paints
  in normal, half, and full view (was normal-only).

- **Tab reorder via mouse drag.** Inside free-config, drag a content
  tab in detail's tab bar to a new slot. Live reorder — the tab bar
  re-renders in the new order as the cursor crosses each slot
  boundary, no commit-on-release single jump. Pure leaf at
  `leaves/tab-drag.js`; the Msg `viewer_reorder_content_tab` is the
  one allowed non-`layout`-wrapped dispatch through the free-config
  freeze gate.

- **Click-to-close `[x]` on content tabs.** Each content tab in detail's
  tab bar carries a tiny `[x]` close hint. Click it to drop the tab
  (independent of free-config). Tab-bar hit-test machinery lives on
  `panelBounds.detail.tabs` (view-output cache).

- **`:open <path>` cmdline verb.** Open any file as a content tab in
  detail. TAB-completion via a pluggable scheme registry
  (`feature/open-target.js`):

  - **Host paths** — relative or absolute. Catch-all scheme; matches
    anything without a `<word>://` prefix.
  - **`docker://<container>/<path>`** — read a file out of a running
    container via `docker exec`. Container-name completion (sync
    probe on first use, throttled async refresh after) plus
    path-in-container completion (cached per directory).

  Future schemes (ssh, s3) plug in via the same `match` / `complete` /
  `open` contract.

- **Cmdline live preview.** Cmdline entries can opt into a live preview
  via `preview: () => teardownFn`. The framework calls `preview()` on
  every selection change (typing-narrowed matches or arrow-nav),
  stashes the teardown, and runs it on the next selection change OR on
  cancel. `:theme <name>` uses this — themes switch as the user
  navigates matches; Esc reverts; Enter commits.

- **Collapse-toggle widget on every non-detail panel.** Click `[_]` /
  `[+]` to collapse / expand any non-detail panel, available in both
  normal and free-config modes. The `collapsed` flag round-trips
  through `:save-layout` (real layout state, not session-only).

- **Live drag preview.** During pool drag or in-grid drag with a
  valid target, `slice.arrange` is swapped to the would-be-after-
  release arrangement for the duration of the paint pass and
  restored before the next mouse event. The user SEES the post-
  release layout while dragging — replaces the old seam-bar / cell-
  frame hints, which were one-line indicators of "where the panel
  would land." Restore window also includes
  `renderTerminalOverlay` so the xterm session in detail paints at
  preview-shifted coordinates while a free-config drag is in flight.

- **3-zone hit-test per cell.** Both pool drag and in-grid drag use a
  unified cell layout:

  - **Top third** → insert before this cell.
  - **Middle third** → for pool drag: REPLACE the occupant (occupant
    returns to pool). For in-grid drag: SWAP the dragged panel with
    the occupant (cross-column swap supported; same-column swap
    preserved). Self-swap (source == occupant) is a valid no-op
    surfaced in the footer as `(no-op — release to cancel)`.
  - **Bottom third** → insert after this cell.

  Replaces the v0.5 / early-v0.6 pool-drag scheme (`replace on cell
  hit + APPEND in a 2-row strip at column tail`), which left no way
  to insert between cells. Detail-at-end clamp annotated in the
  footer (`→ insert at right:N (clamped — detail stays at end)`)
  when the user drops in a position that would land past detail in
  the right column. Detail and `actions` can't live in the left
  column from either gesture (was an asymmetry: in-grid drag
  blocked it, pool drag let it through).

- **View-mode × free-config guards.** Free-config can only be entered
  from normal view; the view-mode keys (`[`, `]`) and any cmdline
  verb that would change view-mode are blocked while free-config is
  active. Refusals surface a footer notice (`free-config requires
  normal view ([ to return)` / `exit free-config (q) to change view
  mode`) that auto-clears on the next unrelated user intent. Drag
  motion Msgs preserve the notice (single drag intent in flight).

- **Half-view non-detail focus tracking.** In half view, when focus
  moves to detail (e.g., clicking a tab in detail's bar), the LEFT
  side now keeps showing the most recently focused non-detail panel
  instead of duplicating detail. Tracked in `slice.halfLeftPanel`,
  updated in `focus_set` (non-detail target) and committed on
  `design_exit` (catches free-config nav, which bypasses
  `focus_set`).

- **Theme-driven chrome palette.** New theme slots: `chrome_close`,
  `chrome_collapse`, `chrome_expand`, `chrome_trigger`. Default
  mappings follow the Mac traffic-light convention; themes can
  override per slot. Glyphs dim with the panel when the panel isn't
  focused (composes `[dim]` with the color, not the terminal default
  fg).

### Changed
- **Mode flag renamed.** `model.modes.designMode` → `freeConfigMode`
  throughout (26 references across 13 files). Mechanical rename;
  behavior under the old flag preserved. External plugins reading
  the flag name need a one-line update.

- **Freeze gate during free-config mode.** While the mode is active,
  the dispatch layer drops broadcast Msgs (refresh / hub / action)
  and wrapped Msgs targeting non-`layout` components. Components
  render their last snapshot until the user exits, so the canvas
  stays stable under drag / resize / pool mutations — matches the
  tmux prefix-mode mental model. Mode entry/exit ride the root
  reducer, not the gated dispatch path, so the mode itself always
  transitions cleanly. Narrow exception: the tab-reorder gesture's
  `viewer_reorder_content_tab` Msg passes through (live reorder
  within detail's tab bar, same justification as `pool_hide`/`show`).

- **`:save-layout` writes the `panels:` block when needed.** Legacy
  configs (every entry synthesized AND placed) continue to write the
  v0.5 inline form, byte-for-byte where possible. Configs with
  hidden entries or a user-declared pool write both blocks; layout
  cells become id-refs. Round-trip is idempotent — parse → save →
  parse → save produces the same bytes.

- **Pool drag UX.** Replaces the v0.6 Phase 5 scheme (replace on cell
  + append in a 2-row strip at column tail) with the unified 3-zone
  per-cell hit-test described above. Every visible cell now offers
  insert / replace / insert at thirds; the user can drop between any
  pair of adjacent panels without hunting for a tiny append strip.
  Same UX works in normal, half, and full views.

- **Cmdline matcher uses full buffer text.** Multi-word entry names
  (`theme dracula`, `focus FilePanel`) score against the entire
  buffer rather than just the first whitespace-delimited token, so
  the user can refine through the registered display string. Single-
  word entries still match `query`-only, so trailing positional args
  don't disturb their fuzzy scores.

- **Page-up / page-down** (`,` / `.`) move a full page. Earlier moved
  half a page.

- **Chrome paint method.** `[_]`/`[X]`/`[≡]` glyphs are baked into the
  panel's top-border row markup, written atomically by `paintColumns`.
  Pre-fix the glyphs were painted in a separate cursor-move pass after
  paintColumns, which let the row's `─` fill briefly show through on
  every detail-scroll frame — visible as flickering glyphs in the
  lower-left panels.

- **`free-config` footer label.** Reads "Free Config" (was "Design
  Mode" through the rename).

### Fixed
- **Pool drag/show refuses `detail` / `actions` into the left column.**
  In-grid drag already blocked this gesture; pool drag and the
  `pool_show` reducer didn't, letting users land an `actions` panel in
  the left column with a positional hotkey instead of the conventional
  `0`. Now both gestures refuse with the same reason text the in-grid
  drag uses.

- **Half-view dup-detail bug.** Clicking a tab in detail's tab bar or
  clicking detail's content area dispatched `focus_set` to detail;
  `renderHalf` paints `focusedPanel` on the left + `detail` on the
  right, so detail showed up on BOTH sides. Now the left side falls
  back to the most recently focused non-detail panel
  (`slice.halfLeftPanel`).

- **Same-column right-column drag past detail.** The detail-at-end
  clamp in `validateTarget` pre-decremented for same-column source
  AND `applyInsert` re-decremented for the splice-shift — net
  double-counting left the source pinned at its own slot for any
  drag past detail. Now uses pre-removal `detailIdx` only; the
  insert's existing decrement handles the shift correctly.

- **Self-swap with detail flagged as invalid.** The "detail must stay
  at end" rule applied unconditionally to swap targets involving
  detail; releasing a drag onto detail's own middle-third showed a
  red ✗ in the footer for what's semantically a no-op. Now self-swap
  (source == occupant) is always `valid:true`; the subsequent
  detail-at-end rule only applies to cross-panel swaps.

- **Terminal overlay during drag.** `renderTerminalOverlay` reads
  `panelBounds.detail` to position the xterm session. The drag-
  preview swap-window used to end before the terminal overlay's
  paint, so the overlay drew at original (pre-shuffle) coordinates
  while the surrounding layout showed preview-shifted detail. Now
  the swap covers the terminal overlay too; restore happens before
  the viewport-cache dispatch.

- **Detail-at-end clamp visible in the footer.** Dropping in the
  bottom third of detail clamps the insert index back to detail's
  slot (panel ends up just before detail). Pre-fix this happened
  silently — the user saw their preview paint above detail with no
  signal that the target was rewritten. Now the footer reads
  `→ insert at right:N (clamped — detail stays at end)`.

- **Self-swap reads as `(no-op)` in the footer.** After the self-swap
  validity fix, the footer would have shown `dragging X → swap X
  (col)` in bold yellow — looks like a real action. Now reads
  `(no-op — release to cancel)` in dim.

- **Footer truncation under overflow.** Pre-fix a long footer wrapped
  to a second row, scrolling the screen up and looking like the
  frame was shrinking each render. Now markup-aware-truncated to
  fit the terminal width.

- **`bold red` / `bold green` / other bold-color combos** map through
  richToAnsi correctly. Pre-fix only the bold was emitted, dropping
  the color half.

- **Cmdline dropdown scroll** advances with the selection so the
  highlighted entry stays in view even when the match set is larger
  than the dropdown viewport.

- **Cmdline Tab accepts the SELECTED match,** not always
  `matches[0]`. Pre-fix arrow-down then Tab completed the first
  match rather than the highlighted one.

- **Cmdline Enter on a refinable entry behaves like Tab** —
  directories and container names rewrite the buffer instead of
  firing `run()`, keeping the user in cmdline so they can continue
  refining.

- **Cmdline hint shows on partial prefix** (`:open dock` now shows
  the `docker://` hint). Pre-fix the hint only showed on empty
  input.

- **Cmdline residue persists when `:free-config` triggers from cmdline
  mode.** Modal transitions A→B drop A's pixels before B paints; the
  force-full-repaint fingerprint computes over the active overlay
  SET, not a single bool, catching every overlay drop.

- **Pool-drag motion only repaints on TARGET change,** not every
  pixel. Rapid drag no longer makes the affordance blink.

- **Free-config focus preserves on entry.** Entering free-config used
  to reset focus to the first placed panel; now keeps the user's
  current focus when it points at a placed panel.

- **Panel title markup-aware truncation.** Titles carrying markup
  (`[docker:pg]`, `[dim]`, `\[…\]`) used to be length-sliced
  ignoring visible-width math, sometimes cutting mid-tag and
  swallowing the right border `╮`. Now truncate() is markup-aware
  and short-circuits when the title already fits.

- **Pool-drag invalid-append surfaces a reason.** Trying to drop into
  a column at cap now paints the bar in red AND surfaces the reason
  in the footer; pre-fix the bar still painted green and release
  silently cancelled.

- **Force-repaint on overlay drop AND transition,** not just
  overlay-close. Pre-fix a same-cycle A→B overlay swap left A's
  pixels under B.

- **Pool_show right-column inserts BEFORE detail,** not at the very
  end. Detail-at-end invariant enforced consistently across all
  panel-arrangement gestures (in-grid reorder, pool show via
  cmdline, pool drag, drop-on-empty-column).

- **Drag motion equality** compares every preview-affecting field
  (kind, column, index, occupantId, occupantType, valid). Pre-fix
  the helpers only checked a subset, so insert@0 → insert@1 (same
  column, both undefined occupantId) reported "equal" and skipped
  the repaint, leaving a stale preview at the old index.

### Internal
- **`js/leaves/pool.js`** — pure derivations over `arrange.pool` /
  `leftPanels` / `rightPanels`: `placedIds`, `hiddenIds`, `isPlaced`,
  `isHidden`, `getPoolEntry`, `orphanPlacements`, `panelListItems`,
  `placementFromPoolEntry`. Tested directly; no model access.

- **New leaves**:
  - `js/leaves/design-pool-drag.js` — pool-drag gesture state machine
    (`poolDragStart`/`Motion`/`Release`, `pointToPoolDropTarget`,
    `computePoolDragPreviewArrange`). Depends on `leaves/design` for
    the shared 3-zone hit-test and `leaves/pool` for
    `placementFromPoolEntry`. Pure transform.
  - `js/leaves/tab-drag.js` — content-tab reorder gesture for the
    detail tab bar.
  - `js/leaves/cmdline-split.js`, `js/leaves/sh-escape.js`,
    `js/leaves/hotkeys.js` — small shared helpers.

- **New overlays**:
  - `js/overlay/tab-list.js` — tab-list overlay + the `injectTabTrigger`
    helper that bakes `[≡]` into detail's top-row markup.
  - `js/overlay/panel-list.js` — modal panel-list inside free-config,
    with optional side-by-side preview pane (terminals ≥ 75 cols).
  - `js/overlay/cmdline.js` — cmdline render carve-out from
    `dispatch/cmdline.js`. Resolves a layering inversion where
    `render/layout.js` required `dispatch/`.

- **New features**:
  - `js/feature/open-target.js` — pluggable scheme registry for
    `:open` (`match` / `complete` / `open` hooks).
  - `js/feature/open-docker.js`, `js/feature/open-file.js` — docker
    and host schemes plugging into the registry.
  - `js/render/panel-widgets.js` — `injectTopRowChrome` for
    `[X]`/`[_]`/`[+]` and the hit-tests that read `panelBounds`.

- **Carve-outs reducing the largest files**:
  - `js/panel/commands.js` — `:` cmdline command registry, peeled
    out of `panel/api.js`.
  - `js/dispatch/actions.js` — `handleAction` switch, peeled out of
    `dispatch/dispatch.js`.

- **New Msgs on the layout slice:** `pool_hide`, `pool_show` (with
  optional `index` field for drag drops), `panel_list_{open, close,
  nav, pick}`, `pool_drag_{start, motion, release}`,
  `tab_drag_{start, motion, release}`, `panel_collapse_toggle`,
  `set_arrange`. Plus the existing `design_*` family. Single-writer-
  per-slice preserved; release Msgs return `dispatch_msg` Cmds that
  re-emit `pool_hide` / `pool_show` so the Phase 2 handlers do the
  mutation. **Target shape**: pool-drag targets are tagged
  `{kind:'insert'|'replace', column, index|occupantId, valid,
  reason?, clamp?}`; in-grid drag targets are `{kind:'insert'|'swap',
  column, index, occupantType?, valid, reason?, clamp?}`.

- **New Msgs on detail (viewer):** `tab_list_{open, close, nav, page,
  pick}`, `tab_list_close_selected`, `viewer_reorder_content_tab`,
  `viewer_remove_content_tab`, `viewer_set_viewport`.

- **New cmdline-buffer arms in the root reducer:** `cmdline_set_text`,
  `cmdline_set_matches`, `cmdline_nav`, `cmdline_submit`,
  `cmdline_cancel`, `cmdline_revert_preview`. The live-preview teardown
  ride a `cmdline_preview` Cmd through `dispatch/effects.js`.

- **New slice fields** on the layout slice: `arrange.pool` (id → entry),
  `design.drag.previewArrange` (computed on target change), `design.notice`
  (transient hint surfaced in the footer), `halfLeftPanel` (last
  non-detail focus, half-view's left-side panel),
  `panelList.{open, cursor}`, `tabList.{open, cursor, scroll}` (on
  detail's slice).

- **Test coverage**: twelve new test files pinning the v0.6 surface —
  `test-pool-schema.js`, `test-pool-derivation.js`,
  `test-pool-cmdline.js`, `test-free-config-freeze.js`,
  `test-panel-list-overlay.js`, `test-pool-drag.js`,
  `test-pool-save.js`, `test-collapse.js`, `test-tab-list.js`,
  `test-view-mode-guards.js`, `test-half-view-focus.js`. Plus
  expanded coverage in `test-design-drag.js` (3-zone hit-test, swap,
  preview snapshots, repaint emission across zone changes). Suite
  green across 60+ files.

## [0.5.0] — 2026-05-30

A refactor release. No new end-user features; the panel grid, key
bindings, and YAML config surface all look the same. What changed is
the internal architecture — and one externally visible API surface
that breaks for anyone using `dispatch.applyMsg` directly.

### Changed
- **Plugin API retired; Component API is the only extension shape.**
  External authors register a Component the same way the built-ins do
  (`require('../panel/api').registerComponent(spec)`). A Component
  owns a slice (`init()` returns the initial slice; `update(msg, slice)`
  is the single writer; `panelTypes` declares the render contract).
  The legacy Plugin API + the YAML `plugins:` loader are gone; a
  non-empty `plugins:` block in a config logs a one-line warning and
  is otherwise ignored. The migration shape is documented in
  `docs/v0.5-layering.md` and `docs/PLUGINS.md`.
- **`dispatch.applyMsg` signature changed: `applyMsg(msg)`.** The
  previous `applyMsg(model, msg)` shape carried a model argument that
  became unsafe across cascades once the reducer turned pure (a
  captured ref would lose intermediate writes if a Cmd re-entered the
  dispatch graph). The function now reads `getModel()` internally;
  callers drop the leading arg. Affects anyone using `applyMsg`
  outside this codebase — typically only test code in plugin trees.
- **Single-writer per slice.** Every Component is the sole writer of
  its own slice; the root reducer (`runtime.update`) is the sole writer
  of root-model fields. Cross-layer writes ride out as `apply_msg` /
  `dispatch_msg` Cmds. The invariants are documented in
  `docs/v0.5-layering.md §5`.
- **Pure-TEA reducer + Components.** The reducer and every Component's
  `update` now return new state objects (`{ ...slice, field: next }`)
  rather than mutating their arg. Hot-path append (streamed action
  output) spreads `[...lines, line]` per the no-in-place-exceptions
  rule. Freeze-test coverage in `js/test/test-immutable-*.js`.
- **Per-panel chrome lives on each Navigator's slice.** Cursor,
  scroll, multi-select, and committed filter text used to live at
  `model.ui.{sel,scroll,multiSel,filters}`. They now live on each
  Component's `slice.nav[panelType]`. The `model.ui` field retired.
- **Layout state lives on a layout Component slice.** The
  arrange struct (column widths + panel order), focus, view mode,
  panel bounds, design-mode working state, and the layout-dirty
  flag all live on `slice.panels.layout` now, not on the root model.
  The layout Component is registered before any other and nests
  every other Component's slice under `layout.panels[name]`.
- **viewer (detail) + groups are Components.** The final two
  bespoke panels migrated to the Component API. Their reducers,
  cascade logic (group switch → viewer reset, etc.), and slice
  state all live in `panel/viewer/viewer.js` and
  `panel/navigator/groups.js`.

### Removed
- **`type: file-manager` panel alias.** The v0.3.0 declared-registry
  panel was a subset of v0.5's unified browser. Migrate to
  `type: files, source: declared` for identical behavior. The
  auto-generated default left panel (when a project declares a
  top-level `files:` block but no explicit layout) now uses the new
  shape automatically.
- **Decorators framework.** The `decorate('panel:slot')` /
  `decorate('row:left:panelType')` extension surface was retired —
  nothing in-tree contributed, and the seam wasn't reachable from
  the new Component-shape panels. Panels compose their own row /
  badge logic inline now (e.g. groups' `running/total ●` badge).
  `viewContributions` (footer / overlay strips) remains.
- **The `S` shim.** The pre-v0.5 façade over the root model + slices
  was removed in chunks A–E during the migration. Production reads
  `getModel()` / `getComponentSlice()` directly.

### Internal
- **Source tree reorganized.** The flat `js/` directory split by
  kind: `app/` (runtime, state, tui boot), `io/` (terminal, ansi,
  streams), `render/`, `dispatch/`, `overlay/` (modal/popup
  overlays), `panel/` with sub-trees `navigator/` (list-style
  panels), `viewer/`, `monitor/`, plus `leaves/` (pure transforms)
  and `feature/` (history, register).
- **Wrapped Msg dispatch.** Component-targeted Msgs now travel as
  `{ kind: 'componentName', msg }` wrappers via `dispatchMsg`. The
  framework rejects flat Component-specific Msgs with an error log
  to catch missed wrap sites.
- **Centralized claim signaling.** Panels that claim a keystroke
  return a `_claimed` sentinel effect from their `update`; the
  framework consumes it in `dispatchKeyToFocused`. The previous
  `claimsKeys:` declaration retired.
- **Pre-release reviews.** A 4-track audit (arch / file layout /
  code / doc parity) ran before tagging. Code track: five rounds
  surfaced ~30 BUGs + 26 RISKs (3 verified by repro:
  regex DoS, ANSI breakout in panel titles, UTF-8 chunk-boundary
  corruption in streamed output). Arch track caught two dead Msg
  routes (`toggle_group` on Enter-on-branch, `toggle_groups_tab` on
  `[`/`]`) — Msgs that moved to a Component but kept being routed
  through the root reducer's no-op default; added
  `js/test/test-msg-routing.js` as a static check that every
  `applyMsg` literal in the dispatch spine has a matching reducer
  case. File-layout track moved two CLI-mode groupAction
  contributors (`archive`, `image-backup`) out of `panel/` into
  `feature/` — they were never Components, never registered.
  Doc-parity track refreshed PLUGINS.md's stale `claimsKeys`
  guidance to the post-Phase-6 `_claimed` sentinel and added a
  retired-`S`-shim substitution table to TERMINAL.md.
- **Hot-path perf measured.** `viewer_append` and `select_extend` —
  the two paths flagged for measurement when the arc rule of "no
  in-place exceptions" was adopted — measured well within budget
  at realistic loads (21k ops/sec at 10k-line buffer; 3.2M ops/sec
  for `select_extend`). Numbers, conditions, and mitigation options
  if usage shifts: `docs/v0.5-perf.md`; benchmark script
  `js/test/bench-hotpaths.js`.

### Fixed
- **`--spec` doc-bundle path.** `tui.js --spec` aborted with
  `missing doc js/docs/SPEC.md`. The v0.5 reorg moved `tui.js` from
  `js/` to `js/app/` but `printSpec()` still resolved `..` once from
  `__dirname`, landing in `js/docs/` instead of `<repo>/docs/`. Now
  walks up two levels to the repo root. Pinned by a new spawn-based
  test block in `js/test/test-cli.js` so a future relocation can't
  silently break the bundle again.
- **`plugins:` warning scope.** The boot-time deprecation warning
  fired on every non-empty `plugins:` block, including YAML config
  splits — the parser-level merge feature that's still supported and
  documented as unrelated to the retired runtime Plugin API. The
  warning now fires only on non-split entries (paths that don't end
  in `.yml`/`.yaml`, plus malformed entries that would silently
  no-op) and names them in the message, so config-split users boot
  quietly. Predicate exported from `js/parser/index.js` so the parser's
  own split-detection and the boot warning share one rule; pinned by
  `js/test/test-retired-plugin-entries.js`. PLUGINS.md updated to
  match the corrected behavior.

## [0.4.0] — 2026-05-27

### Added
- **Prefix (leader) key — a fresh `<space><key>` namespace.** Pressing
  the leader (default
  `<space>`) opens a binding namespace resolved as a TREE, so chords
  nest: `<space>g g` → top, `<space>g e` → bottom, `<space>r` →
  refresh, `<space>?` → help. Esc (or a second leader press) cancels a
  pending sequence. Bindings live in a registry (`js/keybindings.js`).
  After the leader (and at each nested level) a **which-key popup**
  lists the available continuations — `key → label`, sorted, with
  `+name …` for subtrees — so chords are discoverable, not memorized.

  Bind your own chords in a top-level **`keys:`** block. Each entry
  targets exactly one of `action:` (run a declared action by its
  `actions:` key — honors the action's `args:` prompt and `confirm:`),
  `command:` (run a `:` cmdline command, resolved by exact name), or
  `builtin:` (a framework action like `refresh` / `goto_top`); an
  optional `label:` sets the popup text. Sequences nest naturally
  (`<leader>gg`). User bindings **override** the built-in chords, so
  you can reclaim `g` / `r` / `?` for your own actions:
  ```yaml
  keys:
    "<leader>b":  { action: build }
    "<leader>L":  { command: "logs" }
    "<leader>gg": { builtin: goto_top, label: top }
  ```

  Because `<space>` previously toggled list multi-select, selection now
  lives behind a **v-mode** mirroring the detail panel's visual mode:
  `v` enters list-select mode (footer shows `[select]`), `space` toggles
  the focused row *inside* that mode, `*` selects all (and enters the
  mode), `v`/`Esc` exit. Outside v-mode `space` is always the leader —
  the rule is uniform because the mode chain already suppresses the
  leader inside detail-visual / terminal / text-input modes.
- **Unified `files` core panel — declared registry + filesystem browser
  in one panel type.** Replaces the v0.3 `file-manager` (declared-only)
  with a `source:` config that picks the behavior:
  - `source: declared`   — read `S.config.files` (the YAML `files:` block).
                           Same content as the v0.3 file-manager panel.
  - `source: filesystem` — real directory browser. Enter drills into
                           dirs, files open as content tabs in detail.
                           Hidden dotfiles excluded; `:show-hidden
                           on|off|toggle` flips visibility at runtime.
                           Regex filter via `/` (case-insensitive,
                           invalid pattern shows everything).
  - `source: both`       — declared rows first (marked ★), then the
                           filesystem listing. For projects that want
                           both their curated set and ad-hoc browsing.

  File loads are async with configurable caps (`max_bytes`, default 1MB
  text; `hex_after`, default 256KB hex). Binary files detected via
  null-byte scan in the first 8KB → canonical hexdump format.

  Backwards-compat aliases (no YAML changes required):
  - `type: file-manager` keeps the **verbatim v0.3 behavior** — substring
    (not regex) filter, no Enter-opens-file, `decorate('row:left:file-manager')`
    /`row:right:file-manager` extension hooks preserved. Users opting
    into the new declared-list rendering migrate to `type: files,
    source: declared`.
  - `type: file-browser` → `type: files, source: filesystem` alias.

  Example:
  ```yaml
  - type: files
    source: both
    root: ./src          # initial cwd for filesystem mode
    max_bytes: 2MB       # text-read cap
    hex_after: 512KB     # hex-render cap
  ```
- **`source: docker` — browse paths inside a running container.** A
  fourth source for the `files` panel that shells out to `docker exec
  <container> ls -lA --time-style=+%s` for listings and `head -c <cap>`
  for binary-safe capped reads. Same navigation, content tabs, hex
  view, and copy options as the local source; the panel just operates
  inside the named container instead of on the host. Async with a
  `Loading…` placeholder during the first fetch; cache busts on cwd
  change. Use when the data you care about lives in a named volume
  (e.g. postgres `PGDATA`) and a host-side bind mount isn't an option.

  Declared registry entries also accept a `container:` field so
  `source: declared` (and `both`) can mix host and container paths in
  one curated list.

  ```yaml
  - type: files
    source: docker
    container: pg
    root: /var/lib/postgresql/data
  ```
- **Content tabs** — new tab category in the detail panel for
  read-only text/hex surfaces. Sits alongside action tabs and terminal
  tabs (so `[`/`]` cycle through all of them). Created by plugins via
  `tabs.addContentTab(group, key, label, lines)`; reusing the same
  key updates the existing tab in place rather than duplicating. `x`
  on a focused content tab closes it.
- **`customFilter: true` plugin opt-in.** Lets a panel def take over
  filtering instead of the framework's substring matcher. Used by
  file-browser to wire regex filter via the same `/` flow; available
  to any future plugin that wants fuzzy / case-sensitive / structured
  filtering.

### Hardening
- **Panel-type registration is validated + collision-aware.** A single
  panel-def check at registration covers the whole contract
  (`render` required; `getItems`/`getInfo`/`onKey`/`copyOptions`/
  `filterText`/`idOf` must be functions; `customFilter` boolean;
  `mode`/`keyHints` strings) so a typo'd hook surfaces at load instead
  of as a silent no-op later. Panel-type **namespace collisions** now
  warn instead of silently last-wins shadowing: Plugin↔Plugin (the
  later registration shadows the earlier) and Plugin↔Component
  (split-brain — Component owns `render`, Plugin owns the other hooks),
  making real the collision warning PRINCIPLES §12 documented.
- **Extensible group schema** (PRINCIPLES §1/§5/§9). Group-level YAML
  keys are no longer rejected against a hardcoded whitelist baked into
  framework core — the framework validates the keys it owns
  (`label`/`actions`/`terminals`/`children`/`quick`) and the bundled
  plugins' shapes, but unknown keys pass through to the parsed group
  (mirroring how panel `extras` already pass through) so a plugin can
  introduce a group-level key without editing `parser/schema.js`.
- **config-status off the render path.** The panel used to spawn a git
  worktree synchronously on first render (blocking the paint + input,
  and making render impure per §11). The git computation now runs
  deferred off the render/keypress path; the first frame shows a
  `computing…` placeholder and repaints when the cache lands. `r`
  likewise defers instead of blocking the keystroke.
- **View-mode transitions force a full repaint.** `+`/`_` (normal↔
  half↔full) now invalidate the diff cache like the terminal-unzoom
  path already did, so shrinking no longer leaves stale wide-mode
  pixels.
- **Plugin / refresh-loop teardown.** Refresh loops are tracked and
  stopped on quit (and are idempotent on restart — no doubled chains);
  a new optional `plugin.cleanup()` hook fires from the framework's
  cleanup path, letting the docker plugin tear down its long-lived
  `docker events` child through the framework instead of relying solely
  on a `process.on('exit')` backstop.
- **Mode registry — single source of truth for modal states**
  (`js/modes.js`). The set of modes was previously duplicated across
  four hand-maintained lists (dispatch `modeChain`, layout
  `overlayActive`, layout `inModal`, `initState` reset) that drifted —
  a mode added to one but not the others left stale overlay pixels on
  close or leaked across re-init (the `initState` list was in fact
  missing `confirmMode`/`promptMode`/`designTitleEditMode`). All four
  now derive from one table; adding a mode is a one-line edit, and
  dispatch throws at load if a chain mode has no handler.
- **Mode-chain wedge guard.** A modal key handler that throws no longer
  traps the user in an unexitable mode — the dispatcher catches, logs,
  and force-clears the offending flag so the next key returns to normal
  dispatch.
- **Layout constraints enforced at parse time** (PRINCIPLES §10).
  `validateLayout` rejects configs with ≠1 `detail` panel, >1 `actions`
  panel, >6 left / >3 right panels, or a panel missing `type` — these
  previously passed `parse()` and crashed or silently misbehaved at
  render (two `detail` panels clobbered each other's bounds).
- **Detail-transient state no longer leaks across transitions.**
  `resetGroupContext` clears the visual selection + detail cursor on
  group switch; `setDetail` invalidates a committed `/`-search (whose
  match offsets pointed into the now-replaced content).
- **Leader-bound actions resolve plugin-synthesized actions.** A `keys:`
  `action:` binding now sees the same merged set as the actions panel
  (plugin `groupActions` + YAML `actions:`), routed through the shared
  args-prompt/confirm path — so binding e.g. a docker-contributed action
  works instead of silently doing nothing.
- **Per-panel-type files state** (`S.fileBrowsers[panelType]`) — the
  `files` and `file-browser` panel types now hold independent cwd /
  showHidden / lastError slots. Earlier global singleton meant a
  layout with both panel types collapsed to one cwd.
- **`_fsItems` mtime cache.** Directory listings memoize on cwd +
  cwd-mtime; unchanged dirs return cached items with zero syscalls.
  Refresh / cd / `:show-hidden` bust the cache. Earlier code did
  readdirSync + N statSyncs every render frame.
- **UTF-8 codepoint alignment + BOM detection** in file-loader. The
  text cap is rounded back to the last complete UTF-8 codepoint so
  trailing partial bytes don't render as U+FFFD. Files with a UTF-8
  BOM get it stripped silently; UTF-16-LE BOM routes through a
  utf16le-decoded text path; UTF-16-BE BOM is acknowledged and
  routed to hex view (no native Node decoder).
- **Declared dotfiles respect `:show-hidden`** in `source: both`
  mode. Previously the filter ran only over filesystem entries —
  YAML-declared `.env` etc. always rendered with the ★ marker.
- **Regex-DoS guard** (`js/regex-guard.js`). The `/`-filter (files
  panel) and `/`-search (detail panel) compile user-typed buffers
  into RegExps; without a guard, patterns like `(a+)+x` freeze the
  event loop indefinitely. The shared `safeRegex(pattern, flags)`
  caps pattern length at 200 chars and rejects the classic
  catastrophic-backtracking shapes (`(a+)+`, `(.*)+`, etc.) before
  ever compiling.
- **Rich-markup escaping** in file-loader's hex ASCII column and
  text-line output — file bytes containing `[` no longer get
  re-parsed as markup tags and corrupt downstream styling.
- **Async file-open race fixes** in `_openFileAsTab`:
  - Capture `S.currentGroup` at submit time so a mid-load group
    switch doesn't dump content into the wrong group.
  - Resolve `item.path` against `S.projectDir` before reading so
    declared relative paths land at the right file regardless of
    the process's launch directory.
  - Use new `tabs.updateContentTabLines(group, key, lines)` on
    completion so a slow load can't yank focus back to detail
    after the user navigated away.
- **`removeContentTab` refreshes the detail body** after rewinding
  `S.activeTab` — closing the active content tab now loads the
  sibling tab's lines (or re-emits Info via `showSelectedInfo`)
  instead of leaving the closed file's text painted on screen.

- **`LAZYTUI_PATH` version trampoline.** When set in the environment,
  every `bin/lazytui` re-exec's against the lazytui checkout at that
  path instead of the locally-installed one. Lets a consumer project
  (e.g. `~/exchange/pg-tui`) point at an in-development lazytui
  (`~/exchange/lazytui`) without npm install/publish churn, then
  `unset LAZYTUI_PATH` to fall back to whatever the consumer
  shipped with. Same-directory guard prevents infinite re-exec when
  the path resolves to the current install. Fails loud (exit 1, error
  on stderr) when set to a non-directory or a directory missing
  `js/tui.js`, so misconfiguration can't silently fall through to the
  wrong version.

## [0.3.0] — 2026-05-24

### Changed
- **`type: spawn` no longer depends on tmux for non-blocking
  execution.** Outside tmux, spawn now opens an ephemeral PTY tab
  in the detail panel (reusing the existing node-pty +
  @xterm/headless infrastructure that already backs `terminals:`
  blocks) and sets `S.viewMode = 'full'` so the child gets the
  whole terminal via the already-shipping full-screen view.
  Multiple concurrent spawns each get their own tab. The user can
  step back to the normal layout with `_` while the child keeps
  running; `+` re-zooms; clean exit auto-closes the tab and drops
  back to normal layout; non-zero exit keeps the tab so the error
  is readable but drops the zoom so the rest of the TUI is
  reachable. The tmux branch (`process.env.TMUX` set) is kept as
  an opt-in tier — a real OS-level new window is still preferred
  for long-lived interactive sessions, and existing users who
  already run lazytui under tmux see no change.
  - Replaces the prior `suspendTerminal` / `spawnSync(stdio:
    'inherit')` / `resumeTerminal` dance, which blocked Node's
    event loop for the child's entire lifetime — refresh ticks
    and hub publishers were frozen, and the user couldn't
    navigate to other panels until the spawned command exited.
  - `terminal.js#onExit` factored into a new exported
    `_onSessionExit(id, exitCode)` so the view-reset behavior is
    unit-testable without mocking node-pty. `tabs.handleSession
    CleanExit` is unchanged.
  - On session exit (clean, non-zero, or signal like SIGQUIT
    from Ctrl+\), `_onSessionExit` calls `forceFullRepaint()`
    when the exiting session was the user-visible one. Without
    it, the diff cache held the PTY-painted cells as "unchanged"
    and skipped them — chrome behind the dead PTY never redrew,
    leaving the last frame stuck on screen. Same diff-cache-
    reclaim pattern as the SIGCONT/suspend path.
  - **Ctrl+\ drops viewMode='full' along with terminal mode.**
    In `input.js`, Ctrl+\ is intercepted before reaching the
    PTY — it just toggles `S.terminalMode = false` so the user
    can navigate via lazytui keys while the child stays alive.
    Pre-v0.3.0, that was enough because PTY tabs lived in
    `viewMode='normal'`. With auto-zoom from `type: spawn`,
    keeping `viewMode='full'` after Ctrl+\ left the user in a
    chrome-less full-screen detail panel with no PTY input and
    no obvious way out. The handler now also drops the zoom and
    forces a repaint. Same fix applied to the sibling "session
    already dead" branch.
  - **Tab keys use a monotonic counter** —
    `spawn-<actionKey>-<ts>-<seq>` — so two spawns of the same
    action within a single millisecond produce distinct tabs.
    Without it, `addEphemeralTab` silently reused the existing
    tab and its dead PTY session.
  - **Child-lifecycle note (PTY-tab path only).** Because the
    embedded PTY session lives as a child of the lazytui Node
    process, the spawned child dies when lazytui quits — same
    contract as lazygit / lazydocker / k9s subprocesses. The
    tmux branch (`$TMUX` set) keeps its old detach-survival
    semantics: child runs in a sibling tmux window and outlives
    lazytui. If you need detach-survival without tmux, wrap the
    script in a session manager (`tmux new-session -d`,
    `dtach`, `abduco`). There's no in-process node-pty trick
    that gives both an embedded display and survive-quit —
    the PTY master fd in our process is the child's lifeline,
    so when it closes the slave gets SIGHUP.
  - Tests: replaces `test-spawn-bare.js` (which pinned the old
    blocking semantics) with `test-spawn-pty-tab.js` — 21
    assertions across 5 sections covering the new path, the
    tmux path still routing through `tmux new-window`, and the
    onExit view-reset for clean / non-zero / non-active-session
    cases.

- **Parser rewritten from Python to JS — lazytui is single-runtime now.**
  The Python parser (`parser/`, 1124 LOC) and its pytest suite (`tests/`,
  1101 LOC) are deleted. Replaced by an in-process JS parser at
  `js/parser/` (~700 LOC) backed by `js-yaml` for YAML loading; the
  ported test suite lives at `js/test/test-parser-*.js` (88 cases
  across 4 files). The runtime path swaps `python -m parser` for
  `require('./parser').parse()` — saves an out-of-process spawn on
  every TUI launch and removes the dual-runtime install story.
  - **`bin/lazytui`** drops the `.venv/bin` PATH shim — no Python
    needed at runtime.
  - **`package.json`** adds `js-yaml ^4.1.1` as a runtime dep
    (alongside `node-pty` and `@xterm/headless`), and flips
    `"private": true` → `false` now that the dual-runtime install
    story is gone. `npm publish` passes its CLI guard; the actual
    publish to npmjs.com is still a separate manual step (no
    `release.yml` automation yet — see RELEASING.md).
  - **CI** drops the "Set up Python / install pyyaml / run pytest"
    steps from both `.github/workflows/test.yml` and `release.yml`.
    `requirements.txt` and `pytest.ini` are removed.
  - **Output parity**: a differential harness (parse the same YAML
    through both parsers, deep-diff JSON output) ran on every
    fixture + both demos before deletion — 14/14 identical, including
    error-message strings for schema and resolution failures. State.js
    consumes the same JSON shape unchanged.
  - **Test fixtures** moved from `tests/fixtures/` to
    `js/test/fixtures/` so the JS suite owns them.
  - **Docs** updated: README, DEMO, CONTRIBUTING, RELEASING,
    docs/TESTING, docs/SPEC drop their Python-prereq references.
    History entries in CHANGELOG.md describing the prior dual-runtime
    state are left intact as a chronological record.

- **Design Mode v2 (Phase 3 follow-up): per-panel `heightPct` +
  corner drag + keyboard `[`/`]`.** Drag-to-resize extends from
  two single-axis seams (column separator + detail top) to every
  same-column horizontal boundary, plus a corner handle at the
  col-separator × column-boundary intersections that adjusts both
  axes in one gesture.
  - **Per-panel `heightPct` (YAML).** New optional key on any
    non-detail panel — fraction of the column's total height.
    Panels that set it are anchored; panels that don't are flex
    and share whatever's left in their column equally. Existing
    YAMLs without `heightPct` behave exactly as before
    (equal-share). Oversubscribed sums scale proportionally;
    every panel still meets `minH=3`. Detail keeps its own
    `detailHeightPct` knob (layout-level), unchanged.
  - **Every same-column boundary is draggable.** New
    `boundaryNear()` hit-test runs on press. Drags between two
    non-detail panels mutate both `heightPct` values; drags
    involving detail mutate `detailHeightPct` (clamped [20, 90])
    and the non-detail neighbor's `heightPct`. D1 semantics:
    `freezeColumnFlex` runs on press so siblings keep their
    displayed height instead of redistributing mid-drag and
    outrunning the cursor.
  - **Corner handle.** At intersections of col-separator × any
    column boundary (left or right), the press dispatches
    `resizing-corner`; motion fires both `applyColResize` and
    `applyBoundaryResize` per event. One diagonal gesture moves
    `leftWidth` + the column boundary together.
  - **Keyboard `]` / `[`.** Grow / shrink the focused non-detail
    panel's `heightPct` by 5 pp, stealing from the panel below
    (mirrors drag D1). Detail keeps `+`/`-`. No-op at the last
    position in a column. Footer learns the binding:
    `+/- col/detail · [/] panel h`.
  - **docs/LAYOUT.md** grows a "Resizing panels (design mode)"
    section with drag-target and keyboard tables; the YAML
    example shows `heightPct`.
  - **Tests:** new sections `[3a]`–`[3f]` in
    `js/test/test-design-phase3.js` cover within-col boundary
    drag, corner drag on both sides, freeze-on-press, `calcLayout`
    distribution math (anchored / flex / oversubscribed), and the
    `]` / `[` keys (grow, shrink, detail-skipped, last-position
    no-op, detail-clamp). 97 assertions across 41 cases.

- **Design Mode v2 (Phase 3): undo/redo, drag-to-resize, title edit,
  and `:restore-layout`.** Four features stacked on top of Phase 2:
  - **Drag-to-resize separators.** Mouse press on the column boundary
    (`x ≈ leftWidth`, ±1 cell tolerance) drags `leftWidth` with the
    cursor. Press on the detail-panel top border (`y === panelBounds.detail.y`)
    drags `detailHeightPct`. Both clamp to the same ranges as the
    keyboard `+/-` keys (20–60 for `leftWidth`, 20–90 for
    `detailHeightPct`). Hit-test runs BEFORE the panel-drag arming
    so the separator (which visually sits on a panel border) is
    reachable.
  - **Edit panel title in place.** `t` in design mode enters a
    sub-mode that buffers keystrokes against the focused panel's
    title; Enter commits, Esc cancels. A new `S.designTitleEditMode`
    flag sits ABOVE `S.designMode` in the dispatch chain so design's
    main key handler is skipped while editing.
  - **`:restore-layout` cmdline.** Discards runtime layout changes
    and reloads the `layout:` block from the YAML config file.
    Clears `S.layoutDirty` and the design-mode undo history (the
    new layout is unrelated to anything in the stacks). Companion to
    `:save-layout`; both share the new pure-function
    `rebuildLayoutFromConfig(config)` extracted from `state.js#initState`.
  - **Multi-step undo / redo within a design-mode session.** Every
    layout mutation pushes a snapshot to an in-memory stack (cap 50).
    `u` pops to undo, `Ctrl+R` redoes. Drag gestures push exactly one
    snapshot per gesture (on press), not per motion event. Stack is
    session-scoped: cleared on `enterDesign` and on `:restore-layout`.
    A new mutation after an undo invalidates the redo stack (the
    branched-off timeline no longer applies).
  - Footer hints expanded inline: `Design Mode | drag move/resize |
    J/K reorder | ←→ swap col | +/- resize | t rename | u undo |
    C-r redo | :save-layout | q exit`.
  - Input layer: `\x12` (Ctrl+R) now translates to a named `'ctrl-r'`
    key event in `js/input.js`, alongside the existing `\x03 → exit`
    handling. Currently only design mode acts on it.
  - Tests: new `js/test/test-design-phase3.js` (57 assertions across
    6 describe blocks) covers hit-test math, drag-resize gestures,
    undo/redo round-trip across all mutation types, title-edit buffer
    handling, and `rebuildLayoutFromConfig` purity.

- **Design Mode v2 (Phase 2): drag-and-drop in the real layout.**
  The centered modal overlay is gone. Mouse press on any panel
  inside design mode arms a drag; ≥1 cell of motion enters dragging
  state and paints a green/red insertion line across the target
  column where the panel will land. Release commits the move
  (sets `S.layoutDirty`) or snaps back (invalid target — detail or
  actions into the left column). Keyboard bindings stay (`↑↓ J/K
  ←→ +/-`) — mouse is additive, not replacing.
  - SGR mouse mode 1002 is now enabled at startup (motion-while-held).
    Cost is bounded: terminal only reports motion when a button is
    down. Press → motion+ → release events now fan out through
    `input.js#handleMouse`; non-design code paths still only act on
    press (existing focus+select behavior unchanged).
  - Drop-target math: top half of a panel = insert before, bottom half
    = insert after, below the last panel in a column = append. Empty
    column drops at index 0. Detail and Actions panels are blocked
    from the left column with a footer reason; the insertion line
    paints red instead of green over the blocked target.
  - Design-mode footer now surfaces the affordance hints inline
    (`drag move | J/K reorder | ←→ swap col | +/- resize |
    :save-layout | q exit`) so the discovery path doesn't need
    external docs.
  - Tests: new `js/test/test-design-drag.js` (44 assertions) pins
    state machine transitions (press → armed → dragging → release),
    drop-position math (top/bottom half, append, empty column,
    invalid column), and cross-column splice/insert math with
    same-column-index adjustment.

- **Design Mode v2 (Phase 1): save is decoupled from mode exit.**
  Hitting Enter inside design mode no longer writes to YAML; neither
  does `q`/`Esc`. Mutations apply to `S.layout` at runtime and the
  footer shows `• unsaved (:save-layout)` while they differ from the
  on-disk config. To persist, run the new `:save-layout` cmdline
  command. Rationale: makes the editing surface a free-form
  experiment-and-tweak space (live tweaker UX) without conflating
  exit with commit. A future `:restore-layout` will revert runtime
  state to the YAML's contents; for now, restart the TUI to re-read
  from disk.
  - Lossy save is fixed in passing. `:save-layout` writes through a
    new `js/yaml-layout.js` module whose `serializeLayout()` walks
    every key on each panel object except runtime-derived ones
    (`hotkey`, `column`, `config`) and the detail panel's synthesized
    `height`. Plugin panel keys (`topic`, `select_from`, `decorators`,
    `refresh_interval_ms`, custom plugin options) survive the round
    trip — previously they were silently dropped, breaking the stats
    panel's hub subscription on any save.
  - `S.layoutDirty` tracks divergence from disk; set by every
    layout-mutating handler in `design.js`, cleared by
    `:save-layout` on success.
  - Phase 2 (drag-and-drop in the real layout, replacing the centered
    modal overlay) is planned but not in this commit.
  - Tests: `js/test/test-yaml-layout.js` covers scalar emission,
    per-panel key preservation, full emit→write→reparse round-trip
    through the Python parser, and the existing-block splicer.

### Fixed
- **JS-plugin loading was a silent no-op (parser-port regression).**
  The JS parser-port from earlier in v0.3.0 dropped the `plugins:`
  block from `parse()`'s returned config — `loadPlugins(S.config.plugins,
  ...)` received `undefined` and iterated zero entries, so JS plugins
  (`path: ./foo.js` style) never `require()`d and never registered
  their panel types. Layouts that referenced a JS-plugin-provided
  panel type rendered the slot as an empty string; in `paintColumns`
  the short-left-output then concatenated the right column's bottom
  rows into the empty left rows, painting the detail panel under the
  groups panel at column 0 with right-column width. YAML plugins
  (`.yml`/`.yaml` paths) were unaffected because `mergeYamlPlugins`
  inlines their content into groups/vars/files before validation.
  The differential parser test that gated the JS port passed only
  because neither postgres nor cloudberrydb demo uses a `.js` plugin
  path — the codepath had no fixture coverage. Fix: include
  `data.plugins || {}` in `parse()`'s return; two regression tests
  pin the round-trip and the no-plugins-block → `{}` contract.
  Surfaced by the ssh-fleet demo, which is lazytui's first JS-plugin
  user.

- **Cmdline (`:`) polish from manual testing.** A cluster of
  user-reported glitches in the cmdline dropdown and bare-Esc
  dispatch, fixed in sequence as they surfaced:
  - **Bordered dropdown panel + theme integration.** The match
    list used to paint raw `\x1b[7m` / `\x1b[2m` rows directly
    onto the cells beneath, with no border or separator — read
    as visual bleed-through against whatever panels happened to
    sit at the bottom of the screen. Now renders through
    `renderPanel` (same helper menu / design overlays use):
    bordered box, themed chrome, count badge (`<sel>/<total>`),
    centered horizontally just above the prompt row. Selection
    follows PRINCIPLES.md §8 — outer `[reverse]` wraps the
    whole row, no inner style nesting.
  - **Width scales with the terminal.** The previous 80-col cap
    left a small box hovering in unused space on wide
    terminals. New formula `panelW = max(40, COLS - 4)` bottoms
    out at 40 on narrow terminals and grows with everything
    else.
  - **Clean shrink residue.** When the match set shrunk
    (additional chars narrowed matches), the previous frame's
    taller panel left ANSI residue on rows the new panel no
    longer covered — the underlying panels' diff cache had no
    reason to think they'd been touched. New
    `layout.invalidateRows(startY, endY)` empties the per-row
    diff cache for the affected range so the next render
    repaints from the panels below; `cmdline.js` also blanks
    those rows synchronously so the current frame stays clean.
    `invalidateRows` is reusable by any future overlay with a
    similar incremental-shrink pattern.
  - **Collapse newlines in match desc.** YAML `desc: |` block
    scalars carry literal `\n`. The dropdown formatter passed
    them through to `renderPanel`; `truncate()` counted `\n` as
    width 1 but the terminal honored it as a real line break,
    so the right border dropped onto its own row. Whitespace
    runs in both `display` and `desc` are now collapsed to
    single spaces in `formatMatchLine` — the single-line
    guarantee is enforced at the formatter, not relied on from
    the data source. Full multi-line desc still renders
    untouched in the Info panel.
  - **Bare Esc dispatch (input layer).** Pressing Esc inside
    cmdline sometimes didn't exit. Some terminals + Node
    stdin buffering states deliver bare Esc as `\x1b\x1b`
    (the legacy literal-Esc trick) or `\x1b<followup>` (Esc
    plus a buffered keypress in one chunk); the strict
    `data === '\x1b'` check on `input.js` only matched a clean
    single-byte chunk. Defensive fallthrough now treats any
    chunk that starts with `\x1b` and survived all the
    specific-sequence checks (focus events, paste, SGR mouse,
    arrow keys, PgUp/PgDn, Ctrl+R) as `'escape'`. Trailing
    bytes are discarded — lazytui has no Alt/Meta bindings.

- **`type: spawn` actually works outside tmux now.** Previously, the
  no-tmux branch ran the script *detached* with `stdio: 'ignore'`, so
  interactive subprocesses (`psql`, `less`, `$EDITOR`) got `/dev/null`
  for stdin/stdout and silently exited — making the action feel like
  it "had no effect". The fix mirrors the SIGTSTP dance from
  `suspend.js`: suspend the TUI's terminal modes, hand the child our
  TTY synchronously (`spawnSync` with `stdio: 'inherit'`), then
  restore. Suspend/resume primitives are factored into
  `suspend.js#suspendTerminal/resumeTerminal` so both call sites stay
  in sync. The detail panel now also reports the child's exit status
  (clean, non-zero, signal, or spawn-error), so a quick failure is
  no longer indistinguishable from a no-op. Regression test in
  `js/test/test-spawn-bare.js`.

### Considered but not shipped for v0.3.0
- **Printf-above-program output.** Persistent messages printed above
  a TUI's main render area need altscreen — lazytui doesn't use it
  (deliberate — leaves prior shell content visible after quit) so
  the "above" concept doesn't translate. The detail panel +
  `streamCommand` already cover the underlying use case (streamed
  action output landing somewhere visible and persistent).
- **External event injection.** Useful for IPC and test harnesses,
  but every implementation (HTTP server, Unix socket, named pipe)
  adds attack surface for a feature with no concrete user demand
  yet. The key-filter middleware (above) already covers the
  in-process injection case for tests. Defer until a real use case
  surfaces.
- **Embeddable widget library + declarative styling DSL.** Big
  architectural moves from the earlier feature audit. Each is a
  v1.0-scale undertaking; deferred deliberately.

### Added — v0.3.0 surface (terminal-citizen polish)
- **Component API — strict TEA-shaped alternative to Plugin.** New
  `api.registerComponent(component)` registers a plugin whose state
  is framework-owned (slice per Component), messages flow through
  `update(msg, slice) → newSlice`, and render functions receive the
  slice (not the global `S`). Coexists with `registerPlugin` —
  every existing plugin keeps working unchanged. Plugin authors
  pick per-plugin: Plugin for the fast-path (mutate-S, simple) or
  Component for the discipline (replay, snapshot tests, isolation).
  See PRINCIPLES.md §12 for the contract.
  - Framework wiring: registration validates `init` + `update`,
    init runs at register time, panel types tracked separately
    from Plugin panel types, decorators / statusFor reused as-is.
  - Msg dispatch: every key (via `dispatch.handleKey`), refresh
    tick (via `refreshAll`), hub publish (via `hub.publish`), and
    action invocation (via `actions.runAction`) fans out to every
    Component's `update()`. Msg shape mirrors event-log entries.
  - Update isolation: a Component's update() throw is logged and
    that Component's slice stays put; other Components keep
    processing the same Msg.
  - Render integration: `layout.rendererFor(type)` checks the
    Component-owned panel map first; falls through to the
    Plugin-owned path if no Component claimed the panelType.
  - Tests: `js/test/test-component.js` (15 assertions) covers
    registration validation, init-at-register, Msg fan-out, return
    shapes (new slice / undefined / throw), and component-panel
    render wiring. JS suite now 21/21 (was 20).
- **Key-filter middleware.** `dispatch.registerKeyFilter(fn)` adds a
  pre-dispatch hook. Each filter receives `{key, seq}` and may
  return the (possibly modified) event, the event unchanged, or
  null to suppress. Filters run in registration order; the dispatch
  layer logs + dispatches whatever survives the chain. Use cases:
  keyboard remapping (vim-mode hjkl → arrows), key throttling /
  debouncing, pre-dispatch analytics, test instrumentation. New
  test file `js/test/test-key-filters.js` (13 assertions).
- **Per-plugin refresh cadence.** Plugins gain optional
  `refreshIntervalMs` (default 10000). New
  `plugins/api.startRefreshLoops(config, opts)` starts a self-scheduling
  setTimeout *per plugin*, with overlap-skip (if a previous tick is
  still running, skip the new one) and focus-gating (via the
  `isFocused` callback the caller passes — keeps api.js
  state.js-agnostic). Stats plugins that want ~1s ticks can declare
  it; rare-poll plugins (image archives, config branch) can declare
  5min and stop wasting CPU. Replaces the previous single 10s
  refresh-everything loop in tui.js. `refreshAll()` is preserved for
  one-shot use (initial paint + `:refresh` cmdline).
- **Suspend / resume (SIGTSTP / SIGCONT).** Ctrl+Z used to corrupt
  the terminal (raw mode + mouse + focus reporting all stayed on
  for the shell). New `js/suspend.js` installs the standard Unix
  dance: on SIGTSTP, restore the terminal then re-raise the signal
  so the kernel actually stops the process; on SIGCONT, re-enter
  raw mode, re-enable mouse/focus/paste, hide cursor, invalidate
  the render diff cache, repaint. Embedded PTY children get SIGCONT
  automatically. No-op on Windows.
- **Live debug log stream (`LAZYTUI_LOG=path`).** Event log gains
  `attachStream(path)` / `detachStream()` and an auto-attach from
  the `LAZYTUI_LOG` env var at module load. Every recorded event
  also gets a JSON line appended to the file via `appendFileSync`
  (sync writes at TUI event rates are ~3 kB/s — negligible vs
  stream complexity). Tail with `tail -F` in another window for
  live diagnostics.
- `layout.js` exports `forceFullRepaint()` — resets the diff cache
  so the next `render()` does a full clear + redraw. Used by the
  SIGCONT handler; future use cases include returning from any
  external subprocess that scribbled on the screen.
- **Focus / blur events (DEC 1004).** `\e[?1004h` enabled at startup;
  `\e[I` and `\e[O` parsed in `input.js`. `S.focused` defaults to
  true (so terminals without focus reporting still refresh). The
  `refreshLoop` in `tui.js` skips its `refreshAll()` call while
  blurred — saves CPU + docker API calls while the user has tabbed
  away. On focus return, `scheduleRender()` paints the cached frame
  immediately; the next loop iteration runs the real refresh.
- **Bracketed paste (DEC 2004).** `\e[?2004h` enabled at startup.
  Pasted multi-line blocks arrive wrapped in `\e[200~ ... \e[201~`;
  `input.js` collapses each into a single `paste` key event with
  the inner text in `seq`, instead of dispatching per-byte. Mode
  handlers that want the multi-line content (prompt, cmdline) read
  the seq arg; other modes ignore.
- `js/term.js` gains `enableFocusEvents` / `disableFocusEvents` and
  `enableBracketedPaste` / `disableBracketedPaste`. Both disabled
  in `cleanup.js` for clean terminal restore on exit.

### Added — v0.2.0 surface (TEA-inspired discipline)
- **Event log recorder (`js/event-log.js`).** In-memory ring buffer
  capturing input events: key presses (via `dispatch.handleKey`),
  hub publishes (via `hub.publish`), refresh ticks (via
  `plugins/api.refreshAll`), and action invocations (via
  `actions.runAction`). Default cap 500 events (~50 kB). Exposes
  `record / enable / setCap / clear / snapshot / size / save`. The
  `save(path)` helper serializes to JSON with a version header,
  suitable for attaching to bug reports. Foundation for the planned
  replay path; deliberately producer-only in v0.2.0 — see "Pending
  for v0.2.x" below.
- **Render idempotence principle (PRINCIPLES.md §11).** A panel's
  `render(panel, w, h, S)` called twice with the same inputs produces
  the same output. Articulates the actual discipline lazytui follows
  (weaker than strict purity — layout writes derived state, stats
  panel lazy-subscribes to the hub on first render — but stronger
  than "anything goes"). New checklist bullet in §12.
- **`js/test/test-event-log.js`** — covers the ring buffer, enable
  / disable gate, JSON save round-trip, and the wired hub +
  refreshAll hooks (key + action hooks are exercised indirectly by
  the existing dispatch + cli test suites). 22 new assertions; JS
  suite now 19/19 (was 18/18).
- **`js/test/test-render-idempotent.js`.** Exercises representative
  core plugin renders (groups, actions, detail, file-manager,
  history) twice per panel under two focus configurations. 15 new
  assertions; total JS suite now 18/18 (was 17/17). Docker, stats,
  config-status skipped: docker needs runtime status setup; stats +
  config-status have known idempotent-but-impure lazy-init that is
  covered separately by their existing tests.

### Removed
- **tidb demo (parseable-only) dropped from advertised support.** The
  in-flight `dev-demo-tidb` branch is removed from `origin`. v0.1.0's
  CHANGELOG entry referenced "tidb on `dev-demo-tidb` branch awaiting
  live-test merge"; that was overpromising for a release that hadn't
  verified the demo on Docker. Restored as a future demo once a real
  use-case drives it (and once a live test actually runs).

### Changed
- README's demos table column renamed `Notes` → `Status`, and the
  cloudberrydb row now reads "YAML parses; live build not yet
  verified" instead of "live build deferred." More upfront for a
  first-time visitor.

## [0.1.0] — 2026-05-18

First public tagged release.

### Framework
- Renderer (Node.js, zero npm runtime deps except `node-pty` and
  `@xterm/headless` for embedded PTY tabs).
- Parser (Python, validates and resolves the YAML config).
- 17 JS smoke suites + 6 pytest files. Live integration harness
  under `test/`.
- Built-in panel types: `groups`, `actions`, `file-manager`,
  `history`, `detail`, plus `containers` and `stats` from the
  docker plugin.
- Subsystems: hub (pub/sub), decorators (UI slot framework),
  cmdline (`:`) verbs, embedded PTY terminals, 6 themes, design
  mode, CLI mode (`--exec`, `--list`), `--spec` bundle for AI
  agents.

### Demos
- `demo/postgres` — Shape A (build from source). Verified end-to-end
  on Docker. Includes a `POSTMORTEM.md` documenting the DinD
  bind-mount discovery and the "fix the prompt, not the artifact"
  two-layer fix that resulted.
- `demo/cloudberrydb` — Shape B (wrap upstream's `devops/sandbox/`).
  YAML parses; live build deferred. `POSTMORTEM_v1.md` captures the
  drop-and-rewrite decision when the first producing pass diverged
  from upstream's actual conventions.
- `demo/tidb` — Shape A variant (orchestrate pre-built `pingcap/*`
  images). Lives on the `dev-demo-tidb` branch pending a live-test
  merge.

### Docs
- `README.md` — positioning, ASCII TUI mockup, quickstart, comparison
  table against Make / shell / Taskfile, three-demo table, "Read next"
  with split for using vs contributing.
- `DEMO.md` codifies the two demo shapes and the loop discipline.
- `docs/` subtree: framework + plugin authoring (SPEC, PRINCIPLES,
  PLUGINS, PROJECT, LAYOUT, HUB, DECORATORS, CMDMODE, TERMINAL,
  STATS, TESTING). `docs/history/` for the dev9-era retrospective and
  FUTURE backlog.
- Standard OSS files: `CONTRIBUTING.md`, `CHANGELOG.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT).

### Release plumbing
- `.github/workflows/test.yml` — JS + pytest CI on push / PR.
- `.github/workflows/release.yml` — on `v*.*.*` tag push, runs
  tests, builds `lazytui-X.Y.Z.tgz` (npm-style) +
  `lazytui-X.Y.Z-source.tar.gz` (full git-archive), creates a
  GitHub Release with both tarballs attached.
- `RELEASING.md` documents the maintainer flow.
- `package.json` ready for publish; `private: true` retained until
  the dual-runtime npm-install question is resolved.

### Pre-tag history
The single-commit public state at `b384d19` (2026-05-15) was the
first form of lazytui visible on GitHub. v0.1.0 is the first state
with a semantic version, a CHANGELOG entry, and downloadable
release tarballs. Full pre-squash development history is preserved
on the internal gitea mirror under the `backup/main-history` branch
and the `v0.1.0-pre-squash` tag.

[Unreleased]: https://github.com/Tao-Ma/lazytui/compare/v0.6.5...HEAD
[0.6.5]: https://github.com/Tao-Ma/lazytui/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/Tao-Ma/lazytui/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/Tao-Ma/lazytui/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/Tao-Ma/lazytui/compare/v0.5.0...v0.6.2
[0.5.0]: https://github.com/Tao-Ma/lazytui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Tao-Ma/lazytui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.3.0
[0.1.0]: https://github.com/Tao-Ma/lazytui/releases/tag/v0.1.0
