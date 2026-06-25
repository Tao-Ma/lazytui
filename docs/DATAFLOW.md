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
   js/dispatch/control/input.js    js/dispatch/runtime/stream.js  direct dispatchMsg
   • SGR mouse parse        js/io/terminal.js   (from a setTimeout/
   • paste accumulator     • PTY mgmt            setImmediate cb)
        │
        ▼
════════════════════════════ DISPATCH ══════════════════════════════
   handleKey / handleMouse                (js/dispatch/control/dispatch.js)
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
     [model', cmds] = runtime.update(model, msg)            │
     setModel(model')             ←── root reducer          │
     runEffects(cmds)                 (chrome / modal /     │
                                       framework state)    │
   dispatchMsg({ kind, msg })     ←───────────────────────┤
     [slice', effects] = comp.update(msg, route.getSlice(kind))
     route.setSlice(kind, slice') ←── Component reducer
     runEffects(effects)              (single-writer per slice)
        │
        ▼
═══════════════════════════ EFFECTS ════════════════════════════════
   runEffects(effects)                 (js/dispatch/runtime/effects.js)
     msg           → applyMsg / dispatchMsg routed by msg.kind
                                       (cycle cap @ 32 deep; T28)
     tick(ms, msg) → setTimeout      (async re-entry; not depth-counted)
     render        → scheduleRender (50ms debounce)
     show_selected_info
     do_run / run_action
     dockerFetch / dockerEventsStart / dockerExec / dockerShell
     loadDir / openFile
     cmdline_rebuild / cmdline_run / cmdline_clear
     destroy_pty_session / emit_osc52 / copy_commit
     force_full_repaint / run_binding / menu_action
        │
        ▼
═══════════════════════════ STATE ══════════════════════════════════
   Root model (js/model/store.js, _modelRef.current; re-exported from app/runtime.js)
     modes (14 modal flags, incl. jobsMode for the Running overlay)
     modal.{ filter, prompt, menu, confirm, copy, registerPopup,
             cmdline, jobs }
     currentGroup, config, register, prefixSeq, focused, now, theme, ...
     history / diagLog / jobs  (discrete live stores mirrored in via the
                                store-mirror Sub, FIX-1 — render reads these)
     metrics[topic]            (continuous hub time-series mirrored in via the
                                throttled metrics-mirror Sub, Finding B — the
                                stats graph reads this, not the hub live)

   Component slices (js/leaves/route.js, nested store)
     layout         focus, viewMode, arrange, freeConfig
                    (no paneBounds field — pane geometry is pure-derived, #D7)
     detail         lines, scroll, tab, search, select, cursor,
                    contentTabs, ephemeralTerminals, actionTabBuffers,
                    viewerStreamBuffer, viewerOverride, tabState
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
   render()                       (js/render/layout.js)
     1. calcLayout → layout rects (pure derived pane geometry + heights;
        no slice write)
        (pure — render dispatches nothing; the keep-in-view scroll
        clamp runs in the post-dispatch finalizer, see Notes)
     2. for each panel in arrange:
          _safeRender(panel, w, h)
            (resolves comp + slice internally; P5.7)
     3. renderTerminalOverlay     (PTY buffer per-row diff)
     4. renderFooter, renderRegisterStrip
     5. modal overlays (cmdline, menu, confirm, prompt, ...)
     6. paintColumns              (per-row diff vs _prevRows)
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
a multi-step cascade (e.g. groups switch → reset_group_context →
3× set_cursor + multisel_clear + clear_filter + viewer_reset_chrome).
T28 caps depth at 32 around the `msg` Cmd handler specifically —
direct `applyMsg`/`dispatchMsg` calls from async producers (PTY
onExit, docker events, stream onData, the `tick` handler, the
`cmdline_rebuild` writeback) are not depth-counted; they re-enter
through ordinary JS event-loop turns.

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
Render writes NO slice state at all; every former render-side write
is now retired:

  RETIRED render-side writes (blessed-exceptions arc) — render is now a
  pure reader of these:
  - `viewer.slice.tabBounds` — was written by the viewer's `detailTitle`
    (tab-bar hit-test cache). Retired in A.3 (2026-06-14): now
    compute-on-read via `viewer.tabBoundsFor`, a pure
    `(slice, model, hotkey) → bounds` projection the input layer
    recomputes on demand. render() builds the strip only for the title
    and writes nothing; `slice.tabBounds` has no writer or reader.
  - `layout.paneBounds` — was written by each render-mode; now a PURE
    DERIVED value (Phase A.2). `geometry.boundsFor`/`visibleBoundsFor`
    compute it from `(arrange, dims, viewMode, focus, halfView)` via the
    memoized selector (`leaves/selector.js`). The production slice has NO
    `paneBounds` field at all (#D7 2026-06-18 deleted it); the accessors
    honor a test-only `slice.paneBounds` override when a unit fixture injects
    one (to keep hit-test-math tests decoupled from layout-math).
  - viewer `innerH` — was a direct `setInstanceSlice` from `render()`; A.1 moved
    it to the post-dispatch finalizer, then **v0.6.6 FIX-2 moved it again to the
    viewer's OWN reducer**: `augmentMsg` stamps `msg.innerH` (the pane's committed
    viewport height) onto each viewer Msg and the reducer commits it. No outside
    writer remains — **blessed-exception B is retired** (`docs/v0.6.6.md`).
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

**Routed stream Msgs.** `stream_start { header, tabKey?, groupName? }`
and `viewer_append { line, tabKey?, groupName? }` (+ bulk
`viewer_append_lines`) carry an optional routing key. With
`{tabKey, groupName}` set, the viewer reducer writes to
`slice.actionTabBuffers[groupName][tabKey].lines`; the displayed
lines DERIVE from the active tab's source via `pane-tabs.viewerLines`
(v0.6.4 viewer-lines selector — the stored `slice.lines` mirror is
deleted; render, dispatch-side readers, and the viewer's update
boundary all call the projection). `stream_start`'s
routed path additionally auto-jumps `slice.tab` to the action's index,
emits `terminal_exit` so `terminalMode` doesn't survive the jump,
clears `slice.viewerOverride` (B3 — stream takeover dismisses any
discrete-doc override), drops the matching `tabState` entry (R4 —
buffer reset invalidates the captured search.matches / select
references on the old buffer), and resets `slice.{search, select,
cursor}` for the auto-jump landing (R4 — user is now viewing the
fresh buffer).

**Unrouted accumulator (v0.6.2).** Without `{tabKey, groupName}`,
streams flow into `slice.viewerStreamBuffer` (a singleton ring
buffer, cap 1000) and the viewer's display home is the dedicated
**Transcript** tab at strip idx 1 (between Info and per-group
action tabs). The displayed lines derive from the buffer when on
Transcript; off-Transcript appends silently grow it. `stream_start`'s unrouted
auto-jump to Transcript also clears `viewerOverride` (B3); already-on-
Transcript appends preserve any pre-existing override (no transition).
`tab_switch` to Transcript restores from buffer with bottom-pin
scroll (empty → `[dim](no transcript yet)[/]` placeholder).
Spawn-launch and cmdline-verb status messages join the same buffer
via `appendViewerLines` (`panel/nav-state.js`; re-exported from `app/state.js`).

Per-action buffers and the Transcript buffer survive `tab_switch`;
producer lifetime is decoupled from tab visibility. `streamCommand`
maintains a per-slot proc map (`procs.set(jobId, ctx)` keyed by
`tabKey || 'unrouted'`) — concurrent routed streams across distinct
slots run side-by-side. Same-slot routed re-runs preempt silently;
cross-label unrouted preempts open a confirm overlay (default
reject) to protect the live transcript. Stream-end footers
(`Press Enter to run again.`) are stamped via batched
`viewer_append_lines` for atomic reducer passes.

**Per-tab view state (T3).** `slice.{scroll, search, select, cursor}`
are the active-tab live view; their off-tab persistence lives in
`slice.tabState`, keyed by stable identity (`'info'`, `'transcript'`,
`'<group>:action:<key>'`, `'<group>:terminal:<key>'`,
`'<group>:content:<key>'` — resolved via the canonical
`pane-tabs.resolveTabKey` (N1 — single source of truth, called by
both the finalizer's leaving capture and the inbound-restore arms;
viewer.js's `_activeTabKey` is a thin delegate). Per-group kinds
carry the group prefix (B4) so two groups sharing an action name
don't collide; Info / Transcript stay unprefixed (Info is
per-focus, Transcript is the singleton accumulator). String keys
outlive numeric idx: adding/removing a content tab renumbers the
strip but leaves stored entries correctly addressed.

A consequence of the unprefixed Info / Transcript keys: their saved
view state is global, not per-group. The user's last-seen Info
scroll is MRU across groups — switching to group B, scrolling
Info, switching back to group A → Info's scroll is B's, not A's.
This matches the "Info is per-focus" framing (the displayed
content already depends on the focused Navigator's item, which
changes across groups). If per-group Info bookkeeping is wanted
later, prefix the key the same way per-group kinds do.

*Capture (leaving).* The viewer's finalizer (`_withDerivedFields`)
is the single sync point. Post-reducer, when `next.tab !==
originalSlice.tab`, the leaving tab's `{scroll, bottomSticky, search,
select, cursor}` is captured into `tabState[fromKey]`. Two
carve-outs:
  - Skip when `originalSlice.viewerOverride` was active (B2):
    override-bound view state is per-doc, not per-tab — capturing
    it would clobber the pre-override saved state.
  - Skip when the leaving tab was REMOVED in this same Msg (R5):
    `removeContent` / `removeEphemeral` drop the matching
    `tabState` entry and suppress the would-be re-capture (the
    finalizer checks `_tabKeyExistsIn(next, model, fromKey)` against
    next's content/ephemeral stores).

*Restore (entering).* Three reducer arms handle restore depending
on the kind of transition:
  - `pane-tabs.tab_switch` (user click / `tab_cycle`) — full
    kind-specific cascade: restore `tabState[toKey]`, clear
    `viewerOverride`, emit `terminal_exit`, handle `bottomSticky`
    tail-tracking for live-stream tabs.
  - `viewer.viewer_set_tab` (producer-initiated set-tab; history
    replay, docker pre-stream) — restore `tabState[toKey]` minus
    the cascade side effects. Skipped when `slice.viewerOverride`
    is active (the override owns the view state; restoring
    `tabState['info'].scroll` over the override's committed
    `scroll: 0` would clobber the producer's setup).
  - `viewer.viewer_show_info` (navSelect cascade) — restore
    `tabState['info']` when transitioning to Info from another
    tab; within-Info navSelect resets scroll to 0 (new item, fresh
    content) without consulting `tabState`.

*Override hygiene.* `slice.viewerOverride` clears on every transition
that's "user-dismiss or producer-takeover": `tab_switch` (T2c),
`stream_start` auto-jump routed + unrouted (B3), `viewer_reset_chrome`
group switch (B3). It does NOT clear on `viewer_set_tab` (producer
just set override + tab together), `viewer_set_content` itself
(it's the override-writer), or in branches that don't transition
(cross-group `stream_start`, already-on-Transcript unrouted append).

Per-Msg mirrors are *not* maintained — lazy persistence, single
sync point per concern, identity-preserving.

**See also.**
- `docs/PRINCIPLES.md` §12 — the Component discipline rules.
- `docs/history/v0.5-layering.md` — single-writer + the blessed exceptions.
- `docs/history/v0.5-tea.md` — the TEA shape and the two-homes state framing.
