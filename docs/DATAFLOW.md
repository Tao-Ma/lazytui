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
   js/dispatch/input.js    js/io/stream.js     direct dispatchMsg
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
     apply_msg     → applyMsg     ─┐
     dispatch_msg  → dispatchMsg  ─┤ re-enter the spine
     tick(ms, msg) → setTimeout   ─┘ (cycle cap @ 32 deep)
     render        → scheduleRender (50ms debounce)
     setDetail / setActiveTab / focus / show_selected_info
     do_run / run_action / kill_proc / stream_action
     dockerFetch / dockerEventsStart / dockerExec / dockerShell
     loadDir / openFile
     cmdline_rebuild / cmdline_run / cmdline_clear
     destroy_pty_session / emit_osc52 / copy_commit
     force_full_repaint / quit / run_binding / menu_action
        │
        ▼
═══════════════════════════ STATE ══════════════════════════════════
   Root model (js/app/runtime.js, _modelRef.current)
     modes (13 modal flags)
     modal.{ filter, prompt, menu, confirm, copy, registerPopup, cmdline }
     currentGroup, config, register, prefixSeq, focused, ...

   Component slices (js/leaves/route.js, nested store)
     layout         focus, viewMode, arrange, panelBounds, design
     detail         lines, scroll, tab, search, select,
                    contentTabs, ephemeralTerminals
     groups         list, expanded:Set, tab
     docker         status, stats, inFlight, eventsStarted
     files          per-panel-type browsers
     config-status  tab, cache, branch, expanded
     nav[panelType] cursor, scroll, multiSel, filter
        │
        ▼
═══════════════════════════ RENDER ═════════════════════════════════
   render()                       (js/render/layout.js)
     1. calcLayout → panelHeights, panelBounds
        (fires keep-in-view set_scroll Msgs as a side output)
     2. for each panel in arrange:
          _safeRender( comp.render(panel, w, h, slice) )
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
The spine is *cyclic at the effects layer*: `apply_msg` /
`dispatch_msg` re-enter `applyMsg` / `dispatchMsg`, so one Msg can
ripple into a multi-step cascade (e.g. groups switch →
reset_group_context → 3× set_cursor + multisel_clear + clear_filter
+ viewer_reset_chrome). T28 caps depth at 32.

**Single-writer per layer is structural.** Only `runtime.update`
writes the root model; only each Component's own `update` writes its
slice. Cross-layer writes have a Msg channel (`apply_msg` /
`dispatch_msg`) — no path where module X writes layer Y's state
directly except the blessed view-output exceptions during render
(`panelBounds`, keep-in-view scroll).

**Sync vs debounced render.** The steady state is one sync `render()`
per keystroke at the tail of `dispatch.handleKey`. The 50 ms
`scheduleRender` debounce only fires for *async* producers (streamed
action output, docker poll, refresh ticks) so they coalesce bursts.

**See also.**
- `docs/PRINCIPLES.md` §12 — the Component discipline rules.
- `docs/v0.5-layering.md` — single-writer + the blessed exceptions.
- `docs/v0.5-tea.md` — the TEA shape and the two-homes state framing.
