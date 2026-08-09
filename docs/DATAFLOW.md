# Data flow

How a keystroke (or any input) becomes a paint. Arrows are
concept-level; function names match the live source so they're
greppable.

```
══════════════════════════════ INPUTS ══════════════════════════════
   stdin                  PTY child            Async source
   (keys/mouse/paste/      (docker events,     (timer fired,
    focus events)           PTY data, etc.)     fetch resolved)
        │                       │                   │
        ▼                       ▼                   ▼
   js/dispatch/control/input.js    js/dispatch/runtime/stream.js  a declared Sub cb
   • chunk → event tokens    js/io/terminal.js   (interval/process-stream/
     (leaves/input/tokenize; • PTY mgmt           resize; app/state.js)
     multi-event chunk paints
     once — render-queue batch)
   • SGR mouse parse
   • paste accumulator
        │
        ▼
════════════════════════════ DISPATCH ══════════════════════════════
   handleKey / handleMouse      (js/dispatch/control/{dispatch,input}.js)
        │
        ├──── modeChain active? ──yes──→ mode handler ──→ applyMsg
        │     (filter, menu, cmdline,                       │
        │      confirm, prompt, copy, ...)                  │
        no                                                  │
        ▼                                                   │
   dispatchKeyToFocused ─→ focused comp.update(key Msg)     │
        │   (Component returns `_claimed` effect to gate    │
        │    the framework default)                         │
        ▼   (not claimed)                                   │
   handleNormalKey switch                                   │
     ├─ nav-core (j/k/h/l, Enter, hotkey, x) ──┐            │
     │                                         │            │
     └─ specialized verbs (/, :, y, v, ?,      │            │
        +/_, [/], ") ─── skip the seam ───┐    │            │
   handleMouse gesture                    │    │            │
     → mouseBindings.intentFor(gesture) ──┼────┤            │
        (button/wheel; YAML `mouse:`)     │    ▼            │
                                          │  intent.realize │
                                          │  (js/dispatch/  │
                                          │   control/      │
                                          │   intent.js —   │
                                          │   the key/mouse │
                                          │   intent seam)  │
                                          │    │            │
                                          ▼    ▼            │
                              handleAction ─→ applyMsg ─────┤
                              navSelect / dispatchMsg ──────┤
                                                            │
════════════════════════════ REDUCERS ══════════════════════════════
                                                            │
   applyMsg(msg)                  ←────────────────────────┤
     (inbound middleware seam — dispatch/runtime/middleware.js:        │
      an ordered link list wraps each lane's terminal dispatch,        │
      composed once + cached by identity. Built-ins: WAL-record        │
      (self-gates on the record flag) + crash-reporter (stamps         │
      {entry,error,WAL-tail} + re-throws). A link MUST NOT dispatch     │
      and MUST NOT do non-replay-safe I/O. C7, v0.6.7.)                 │
     [model', cmds] = runtime.update(model, msg)            │
     setModel(model')             ←── root reducer          │
     runEffects(cmds)                 (chrome / modal /     │
                                       framework state)    │
   dispatchMsg({ kind, msg })     ←───────────────────────┤
     [slice', effects] = comp.update(msg, route.getInstanceSlice(id))
     route.setInstanceSlice(id, slice') ←── Component reducer
     runEffects(effects)              (single-writer per slice; id = routed instance)
        │
        ▼
═══════════════════════════ EFFECTS ════════════════════════════════
   runEffects(effects)                 (js/dispatch/runtime/effects.js)
     msg           → applyMsg / dispatchMsg routed by msg.kind
                                       (cycle cap @ 32 deep; T28)
     render        → scheduleRender (50ms debounce)
     show_selected_info / open_doc_tab
     do_run / run_action / jobs_route / unrouted_preempt_and_run
     dockerFetch / dockerExec / dockerShell
     loadDir / openFile
     cmdline_rebuild / cmdline_run / cmdline_clear
     emit_osc52 / copy_commit / select_cancel_all
     agent_start / agent_send / agent_interrupt
     force_full_repaint / run_binding / menu_action
     nav_capture / nav_restore       (jumplist push/restore; the "read-then-
                                       emit-a-recorded-Msg" pattern, v0.6.7)
   (an effect descriptor may carry an optional `key` → exclusive-by-key
    cancellation: runEffects aborts the in-flight same-key effect, injects an
    AbortSignal; controllers in a module-local _inflight Map, never the model,
    skipped by the replay fold. C5, v0.6.7.)
   (recurring work + ongoing external sources are NOT effects — they are
    declared Subs reconciled by app/state.js, FIX-3; see STATE + Notes)
        │
        ▼
═══════════════════════════ STATE ══════════════════════════════════
   Root model (js/model/store.js, _modelRef.current; re-exported from app/runtime.js)
     modes (18 modal flags, incl. jobsMode for the Running overlay)
     modal.{ filter, prompt, menu, confirm, copy, registerPopup,
             cmdline, jobs, diagLog, fabricField }
     modal.continuation        (E14: the serializable Cmd DESCRIPTOR a modal
                                emits on a successful dismissal — never a closure)
     nav { history[], cursor, cap }   (the jumplist ring, v0.6.7)
     currentGroup, config, register, prefixSeq, focused, now, theme,
     fabric, ...
     history / diagLog / jobs  (discrete live stores mirrored in via the
                                store-mirror Sub, FIX-1 — render reads these)
     metrics[topic]            (continuous hub time-series mirrored in via the
                                throttled metrics-mirror Sub, Finding B — the
                                stats graph reads this, not the hub live)

   Component slices (js/panel/route.js, nested instance store —
                     one instance per placed TAB: every tab is a
                     position-tab instance, one-tab-system.md U2)
     layout         focus, viewMode, arrange, freeConfig, lastViewerTab, dims
                    (no paneBounds field — pane geometry is pure-derived, #D7)
     content tabs   the content slot (role 'content', stable id `detail`)
                    hosts per-tab minted instances (U2e/U2f):
                      info / text-view  lines, scroll, search, select,
                                        cursor, innerH
                      terminal          paneId, cmd, label (the PTY buffer
                                        is the io/terminal island, #D14)
                      agent             transcript, status, inputDraft, …
     groups         list, expanded:Set, tab
     docker         status, stats, inFlight
     files          per-panel-type browsers
     config-status  tab, cache, branch, expanded
     nav[panelType] cursor, scroll, multiSel, filter

   Mirrorable backing stores — render reads the MODEL copy (above), not these live
     history        completion log of every action that ran           ┐ FIX-1:
     jobs           live state of every child lazytui spawned          │ {snapshot,
                    (streams, PTYs, background, tmux)                   │ setOnChange}
     diag-log       warning/error ring (leader-e overlay)              ┘ store-mirror
                    → model.{history,jobs,diagLog} (per mutation, discrete)
     hub metrics    docker.stats time-series (the stats graph)        ┐ Finding B:
                    → model.metrics[topic] via the throttled            ┘ metrics-mirror
                    metrics-mirror Sub (sampled per window — continuous source)
                    The #D5 boundary now = the terminal island only. See PRINCIPLES §12.
        │
        ▼
═══════════════════════════ RENDER ═════════════════════════════════
   render()                       (js/render/paint.js)
     1. calcLayout → layout rects (pure derived pane geometry + heights;
        no slice write)
        (pure — render dispatches nothing; the keep-in-view scroll
        clamp runs in the post-dispatch finalizer, see Notes)
     2. composeRects: for each panel in arrange,
          _safeRender(panel, w, h)
            (renderer resolved by the pane's ACTIVE-tab instance kind,
             U2f; slice via sliceForPane)
     3. painter.composeRows + paintFrame
                                  (per-cell diff vs _frame.prevRows,
                                    cell-grid.js; LAZYTUI_CELL_DIFF=0 =
                                    whole-row diff)
     4. renderTerminalOverlay     (PTY buffer per-row diff)
     5. renderFooter
     6. modal overlays (cmdline, menu, confirm, prompt, ...)
        │
        ▼
   stdout (ANSI, diff'd writes only)

   scheduleRender (50ms debounce) coalesces async-driven repaints
   from streamed output, docker results, refresh ticks.
```

## Notes

**Loop shape.** Input → reducer → effects → state → render → terminal.
The spine is *cyclic at the effects layer*: the `msg` Cmd re-enters
`applyMsg` / `dispatchMsg` (routed by payload — wrapped Msg →
Component fan-out, flat → root reducer), so one Msg can ripple into
a multi-step cascade (e.g. groups switch → viewer_reset_chrome +
reset_group_context → select_cancel_all + per-panel set_cursor /
multisel_clear / clear_filter).
T28 caps depth at 32 around the `msg` Cmd handler specifically —
direct `applyMsg`/`dispatchMsg` calls from async producers (PTY
onExit, stream onData, a declared Sub's callback — `interval` /
`process-stream` / `resize` / `store-mirror` / `metrics-mirror`,
reconciled by `app/state.js`, FIX-3 — and the `cmdline_rebuild`
writeback) are not depth-counted; they re-enter through ordinary JS
event-loop turns.

**Intent seam (v0.6.4 Theme F).** Keyboard and mouse converge on one
semantic vocabulary before they reach a reducer. The nav/activation core
— `j/k/h/l`, `Enter`, numeric hotkeys, and the `x` menu key on the
keyboard side; left-click focus+select, double→`activate`, right→`context`,
the wheel→`scroll`, and a reserved middle on the mouse side — builds an
*intent* (`focus` / `select` / `activate` / `context` / `scroll`) that
`intent.realize` (`js/dispatch/control/intent.js`) turns into the existing dispatch:
`activate`→`handleAction('run_selected')`, `select`→`navSelect`,
`focus`→`focus_set`, `context`→`menu_open` (cursor anchor threaded for a
right-click), `scroll`→`_handleWheel`. The mouse gesture→intent edge is
*data*: the SGR parser classifies a press into a gesture (`press` /
`double` / `right` / `middle`, with the same-cell double-click window read
live from `mouseBindings.doubleClickMs()`), and `mouseBindings.intentFor`
maps the three discrete button gestures to intents — overridable via a
top-level YAML `mouse:` block, the pointer analogue of `keys:`. Specialized
keyboard verbs with no pointer analog (`/`, `:`, `y`, `v`, `?`, `+`/`_`,
`[`/`]`, `"`) and mouse-direct manipulations (chrome glyphs, tab-strip,
text-select drag) sit *outside* the five-intent set and keep their own
dispatch. See [v0.6.4-input.md](v0.6.4-input.md).

**Single-writer per layer is structural.** Only `runtime.update`
writes the root model; only each Component's own `update` writes its
slice. Cross-layer writes have a Msg channel (the `msg` Cmd — wrapped
payload fans out to a Component, flat payload re-enters the root
reducer) — no path where module X writes layer Y's state directly.
(One framework-level writer shares the Component spine: a `select_*`
Msg a Component leaves unclaimed gets the shared pure selection
transition applied to that instance's slice by the loop's generic
fallback — `dispatch/runtime/loop.js#_selectFallback`,
docs/pane-selection.md — still exactly one write per dispatch.)
Render writes NO slice state at all; every former render-side write
is now retired:

  RETIRED render-side writes (blessed-exceptions arc) — render is now a
  pure reader of these:
  - `viewer.slice.tabBounds` — was written by the then-viewer's title
    renderer (tab-bar hit-test cache). Retired in A.3 (2026-06-14) as
    compute-on-read; the strip itself is the SLOT strip now (U2f — tabs
    are position-tabs) and the input layer still recomputes its geometry
    on demand (`panel/slot-strip.js#unifiedSlotStrip`), so render builds
    the strip only for the title and writes nothing.
  - `layout.paneBounds` — was written by each render-mode; now a PURE
    DERIVED value (Phase A.2). `geometry.boundsFor`/`visibleBoundsFor`
    compute it from `(arrange, dims, viewMode, focus, halfView)` via the
    memoized selector (`leaves/selector.js`). The production slice has NO
    `paneBounds` field at all (#D7 2026-06-18 deleted it); the accessors
    honor a test-only `slice.paneBounds` override when a unit fixture injects
    one (to keep hit-test-math tests decoupled from layout-math).
  - content-pane `innerH` — was a direct `setInstanceSlice` from `render()`; A.1
    moved it to the post-dispatch finalizer, then **v0.6.6 FIX-2 moved it again
    to the pane's OWN reducer**: `augmentMsg` (today: info / text-view / agent,
    via the shared `panel/pane-viewport.js#paneInnerH`) stamps `msg.innerH` (the
    pane's committed viewport height) onto each Msg and the reducer commits it.
    No outside writer remains — **blessed-exception B is retired**
    (`docs/v0.6.6.md`).
  - `setImmediate(terminal_exit)` from `renderTerminalOverlay` — retired
    v0.6.3 P5.1; PTY exit is event-driven from `pty-lifecycle.handleExit`.

**Resize is a Msg; the scroll clamp is a post-dispatch finalizer**
(resize-as-Msg, docs/resize-as-msg.md). Terminal dimensions live in
the model — `layout.dims`, written only by the `term_resized` arm;
the stdout `'resize'` listener (tui.js) dispatches the Msg and the
boot seed comes from `initState`. Geometry reads the model's dims,
never the live terminal. After every OUTERMOST dispatch (`dispatchMsg`
/ `dispatchKeyToFocused` share a depth counter), `dispatch/runtime/finalize`'s
finalizer re-clamps each navigator pane's scroll against a freshly
computed layout — the safety net needs no Msg enumeration because
every state change IS a dispatch, resize included. Render dispatches
nothing (the former `_syncScrollClamp` render-side exception CLOSED
in P3; `test-scroll-clamp.js` [4] pins render purity).

**Sync vs debounced render.** The steady state is one sync `render()`
per keystroke at the tail of `dispatch.handleKey`. The 50 ms
`scheduleRender` debounce only fires for *async* producers (streamed
action output, docker poll, refresh ticks) so they coalesce bursts.

**Routed action output — a minted `text-view` tab (U2c).** Running a
`tab:true` action mints (or reuses) a `text-view` position-tab in the
content slot (`action-runner.ensureActionTab`; poolId
`tv-act-<group>-<key>`, reuse hint `{origin:'action', group, key}`)
and streams into THAT instance by id: `tv_stream_start { header }`
reseeds the buffer + view state on a re-run, `tv_append { line }` (the
per-line hot path) and bulk `tv_append_lines { lines }` append; on
termination a `tv_status { line }` records the permanent right-aligned
`✓/✗/⊗` completion stamp as a distinct status row. The
instance owns its own buffer and scroll — bottom-stick lives in its
`update` (at-bottom follows the tail; a scrolled-up reader is not
yanked down) — so off-tab streaming needs no routing bundle, and the
tab persists across group switches. Concurrency/preempt is keyed by
`slotKey` (a per-action id, separate from the display target) in
`stream.js`'s proc map (`procs` by jobId + `slotIndex` by slot):
distinct slots run side-by-side; a same-slot re-run preempts silently.

**Unrouted streams — the Transcript tab.** Without a routed target,
streams flow to the content slot's dedicated **Transcript** tab — a
`text-view` instance seeded into the slot when the arrange is built
(`arrange.seedContentPane`, pool hint `'transcript'`), resolved via
`route.resolveTarget('viewer_transcript')`
— using the
same `tv_*` Msgs (buffer uncapped). `streamCommand` then switches the
slot's active tab to it (`route.resolveTranscriptTab` → a layout
`set_active_tab`), preserving the v0.6.7 auto-jump so the user sees
the new stream. The unrouted slot is a singleton: a same-label re-run
preempts silently; a different-label unrouted run opens a confirm
overlay (default reject, via the `unrouted_preempt_and_run` Cmd) to
protect the live transcript. When accepted, that Cmd captures a one-line
"⊗ killed previous: X" notice, kills the prior stream silently, then
threads the notice as a `preamble` on the new run's `tv_stream_start` so
the record of *what was just killed* SURVIVES the reseed (seeded ahead of
the new header). The notice is empty — and the preamble omitted — when the
preempted job has already exited on its own. On termination the completion path emits
separate dispatches — the decoder tail, then the `tv_status` chip (a
distinct status row so it can be right-aligned), then the routed
`Press Enter to run again.` hint; a disabled chip falls back to the
plain `Done.`/`Exit N` footer. Ephemeral status lines (spawn/background launch
confirmations, cmdline-verb outcomes) join the same transcript via
`appendViewerLines` (`panel/nav-state.js`) — appended with
`tv_append_lines`, no tab switch, no focus steal.

**Per-tab view state — per-instance (U2).** Every tab is a
position-tab instance, so per-tab view state needs no machinery:
`slice.{scroll, search, select, cursor}` live on each tab's OWN
instance slice, and switching tabs switches instances — persistence
across switches is free, by construction (this is also what makes
selection per-tab; docs/pane-selection.md). The v0.6.2 "T3" system
this section used to describe — `slice.tabState` keyed by resolved tab
identity, a finalizer FROM-capture, per-arm restores, `viewerOverride`
hygiene — was the workaround for ONE viewer slice serving many content
tabs; it retired with the viewer in U2f (docs/one-tab-system.md). The
generic `leaves/wm/tab-state.js` store survives as a pure leaf
(reachable via tab-container's `perTabState`), but no production pane
needs it today.

**See also.**
- `docs/PRINCIPLES.md` §12 — the Component discipline rules.
- `docs/history/v0.5-layering.md` — single-writer + the blessed exceptions.
- `docs/history/v0.5-tea.md` — the TEA shape and the two-homes state framing.
