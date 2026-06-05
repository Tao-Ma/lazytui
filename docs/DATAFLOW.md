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
   js/dispatch/input.js    js/dispatch/stream.js  direct dispatchMsg
   • SGR mouse parse        js/io/terminal.js   (from a setTimeout/
   • paste accumulator     • PTY mgmt            setImmediate cb)
        │
        ▼
════════════════════════════ DISPATCH ══════════════════════════════
   handleKey / handleMouse                (js/dispatch/dispatch.js)
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
   handleNormalKey switch ─→ handleAction ─→ applyMsg ──────┤
                                          ─→ dispatchMsg ───┤
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
   runEffects(effects)                 (js/dispatch/effects.js)
     msg           → applyMsg / dispatchMsg routed by msg.kind
                                       (cycle cap @ 32 deep; T28)
     tick(ms, msg) → setTimeout      (async re-entry; not depth-counted)
     render        → scheduleRender (50ms debounce)
     focus / show_selected_info / setActiveTab
     do_run / run_action
     dockerFetch / dockerEventsStart / dockerExec / dockerShell
     loadDir / openFile
     cmdline_rebuild / cmdline_run / cmdline_clear
     destroy_pty_session / emit_osc52 / copy_commit
     force_full_repaint / quit / run_binding / menu_action
        │
        ▼
═══════════════════════════ STATE ══════════════════════════════════
   Root model (js/app/runtime.js, _modelRef.current)
     modes (14 modal flags, incl. jobsMode for the Running overlay)
     modal.{ filter, prompt, menu, confirm, copy, registerPopup,
             cmdline, jobs }
     currentGroup, config, register, prefixSeq, focused, ...

   Component slices (js/leaves/route.js, nested store)
     layout         focus, viewMode, arrange, panelBounds, freeConfig
     detail         lines, scroll, tab, search, select, cursor,
                    contentTabs, ephemeralTerminals, actionTabBuffers,
                    viewerStreamBuffer, viewerOverride, tabState
     groups         list, expanded:Set, tab
     docker         status, stats, inFlight, eventsStarted
     files          per-panel-type browsers
     config-status  tab, cache, branch, expanded
     nav[panelType] cursor, scroll, multiSel, filter

   Out-of-TEA module-local stores (js/feature/*.js)
     history        completion log of every action that ran
     jobs           live state of every child lazytui spawned
                    (streams, PTYs, background, tmux). See
                    PRINCIPLES §12 for the slice-vs-module rule.
        │
        ▼
═══════════════════════════ RENDER ═════════════════════════════════
   render()                       (js/render/layout.js)
     1. calcLayout → panelHeights, panelBounds
        (fires keep-in-view set_scroll Msgs as a side output)
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

**Single-writer per layer is structural.** Only `runtime.update`
writes the root model; only each Component's own `update` writes its
slice. Cross-layer writes have a Msg channel (the `msg` Cmd — wrapped
payload fans out to a Component, flat payload re-enters the root
reducer) — no path where module X writes layer Y's state directly
except the blessed render-side exceptions:

  - `layout.panelHeights` / `panelBounds` written by `calcLayout` +
    each render-mode (the view-output geometry).
  - `panelBounds.detail.tabs` written by the viewer's `detailTitle`
    (tab-bar hit-test cache).
  - keep-in-view `set_scroll` Msgs from `syncPanelScroll` into each
    Navigator's nav slice (Msgs, not direct writes).
  - direct `route.setInstanceSlice` from `render()` into the viewer's
    `innerH` (viewport cache so viewer reducers don't read layout
    cross-slice; R4.9 retired the prior `viewer_set_viewport` Msg —
    the Msg's only effect was this single-field write, now done inline
    alongside the panelBounds writes).
  - `setImmediate(terminal_exit)` from `renderTerminalOverlay` when
    the active PTY session has exited (T14 — deferred a tick so the
    cleanup cascade isn't inline in the render path).

**Sync vs debounced render.** The steady state is one sync `render()`
per keystroke at the tail of `dispatch.handleKey`. The 50 ms
`scheduleRender` debounce only fires for *async* producers (streamed
action output, docker poll, refresh ticks) so they coalesce bursts.

**Routed stream Msgs.** `stream_start { header, tabKey?, groupName? }`
and `viewer_append { line, tabKey?, groupName? }` (+ bulk
`viewer_append_lines`) carry an optional routing key. With
`{tabKey, groupName}` set, the viewer reducer writes to
`slice.actionTabBuffers[groupName][tabKey].lines` and mirrors to
`slice.lines` only when the active tab is that action's
(`pt.activeActionTabIn`). `stream_start`'s routed path additionally
auto-jumps `slice.tab` to the action's index and emits
`terminal_exit` so `terminalMode` doesn't survive the jump.

**Unrouted accumulator (v0.6.2).** Without `{tabKey, groupName}`,
streams flow into `slice.viewerStreamBuffer` (a singleton ring
buffer, cap 1000) and the viewer's display home is the dedicated
**Transcript** tab at strip idx 1 (between Info and per-group
action tabs). Mirrors to `slice.lines` only when on Transcript;
off-Transcript appends silently grow the buffer. `tab_switch` to
Transcript restores from buffer with bottom-pin scroll (empty →
`[dim](no transcript yet)[/]` placeholder). Spawn-launch and
cmdline-verb status messages join the same buffer via
`appendViewerLines` (`app/state.js`).

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
`'<group>:content:<key>'` — resolved via `_activeTabKey`). Per-group
kinds carry the group prefix (B4) so two groups sharing an action
name don't collide; Info / Transcript stay unprefixed (Info is
per-focus, Transcript is the singleton accumulator). String keys
outlive numeric idx: adding/removing
a content tab renumbers the strip but leaves stored entries correctly
addressed. The sync point is the viewer's finalizer
(`_withDerivedFields`) — post-reducer, when
`next.tab !== originalSlice.tab`, the leaving tab's
`{scroll, bottomSticky, search, select, cursor}` is captured into
`tabState[fromKey]`. Single site catches every `slice.tab` transition:
`tab_switch`, `stream_start`'s auto-jump (routed + unrouted), and the
`viewer_set_tab` primitive (called from `setActiveTab()` in
`panel/api.js`). Restore happens in `pane-tabs.tab_switch` reducer
body (reads `tabState[toKey]` into `slice.{scroll, search, select,
cursor}`); the `bottomSticky` bit distinguishes "literal restore"
from "tail-track to the new bottom" for live-stream tabs.
Per-Msg mirrors are *not* maintained — lazy persistence, single sync
point, identity-preserving.

**See also.**
- `docs/PRINCIPLES.md` §12 — the Component discipline rules.
- `docs/v0.5-layering.md` — single-writer + the blessed exceptions.
- `docs/v0.5-tea.md` — the TEA shape and the two-homes state framing.
