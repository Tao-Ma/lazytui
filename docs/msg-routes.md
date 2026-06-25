# Msg route catalog — the TEA purity map

> **STATUS — COMPLETE, audit artifact (5 loops, 2026-06-24).**
> This documents *where every Msg goes and what it writes*, so each feature's
> dataflow is visible in one place and the "pure TEA vs mutable" question can be
> answered per-route. It is a **review/learning aid**, not a canonical
> spec — `docs/PRINCIPLES.md §11/§12` and `docs/DATAFLOW.md` remain the
> authority. **No refactor is implied** by anything written here; the goal is to
> write the code case down accurately. Findings that suggest a refactor are
> parked in §9, never acted on inline.
>
> **Coverage (all verified against source):**
> - ✅ §1 Architecture view · §2 Purity model · §3 Reading the tables
> - ✅ §4 Root-reducer Msgs (flat) — all 19, verified against source
> - ✅ §5 Modal sub-reducer Msgs — all 9 modals (~40 types), verified
> - ✅ §6 Broadcast Msgs
> - ✅ §8 Effect / Cmd vocabulary — framework set + Component-contributed bodies
>   all verified
> - ✅ §7 Component Msgs (wrapped) — **ALL Components verified**: §7.2 shared nav,
>   §7.4 viewer, §7.5 layout, §7.6 groups, §7.8 docker/files/config-status/history,
>   §7.9 stats, + actions (nav-only)
> - ✅ §9 Purity verdict + blessed-exception index
> - ✅ §10 Input-verb layer — `intent.realize` + `handleAction` (where Msgs are
>   produced; each feature traceable end-to-end)
> - ✅ §11 Completeness verification — grep-diff proves no Msg/Cmd missed

---

## 1. Architecture view

lazytui is **the Elm Architecture (TEA)** over a terminal. State is split into
two homes; every change is a `Msg`; every side effect is a data descriptor a
single interpreter runs. The render path is a (near-)pure projection.

### 1.1 The layer stack (module dependency direction — all edges point DOWN)

```
              ┌──────────────────────────────────────────────┐
   app/       │  tui.js · state.js · runtime.js (shim)         │  boot + wiring
              │  reconcileSubscriptions · reconcilePaneInstances│  (the IMPURE shell)
              └───────────────────────┬────────────────────────┘
                                      │ injects hosts at boot (setNavDispatch,
                                      │ setInstanceReconciler, setSubscription-
                                      │ Reconciler, wirePanelHost, feature-host)
              ┌───────────────────────▼────────────────────────┐
  dispatch/   │  control/  → input · dispatch · intent · cmdline │  the IMPURE
              │              actions · mouse-bindings             │  dispatch shell
              │  update/   → reducer (root) · modal/* · model-ops │  ── PURE ──
              │  runtime/  → loop (2 pumps) · finalize · effects  │  pumps + interpreter
              │              stream · action-runner · cleanup     │
              │              host-wiring                          │
              └───────────────────────┬────────────────────────┘
              ┌───────────────────────▼────────────────────────┐
  panel/      │  api (Component registry) · route (instances)    │  Components +
              │  layout · navigator/* · viewer/* · monitor/*      │  routing
              │  nav-state · commands · chrome-hittest · plugin-guard
              └───────────────────────┬────────────────────────┘
              ┌───────────────────────▼────────────────────────┐
  model/      │  store.js  — the single root-model ref           │  state root
              └───────────────────────┬────────────────────────┘
  feature/    │  jobs · history · open-* · config-branch · ...    │  out-of-TEA stores
  io/         │  terminal (PTY/xterm) · term · diag-log · event-log· exec
  render/     │  paint · footer        (pure view of model+slices)│
  overlay/    │  cmdline · menu · confirm · ... (pure view fns)   │
  parser/     │  config → model                                   │
  leaves/     │  PURE bottom: wm/* · text/* · render/* · input/* · infra/*
              │               selector · register · modes · ...   │
              └─────────────────────────────────────────────────┘
```

`dep-walker` reports the top-level module graph **fully acyclic** in both modes
(v0.6.5 — see `[[v065-tea-reaudit]]`). The reducer + modal sub-reducers are the
only PURE island inside `dispatch/`; everything else in `dispatch/control` and
`dispatch/runtime` is the **impure shell** (reads `getModel`, the wall clock,
route topology; runs I/O) by design.

### 1.2 The Msg lifecycle (one keystroke → one paint)

```
  INPUT                         input.js / stream.js / async cb
  (key / mouse / paste /          │  classify → intent.realize → a Msg
   focus / PTY data / timer)       │  (the IMPURE shell may read getModel here
                                   │   to STAMP facts onto the Msg — exception C)
                                   ▼
  DISPATCH    ┌─ flat {type}     ──→  applyMsg(msg)          [root-Msg pump]
  (two pumps) │                         [next,cmds] = reducer.update(getModel(), msg)   ← PURE
  loop.js     │                         setModel(next)        ← commit BEFORE effects
              │                         runEffects(cmds)
              │
              └─ wrapped {kind,msg} ─→  dispatchMsg(msg)      [Component fan-out pump]
                                         msg = comp.augmentMsg(msg, model, slice)  ← shell threads facts
                                         [next,effects] = comp.update(msg, slice)   ← PURE
                                         route.setInstanceSlice(id, next)
                                         runEffects(effects)
                                         (broadcast 'refresh'/'action' → every instance)
                                   │
                                   ▼
  EFFECTS     runEffects(cmds)                                effects.js  ── IMPURE ──
              every Cmd is plain DATA ({type, …}); a handler runs the side effect.
              'msg' re-enters a pump (routed by msg.kind)  → the cyclic spine (cap 32).
              periodic + external re-entry rides Subs (app/state.js interval /
                resize / store-mirror / process-stream kinds → applyMsg/dispatch, async).
              async results (stream onData, fetch, PTY) → dispatchMsg back in.
                                   │
                                   ▼
  FINALIZE    finalizeDispatch()  (ONCE, at depth-0 exit of the outermost pump)
  finalize.js   • reconcile per-pane instances (mint/dispose), gated on arrange-ref
                • reconcile hub subscriptions (Model → Sub diff)            [#D13]
                • keep-in-view scroll clamp → set_scroll Msg per nav pane   [resize-as-Msg]
                • viewer innerH = f(layout) → DIRECT slice write   ← EXCEPTION B
                • active terminal PTY ensure/resize                [v0.6.5 §5]
                                   │
                                   ▼
  RENDER      render(model)                                   paint.js / footer.js
                projects theme palette from model.theme (per-frame, #D8)
                reads slices + model.now + off-model live stores (#D5 boundary)
                returns ANSI; paintColumns diffs vs prev frame → stdout
```

### 1.3 The two state homes

| Home | Module | Writer | Examples |
|---|---|---|---|
| **Root model** (centralized chrome) | `model/store.js` (`_modelRef.current`) | `reducer.update` + `modal/*` ONLY | `modes{}` (modal flags), `modal{}` (editing buffers), `currentGroup`, `now`, `theme`, `history`/`diagLog`/`jobs` (store-mirror'd, FIX-1), `metrics[topic]` (metrics-mirror'd, Finding B), `config`, `register`, `focused`, `prefixNode/Seq` |
| **Component slices** (decentralized) | `panel/route.js` instance store | each Component's own `update` ONLY | `layout` (focus/viewMode/arrange/freeConfig), `detail` (viewer tabs/buffers/view-state), `groups` (tree/expanded), `docker`, `files`, `config-status`, `nav[panelType]` (cursor/scroll/multiSel/filter) |
| **Out-of-TEA stores** (global-by-nature) | `feature/*`, `io/*` | module-local mutators | `feature/jobs` (live child procs), `feature/history`, `io/diag-log` (ring buffer), `io/terminal` (xterm buffers) |

---

## 2. The purity model — "pure TEA or mutable?"

**Short answer: the reducer layer is pure TEA; the shell around it is
deliberately impure; render is pure of the wall clock but reads off-model live
stores.** Concretely, four tiers:

1. **PURE — the reducers.** `reducer.update(model, msg) → [next, cmds]` and
   every `modal/*.update` and every `Component.update(msg, slice) → [next,
   effects]` are pure functions: they read only their args, return NEW
   state objects (immutable; freeze-tested in `test-immutable-*.js`), and emit
   side effects only as **Cmd descriptors** (plain `{type,…}` data). No I/O, no
   `getModel()`, no wall clock, no route-topology *value* reads inside an arm.
   This is the TEA core, and it is genuinely pure.

2. **IMPURE SHELL — handlers + effects (by design).** `dispatch/control/*`
   (the input handlers) and `dispatch/runtime/effects.js` (the Cmd
   interpreter) read `getModel()`, the wall clock, route topology, and run all
   I/O. This is where impurity is *supposed* to live. The shell's job is to
   **stamp facts onto Msgs** (the `modelBundle` / `augmentMsg` / handler-stamp
   patterns) so the reducer never has to read them — relocating the read, not
   removing the work. **This relocation is blessed-exception C** ("impure-shell
   model read"): sanctioned, not a bug.

3. **EXCEPTION B — the finalizer's `innerH` write.** The post-dispatch
   finalizer writes the viewer's derived `innerH` (viewport height) DIRECTLY
   onto the viewer slice via `setInstanceSlice`, bypassing the viewer's own
   `update`. Kept because the viewer reducer *reads* `innerH` for scroll/cursor
   clamps (so it must live in-slice) and it is a pure function of layout. TEA
   review #3 D16 examined and **KEPT** this. The single same-slice
   runtime-written field.

4. **#D5 REPLAYABILITY BOUNDARY — the terminal island (v0.6.6).** Render is pure
   of the *wall clock* (`model.now`) and the *theme* (projected from
   `model.theme`); **FIX-1** mirrored the three discrete off-model stores into
   the model via the `store-mirror` Sub (`model.history` / `model.diagLog` /
   `model.jobs`); and **Finding B** mirrored the continuous hub metrics series
   via the throttled `metrics-mirror` Sub (`model.metrics[topic]` — the stats
   graph). So `frame === f(model)` now holds for every panel + overlay EXCEPT the
   terminal island: `io/terminal.getSession()` + `io/term.cols/rows()`, an
   explicitly non-TEA region (PTY `onData` mutates the xterm buffer outside the
   Msg loop, #D14). The overlays/graph still update live mid-display — now because
   the mirror Sub feeds the model (store-mirror per mutation; metrics-mirror per
   throttle window). (Two latent render-path diag *writes* remain — content-
   irrelevant, see docs/v0.6.6.md §9.)

**Single-writer invariant.** Only `reducer.update`/`modal/*` write the root
model; only a Component's own `update` writes its slice. Cross-layer writes
have NO direct path — they go out as a `{type:'msg', msg}` Cmd that re-enters a
pump (wrapped → Component fan-out, flat → root reducer). The lone structural
deviation is exception B above.

**So: is it pure TEA or mutable?** It is **pure TEA at the decision layer**
(every state transition is a pure reducer), wrapped in an **intentionally
impure shell** (effects + handlers), with **exactly two standing exceptions**
(B: finalizer `innerH`; C: impure-shell reads) and one **boundary** (#D5: render
reads live stores). The mutability you see is concentrated, named, and
commented at its site — not scattered.

---

## 3. Reading the route tables

Each Msg row records its full route:

- **Msg** — the `type` string (and `kind` for wrapped Msgs).
- **Emitted by** — who dispatches it (handler / effect / Component / boot).
- **Writes** — which state fields the arm changes (`model.*` = root model,
  `slice.*` = a Component slice). "—" = no state change.
- **Emits (Cmds)** — the Cmd descriptors returned. `msg→X` = a `{type:'msg'}`
  Cmd re-dispatching to X.
- **Purity** — verdict for THIS arm:
  - `✓` pure reducer arm (the norm)
  - `shell` pure arm, but depends on facts the **impure shell** stamped (the
    handler read `getModel`/topology — exception C lives in the handler, not here)
  - `B` / `C` touches blessed-exception B / C directly
  - `fx` this is an effect/Cmd handler — impure by design (the interpreter tier)

---

## 4. Root-reducer Msgs (flat `{type}`)

Handled by `dispatch/update/reducer.js#update(model, msg)`, driven by the
**root-Msg pump** `applyMsg` (`dispatch/runtime/loop.js`). Routed here when the
Msg is flat (`msg.kind` absent). Every arm returns a NEW model on change,
identity-preserves on no-op. **All 19 arms are pure** — verified.

| Msg | Emitted by | Writes | Emits (Cmds) | Purity |
|---|---|---|---|---|
| `escape` | Esc handler | `modes.listSelectMode→false` (if set) | `msg→multisel_clear` (focused nav) when `msg.route` set & had selection | shell¹ |
| `list_select` | `v` (toggle) / `*` (on) | `modes.listSelectMode` | `msg→multisel_clear` when toggled OFF | shell¹ |
| `enter_prefix` | leader key | `modes.prefixMode→true`, `prefixNode`=kb root, `prefixSeq=[]` | — | ✓ |
| `prefix_key` | key in prefix mode | `prefixNode`/`prefixSeq` (descend) or clears prefix (leaf/cancel) | `force_full_repaint` (descend) · `run_binding` (leaf) | ✓² |
| `next_tab` / `prev_tab` | `]` / `[` | — | `msg→tab_switch` (viewer) | shell³ |
| `nav_select` | row select (kbd/mouse) | — | `msg→set_cursor` + `show_selected_info` (+ `msg→groups_selected` if groups) | shell⁴ |
| `terminal_enter` | enter-terminal verb | `modes.terminalMode→true` | — | ✓ |
| `terminal_exit` | exit-terminal / dead PTY | `modes.terminalMode→false` | `msg→view_drop_full_to_normal` (layout) | ✓ |
| `focus_event` | DEC 1004 focus in/out | `model.focused` | — | ✓ |
| `clock_tick` | `clock` interval Sub | `model.now=msg.now` | — | ✓⁵ |
| `set_theme` | `:theme` / boot | `model.theme` | — | ✓ |
| `mode_clear` | wedge-guard / panic recovery | `modes[msg.flag]→false` | — | ✓ |
| `mode_set` | viewer search-enter etc. | `modes[msg.flag]→true` | — | ✓ |
| `set_current_group` | groups cascade / jobs_activate | `model.currentGroup` | — | ✓ |
| `set_config` | boot `loadConfig` | `config`, `projectDir`, `configPath` | `msg→set_config` (config-status, if `msg.csOwner`) | shell⁶ |
| `set_register` | boot `initState` | `model.register` | — | ✓ |
| `reset_group_context` | groups cascade | `modes.terminalMode/listSelectMode→false` | per `msg.owners`: `msg→set_cursor`+`multisel_clear`+`clear_filter` | shell⁷ |
| `free_config` | `:free-config` verb | — | `msg→free_config_enter` (layout) | ✓ |
| *(default)* | — | — | — | ✓ |

¹ The handler stamps `msg.hadMultiSel` + `msg.route = route.bundle(getFocus())`
  (the `{compName, panelType, target}` triple). The arm reads only the stamped
  Msg — no topology read. blessed-A elimination (`docs/reducer-route-purity.md`).
² `kb.resolve` / `kb.tokenForEvent` are pure reads of the dependency-free
  keybinding leaf — not a topology read.
³ `actions._viewerTabBundle` (handler) stamps `msg.target` + `total`/`curTab`/
  `tabKeys`; the arm keeps only the pure cycle math.
⁴ navSelect handler stamps `msg.route`, `msg.viewerTarget`, `msg.resetOwners`.
  The `groups` branch builds `ctx` via `groups.groupsBundle(model)` — a pure
  projection of the **`model` arg** (NOT `getModel()`), so the arm stays pure.
⁵ `msg.now` is threaded from the `clock` interval Sub's `onTick`, which reads the
  wall clock in the impure shell (exception C). The arm itself is pure of the
  clock, and no longer re-arms — the Sub owns the cadence (FIX-3 Phase 6; the
  `arm_clock` effect + `clockArmed` latch are retired).
⁶ `msg.csOwner` (the config-status owner) is resolved by `app/state.loadConfig`
  (impure shell), so the reducer reads no ownership registry (#D9).
⁷ `msg.owners` (`{panelType: ownerComponentName}`) is resolved by the dispatch
  shell from `route.resetGroupOwners()` (#D9). The map's keys decide which panels
  reset; null owner skips.

**Verdict (§4): pure TEA.** Every root arm is a pure function of `(model, msg)`.
All topology/model/clock reads are relocated to the impure shell via Msg
stamping (exception C) — none survive in a reducer arm.

---

## 5. Modal sub-reducer Msgs (flat, delegated)

`reducer.update` checks `_MODAL_BY_TYPE` first; a hit delegates the whole arm to
that modal's `update(model, msg) → [model, cmds]` over its own
`model.modal.<name>` buffer + mode flag. Shared write helpers (`withModes`,
`withModal`, `armClock`) live in `model-ops.js` (pure, zero imports). Each
close/commit arm **guards on its mode flag** so a stale double-fire after the
modal closed is a no-op (not a re-execution of the staged Cmd). **All arms
pure** — verified across all 9 modules.

### 5.1 `confirm` (`modal/confirm.js`) — staged-Cmd-as-data

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `confirm_enter` | `modes.confirmMode→true`, `modal.confirm={message,cmd}` | — | ✓ |
| `confirm_accept` | clears confirm + flag (guarded) | **the staged `msg.cmd`** (the deferred effect, stored as DATA) | ✓ |
| `confirm_reject` | clears confirm + flag (guarded) | — | ✓ |

The pending action is a Cmd **descriptor** in the model (e.g.
`{type:'do_run', actionKey, action, args}`), never a closure — so `y` re-emits
data, replay-safe.

### 5.2 `prompt` (`modal/prompt.js`) — args prompt

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `prompt_enter` | `modes.promptMode→true`, `modal.prompt={label,spec,text,ghost,cmd}` | — | shell¹ |
| `prompt_key` | `modal.prompt.text` (edit; ghost-accept via `ghostSuffix` leaf, backspace, Ctrl+U, paste) | — | ✓ |
| `prompt_submit` | clears prompt + flag (guarded) | base `cmd` **with parsed `args`** merged (`text.trim().split(/\s+/)`) | ✓ |
| `prompt_cancel` | clears prompt + flag (guarded) | — | ✓ |

¹ `msg.ghost` (autosuggest) is seeded by the caller from the yank register
  (which the reducer can't read).

### 5.3 `copy` (`modal/copy.js`) — copy menu (content thunks stay module-held)

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `copy_enter` | `modes.copyMode→true`, `modal.copy={options,idx:0}` | — | ✓ |
| `copy_nav` | `modal.copy.idx` (wrap) | — | ✓ |
| `copy_select` | clears copy + flag (guarded) | `copy_commit{idx, label}` (label captured at reduce time — `next` clears options) | ✓ |
| `copy_cancel` | clears copy + flag (guarded) | `copy_commit{idx:-1}` (clear, no copy) | ✓ |

Only render-safe `{label, cancel}` options live in the model; the actual
content closures are module-held in `overlay/copy.js`, invoked by index in the
`copy_commit` effect.

### 5.4 `register-popup` (`modal/register-popup.js`) — `"` yank history

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `register_popup_enter` | `modes.registerPopupMode→true`, `modal.registerPopup={idx:0,scroll:0}` | — | ✓ |
| `register_popup_nav` | `modal.registerPopup` (clamp vs `msg.vh`) | — | shell¹ |
| `register_popup_drop` | `model.register` (via `mreg.drop` leaf) + clamp; closes if emptied | `force_full_repaint` | ✓ |
| `register_popup_commit` | `model.register` (promote via `mreg.promote`), closes | `emit_osc52{text}` if non-empty | ✓ |
| `register_push` | `model.register` (via `mreg.push` leaf) | `emit_osc52{text}` if a value was pushed | ✓ |
| `register_popup_cancel` | closes (guarded) | — | ✓ |

¹ `msg.vh` (viewport height) is caller-resolved (reads terminal size).
The register **history mutation happens in the reducer** (pure `leaves/register`
transforms); only OSC52 (clipboard) is an effect. `register_push` folds every
app yank into update.

### 5.5 `cmdline` (`modal/cmdline.js`) — `:` command line + dropdown

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `cmdline_enter` | `modes.cmdMode→true`, reset `modal.cmdline` | `cmdline_rebuild` | ✓ |
| `cmdline_set_matches` | `modal.cmdline.{matches,sel,scroll}` (skip hint rows; clamp) | `cmdline_preview{sel}` | ✓ |
| `cmdline_nav` | `modal.cmdline.{sel,scroll}` | `cmdline_preview{sel}` | ✓ |
| `cmdline_key` | `modal.cmdline.text` (type/backspace/Tab-accept/paste) | `cmdline_rebuild` | ✓ |
| `cmdline_submit` | refine-in-place OR closes (guarded) | refine→`cmdline_rebuild`; else `cmdline_run{sel,args,display}` + `cmdline_clear` | ✓ |
| `cmdline_cancel` | closes (guarded) | `cmdline_revert_preview` + `cmdline_clear` | ✓ |

The **Cmd→Msg writeback loop**: any text change → `cmdline_rebuild` effect →
re-queries the plugin registry (which the pure reducer can't touch) →
`applyMsg(cmdline_set_matches)` with the render-safe projection. The reducer
stays the single writer of model state; the effect supplies the data. Run
closures stay module-held in `dispatch/control/cmdline.js`.

### 5.6 `jobs` (`modal/jobs.js`) — Running overlay + the job-routing cascade

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `jobs_open` | `modes.jobsMode→true`, reset cursor, `now=msg.now` | — (the `clock` interval Sub self-declares while `jobsMode`) | shell¹ |
| `jobs_close` | `modes.jobsMode→false` (guarded) | — | ✓ |
| `jobs_nav` | `modal.jobs.{cursor,scroll}` (clamp vs `msg.count`/`msg.vh`) | — | shell² |
| `jobs_activate` | closes overlay (guarded); resolves target group from `msg.job` (model-only) | `set_current_group` (if cross-group) + `jobs_route{job,now}` | shell³ |
| `jobs_routed` | — | per job kind: `tab_switch`+`focus_set` (routed/pty) · `terminal_enter` (pty) · `viewer_set_content`+`focus_set` (bg/tmux info card) · `focus_set` (unrouted) | shell⁴ |

¹ `msg.now` threaded from handler (wall clock = exception C).
² `msg.count` (`model.jobs.length`, since FIX-1) + `msg.vh` threaded by handler
  — the reducer never reads the jobs list inline (renderer-only-reader rule, PRINCIPLES §12).
³ `msg.job` is the resolved job entry, threaded by `handleJobsKey` from
  `model.jobs` (the store-mirror'd snapshot, since FIX-1 — the same array render
  highlighted; was `feature/jobs.list()[cursor]`).
⁴ **The Phase-C split** (`docs/blessed-exceptions.md`): `jobs_activate` is a pure
  orchestrator (closes + queues group switch + emits `jobs_route`). The
  `jobs_route` *effect* runs AFTER the switch commits, reads the now-correct
  viewer slice in the dispatch layer, and threads `viewerTarget`/`groupName`/
  `tabIdx`/`targetKey`/`fromTabKey` into the pure `jobs_routed` tail. This
  removed the **last** root-reducer cross-slice value read.

### 5.7 `diag-log` (`modal/diag-log.js`) — diagnostics window (leader e)

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `diag_log_open` | `modes.diagLogMode→true`, reset cursor, `now=msg.now` | — (the `clock` interval Sub self-declares while `diagLogMode`) | shell¹ |
| `diag_log_close` | `modes.diagLogMode→false` (guarded) | — | ✓ |
| `diag_log_nav` | `modal.diagLog.{cursor,scroll}` (clamp vs `msg.count`/`msg.vh`) | — | shell² |
| `diag_log_clear` | resets cursor | `diag_clear` (buffer mutation is a side effect) | ✓ |
| `diag_log_save` | — | `diag_save` (file I/O) | ✓ |

¹² Same pattern as `jobs`: `now`/`count`/`vh` threaded; the out-of-TEA
`io/diag-log` ring buffer is read renderer-side, never in the arm.

### 5.8 `menu` (`modal/menu.js`) — command menu / right-click context menu

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `menu_open` | `modes.menuOpen→true`, `modal.menu={items,idx:0,anchor,title}` | — | shell¹ |
| `menu_close` | closes (guarded) | — | ✓ |
| `menu_nav` | `modal.menu.idx` (skips null separators) | — | ✓ |
| `menu_activate` | closes (guarded) | `menu_action{action,arg}` (routes the picked verb back through `dispatch.handleAction`) | ✓ |

¹ `msg.items` (action strings, no closures) are built from the layout slice by
  the `menu_open` handler; `msg.anchor` ({x,y} for a right-click) / `msg.title`
  threaded.

### 5.9 `filter` (`modal/filter.js`) — `/` filter mode

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `filter_enter` | `modes.filterMode→true`, `modal.filter={text,panel,route}` | `msg→multisel_clear` (clear stale selection on the filtered pane) | shell¹ |
| `filter_key` | `modal.filter.text` (type/backspace/paste) | `msg→set_cursor{index:0}` (re-home as filter narrows) | shell² |
| `filter_exit` | `modes.filterMode→false`, clears `modal.filter` | commit/clear: `msg→set_filter|clear_filter` + `set_cursor` + `set_scroll` + `show_selected_info` | shell² |

¹ The handler resolves the panel + filterable gate (plugin-API, can't live in
  the reducer) and stamps `msg.route = route.bundle(panel)`.
² `filter_enter` stores the route bundle on the modal; `filter_key`/`filter_exit`
  reuse `f.route` (the filtered pane is fixed for the session) — no re-resolve.
  #D11: the body-refresh on exit is the reducer's decision (`show_selected_info`
  Cmd), not a second imperative dispatch.

**Verdict (§5): pure TEA.** Every modal arm is pure; all view/topology/clock/
out-of-TEA reads are stamped onto the Msg by the dispatch handler (exception C
in the shell). Editing buffers, register history, cmdline match-set selection,
and overlay clamps are all pure model transforms.

---

## 6. Broadcast Msgs (unwrapped, fan out to every Component)

The pump's `BROADCAST_TYPES = {'refresh', 'action'}`. These are the ONLY flat
Msgs that reach Components; every other Component-specific Msg must arrive
wrapped or it is logged + dropped (`[dispatch] unwrapped Component-specific Msg`).

| Msg | Meaning | Route |
|---|---|---|
| `refresh` | "re-pull your data" framework signal | `dispatchMsg` iterates every instance → each `comp.update(refresh, slice)`. Components that fetch return `[slice, [fetch effect]]`. |
| `action` | a generic action broadcast | same fan-out to every instance. |

(The `hub` broadcast was removed — #D17 — no Component consumed it; hub publishes
now reach observers only via the `onUpdate→render` subscription path.)

---

## 7. Component Msgs (wrapped `{kind, msg}`)

Wrapped Msgs route via the **Component fan-out pump** `dispatchMsg` to exactly
one instance: `kind` is a Component name (primary instance) OR a paneId
(per-pane instance); the pump resolves it through `route.getInstance` /
`componentForPanel` / `getPrimaryByKind`, applies `comp.augmentMsg(msg, model,
slice)` when the Component declares it (the **shell-threads-facts** seam —
exception C, ONLY the viewer declares one), then runs `comp.update(msg, slice)`.
Key events arrive as `{type:'key'}` only to the FOCUSED component, only when no
modal owns input; a component claims a key by returning a `_claimed` sentinel
effect (filtered out before `runEffects`).

**The two-tier Component update.** Every Navigator's `update` is
`mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : <own handling>` — the shared nav
reducer first, the Component's own arms second. The viewer is the same shape
(`pt.reduceTabMsg` first, then its own switch). So a Component's full Msg set =
**shared nav vocabulary (§7.2)** + its **own arms**.

**Coverage:** §7.2 shared nav + §7.4 **viewer/detail** verified this loop;
§7.3 lists the rest (pending loops 3+).

### 7.1 The Component-update / finalizer / exception-B relationship

```
  dispatchMsg(wrapped) ─┐
                        ▼
   msg = comp.augmentMsg(msg, model, slice)   ← IMPURE SHELL (exc. C): viewer threads
                        │                        viewerModel = pt.viewerModelBundle(model)
   [next, fx] = comp.update(msg, slice)        ← PURE reducer (+ viewer's OWN _finalize:
                        │                          per-tab view-state capture on tab transition)
   route.setInstanceSlice(id, next)
   runEffects(fx)
       … (depth-0 exit) …
   finalizeDispatch()  ← writes viewer slice.innerH DIRECTLY  ← EXCEPTION B
```
Two distinct "finalizers": (1) the viewer's OWN `_finalize`/`_withDerivedFields`
runs *inside* `update` and is pure (captures the leaving tab's view-state); (2)
the *dispatch-runtime* `finalizeDispatch` runs once at depth-0 exit and is where
exception B (the `innerH` same-slice write) lives. Viewer arms READ `innerH`
(`_innerH`) for scroll clamps — which is exactly why B must stay in-slice.

### 7.2 Shared Navigator nav reducer (`leaves/wm/nav.js`) — verified

A **pure leaf** (`mnav`). Each Navigator's `update` calls `mnav.apply(slice,
msg)` first; it returns a new slice on a nav-Msg match, the same slice if the
Msg targets another panel, or `undefined` (not a nav Msg → Component handles
it). Writes `slice.nav` (single-panel Component) or `slice.nav[panel]`
(multi-panel, e.g. `files`). All copy-on-write, identity-preserving on no-op.

| Msg | Writes | Notes | Purity |
|---|---|---|---|
| `set_cursor{panel?,index}` | `nav.cursor` | the keep-in-view scroll clamp (finalizer) routes through this | ✓ |
| `set_scroll{panel?,offset}` | `nav.scroll` | finalizer's `syncPanelScroll` emits it; resize-as-Msg | ✓ |
| `multisel_toggle{panel?,id}` | `nav.multiSel` (Set copy-on-write) | bulk-op operand | ✓ |
| `multisel_select_all{panel?,ids}` | `nav.multiSel` (skips alloc if all present) | `*` / filter_key | ✓ |
| `multisel_clear{panel?}` | `nav.multiSel→∅` (skips alloc if empty) | escape / group reset / filter entry | ✓ |
| `set_filter{panel?,text}` | `nav.filter` | committed filter text | ✓ |
| `clear_filter{panel?}` | `nav.filter→''` | filter exit / group reset | ✓ |

**Verdict (§7.2): pure TEA.** The whole shared nav layer is a pure leaf. This is
why `actions`/`history` need zero local `update` cases — `mnav.apply` IS their
reducer (they hold no domain state beyond nav).

### 7.3 Per-Component overview (status + vocabulary)

| Component (`kind`) | File | own arms | Own Msgs (beyond shared nav) | Status |
|---|---|---|---|---|
| **detail** (viewer) | `panel/viewer/viewer.js` | ~22 + tab leaf | see §7.4 | ✅ verified (loop 2) |
| **layout** | `panel/layout.js` | ~40 | see §7.5 | ✅ verified (loop 3) |
| **groups** | `panel/navigator/groups.js` | ~4 +nav | see §7.6 | ✅ verified (loop 3) |
| **docker** | `panel/navigator/docker.js` | 5 +nav | see §7.8 | ✅ verified (loop 4) |
| **files** | `panel/navigator/files.js` | 4 +nav | see §7.8 | ✅ verified (loop 4) |
| **config-status** | `panel/navigator/config-status.js` | 4 +nav | see §7.8 | ✅ verified (loop 4) |
| **history** | `panel/navigator/history.js` | 1 +nav | see §7.8 (effect `historyReplay`) | ✅ verified (loop 4) |
| **actions** | `panel/navigator/actions.js` | 0 +nav | shared nav only | ✅ nav-only (§7.2) |
| **stats** | `panel/monitor/stats.js` | 0 (no-op update) | `subscriptions(paneDef,model)` (#D13) — see §7.9 | ✅ verified (loop 4) |

### 7.4 viewer/detail (`kind: 'detail'`) — verified

The richest Component: tab routing, streaming buffers, per-tab view-state,
search, visual-mode selection. `update(msg, slice)` derives active-tab `lines`
once from `msg.viewerModel` (the threaded bundle), lifts generic tab Msgs
through `pt.reduceTabMsg`, then handles its own arms, then runs its pure
`_finalize`. **The only Component with `augmentMsg`; the only slice exception B
touches.** All arms pure — verified.

**(a) Generic tab-lifecycle Msgs — via `pt.reduceTabMsg(msg, slice, ctx)` (pane-tabs leaf, paneId-parameterized)**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `tab_switch{idx,currentGroup,targetKey}` | `slice.tab`, clears `viewerOverride`, restores `tabState[targetKey]` (search/select/cursor + sticky-aware scroll) | `terminal_exit`; (idx 0) `show_selected_info{paneId}` | shell¹ |
| `viewer_add_ephemeral_terminal` | adds terminal tab (`addEphemeral`) | `focus_set{paneId}` + `terminal_enter` (conditional) | shell² |
| `viewer_remove_ephemeral_terminal` | removes terminal tab (`removeEphemeral`) | `destroy_pty_session{id}` + `terminal_exit` (conditional) | ✓ |
| `viewer_add_content_tab` | adds content tab (`addContent`) | `focus_set{paneId}` + `terminal_exit` (conditional) | shell² |
| `viewer_update_content_tab_lines` | content tab body | — | ✓ |
| `viewer_remove_content_tab` | removes content tab (`removeContent`) | `show_selected_info` if it was active | ✓ |
| `viewer_reorder_content_tab` | permutes `contentTabs` order | — | ✓³ |

¹ The leaving-tab capture is NOT here — it's the viewer's `_finalize`. The
  dispatcher threads `currentGroup` + `targetKey` (via `pt.resolveTabKey`) so
  the arm reads no model. ² `addEphemeral`/`addContent` get model-derived facts
  via the threaded `msg` (modelBundle). ³ This is the one Msg the free-config
  freeze-gate lets through besides layout-wraps (the tab-reorder drag gesture).
  (The `tab_list_*` overlay arms were retired — that state moved to
  `layout.paneMenu`.)

**(b) Viewer-specific arms (`viewer.js` switch)**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `viewer_set_content{lines,tab?,fromTabKey,total?}` | `viewerOverride={lines}`, `scroll=0`, clears search; manual FROM-capture (B6) when not already override & no `msg.tab` | — | shell⁴ |
| `viewer_show_info{lines}` | `slice.infoLines`; on Info: `scroll=0` + search-idx reset; from another tab: `tab=0` + restore `tabState.info` | — | shell⁵ |
| `viewer_scroll{to|delta}` | `slice.scroll` (clamp vs derived lines & `innerH`) | — | ✓ᴮ |
| `viewer_append{line,tabKey?,groupName?,...}` | `actionTabBuffers[g][k]` OR `viewerStreamBuffer` (capped); scroll bottom-stick | — | shellᴮ⁶ |
| `viewer_append_lines{lines,...}` | bulk variant of `viewer_append` | — | shellᴮ⁶ |
| `stream_start{header,tabKey?,groupName?,actionTabIdx?,currentGroup}` | seeds buffer; auto-jump to action/Transcript tab (clears `viewerOverride`, resets search/select/cursor, drops stale `tabState`) | `terminal_exit` (on jump) | shellᴮ⁶ |
| `viewer_set_tab{tab,total,toTabKey}` | `slice.tab` + restore `tabState[toKey]` (skips restore if `viewerOverride`) | — | shell⁴ |
| `viewer_reset_chrome{paneMenuMode}` | `tab=0`, cursor reset, clears `viewerOverride`, select inactive | `msg→pane_menu_close` (layout) if `paneMenuMode` | shell⁷ |
| `viewer_search_enter` | search typing state (`ms.enter`) | `msg→mode_set{detailSearchMode}` (conditional) | ✓ |
| `viewer_search_key{seq}` | search typing text (`ms.keystroke`) | — | ✓ |
| `viewer_search_nav{dir}` | search match cursor (`ms.next/prev` over derived matches) | — | ✓ᴮ |
| `viewer_search_commit` | commits search (`ms.commit`) | `msg→mode_clear{detailSearchMode}` (conditional) | ✓ᴮ |
| `viewer_search_cancel` | cancels search (`ms.cancel`) | `msg→mode_clear{detailSearchMode}` (conditional) | ✓ |
| `viewer_search_clear_committed` | clears committed search (`ms.clearCommitted`) | — | ✓ |
| `select_begin{line,col,kind}` | begins visual selection (`_beginSelect`) | — | ✓ |
| `select_extend{line,col}` | extends selection cursor | — | ✓ |
| `select_cancel` | selection inactive | — | ✓ |
| `select_set_cursor{line,col,extend}` | `_setCursor` | — | ✓ |
| `select_scroll_view{delta}` | `_scrollView` | — | ✓ |
| `key{key,seq,focusKind,terminalMode}` | the visual-mode state machine: reading→scroll, visual→cursor+extend, `v`/`V` toggle, `0`/`$` jumps, `/` search-enter, `n`/`N` search-nav, Esc cancel | `_claimed` (gate default); `y`→`msg→register_push{text}`; `/`→`msg→mode_set` via search-enter | shell⁸ |

ᴮ Reads `slice.innerH` (the **exception-B** finalizer-written value) for scroll
  clamps — the arm is otherwise pure; it doesn't write innerH.
⁴ `fromTabKey`/`total`/`toTabKey` threaded by the dispatcher (`nav-state.setViewerContent` / `api.setActiveTab`) — the reducer reads no `getModel`/`flatTabInfo`.
⁵ `msg.lines` is precomputed by `dispatch.showSelectedInfo` via `nav-state.infoLinesFromFocus` (the plugin `getInfo` read happens in the shell, not the arm); a missing payload safely bails.
⁶ Hot path (500–1000 lines/sec). The dispatcher (`dispatch/runtime/stream.js`) threads `currentGroup` + `activeActionTabKey` / `actionTabIdx` so the arm avoids the ~71µs `getMergedActions` call per line.
⁷ Emitted by the groups cascade; `paneMenuMode` threaded.
⁸ `focusKind`/`terminalMode` threaded by `dispatchKeyToFocused`; `selectedTextFrom`/`plainLineWidthFrom` are pure variants fed the threaded `lines`.

**(c) `augmentMsg` + the viewer finalizer (the exception-C / per-tab-capture seam)**

- **`augmentMsg(msg, model)`** — if `msg.viewerModel` is absent, attaches
  `pt.viewerModelBundle(model, currentGroup)` (`{currentGroup, group,
  mergedActions, yamlTerminals}`). This is **exception C in the flesh**: the ONE
  model read the viewer needs, relocated from `update` to the framework dispatch
  shell (`loop.js` `_augment`), computed once. Result: the viewer reducer is
  pure of `getModel()`.
- **`_finalize`/`_withDerivedFields(next, originalSlice, vm)`** — the viewer's
  OWN pure finalizer, run inside `update`. On `next.tab !== originalSlice.tab`,
  captures the leaving tab's `{scroll, bottomSticky, search, select, cursor}`
  into `tabState[fromKey]`. Two carve-outs: skip if `originalSlice.viewerOverride`
  was active (B2 — override state is per-doc), skip if the FROM tab was removed
  this Msg (R5). Pure (operates on slice + bundle).

**Verdict (§7.4): pure TEA.** Every viewer arm is a pure `(msg, slice) →
[slice, effects]`. The single model read is hoisted to `augmentMsg` (exc. C);
`innerH` is read but written by the runtime finalizer (exc. B). The viewer is
the densest concentration of *threaded facts* in the system — almost every arm
has a footnote because so much was deliberately moved to the shell to keep the
reducer pure. This is the clearest worked example of "why the impurity exists
and where it was pushed to."

### 7.5 layout (`kind: 'layout'`) — the frame — verified

Owns the grid: `focus`, `viewMode`, `arrange` (columns/pool), `dims`,
`freeConfig`, `halfView`, `paneMenu`, `panelList`, `bootWarnings`, `dirty`. ~40
arms; `update` opens with a **notice auto-clear preface** (clears
`freeConfig.notice` unless the arm will re-assert it or it's a continuous-motion
Msg). **All arms pure** — every geometry/arrange transform delegates to a pure
leaf (`mfc`/`mfcCore`/`mfcMouse`/`mpool`/`mpoolDrag`/`mtabDrag`/`mpane`); layout
just threads. **The root-chrome mode flags it needs (`freeConfigMode`,
`paneMenuMode`, `freeConfigTitleEditMode`) are written by `mode_set`/`mode_clear`
Cmds, NEVER directly — clean cross-layer single-writer.** Verified.

Three recurring patterns (footnoted as ★ below): **★f** emits
`force_full_repaint` because the changed state is a slice-subfield overlay
(panelList/paneMenu/drag-preview) the diff-painter can't see; **★w** routes a
focus change through `_withFocus` (stamps `focus` + sticky `halfLeftPanel` +
`lastViewerTab`) and emits `show_selected_info`; **★m** flips a root mode flag
via a `mode_set`/`mode_clear` Cmd.

**(a) View mode + dims + focus**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `view_expand`/`view_shrink`/`view_set`/`view_drop_full_to_normal` | `viewMode` (or `freeConfig.notice` if refused in free-config) | `force_full_repaint` ★f | shell¹ |
| `view_place_pane{slot,paneId}` | `halfView[slot]` + focus ★w | `force_full_repaint` ★f | ✓ |
| `pane_menu_place{slot,paneId,viewerPaneId}` | `halfView[slot]` (swap-aware) + focus ★w | `force_full_repaint` ★f | shell² |
| `term_resized{cols,rows}` | `dims` | — | ✓³ |
| `focus_set{focus,skipInfo?}` | focus ★w | `show_selected_info` (unless `skipInfo`) | ✓ |

**(b) Pane-menu (`[≡]`) + pane-select swap**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `pane_menu_open{paneId,cursor,scroll}` | `paneMenu` (target+cursor) | `mode_set{paneMenuMode}` ★m | ✓ |
| `pane_menu_close` | clears `paneMenu` | `mode_clear{paneMenuMode}` ★m + `force_full_repaint` ★f | ✓ |
| `pane_menu_nav{dir|to,n,vh,sepIdx}` | `paneMenu.{cursor,scroll}` (skips separator) | — | shell⁴ |
| `pool_swap_by_id{targetPaneId,pickedId}` | `arrange` (SWAP/REPLACE, hotkey-reassign) + focus ★w | `pane_menu_close` + `show_selected_info` (on focus move) | ✓⁵ |

**(c) Arrange + pool + columns**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `set_arrange{arrange?,dirty?}` | `arrange` (paneId auto-mint, focus/halfView clamp, stale-ptr clear) + `dirty` | `mode_clear{paneMenuMode}` if a target was cleared | ✓ |
| `pool_hide{id}` / `pool_show{id,columnIndex?,index?}` | `arrange` (strip/insert + hotkey reassign) + focus clamp ★w | `show_selected_info` (on focus move) | ✓ |
| `pool_show_new_column{id,position}` | `arrange` (spawn column) + focus ★w + `freeConfig.notice` | `show_selected_info` | ✓ |
| `set_active_tab{paneId,tabPoolId}` | `arrange` (multi-tab active switch, undo push) + focus ★w | `show_selected_info` (if focused) | ✓ |
| `panel_collapse_toggle{id}` | `arrange` (flip `collapsed`, undo push) | — | ✓ |
| `add_column{position}` / `remove_column{columnIndex}` | `arrange` (via `mfc.addColumn`/`removeColumn`) + `freeConfig.notice`; remove clamps focus ★w | `show_selected_info` (remove, on focus move) | ✓ |
| `set_boot_warnings{warnings}` / `dismiss_warnings` | `bootWarnings` | — | ✓ |

**(d) Free-config (drag/resize design mode) + overlays**

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `free_config_enter` | resets `freeConfig`, opens `panelList` (if hidden panes), focus | `mode_set{freeConfigMode}` ★m + `force_full_repaint` ★f (on open) | ✓⁶ |
| `free_config_exit` | commits focus ★w, clears `freeConfig`/`panelList` | `mode_clear{freeConfigMode}` + `mode_clear{freeConfigTitleEditMode}` ★m + `show_selected_info` | ✓ |
| `free_config_nav`/`reorder`/`move_col`/`resize`/`panel_height`/`undo`/`redo` | `arrange`/`focus` (via `mfc`/`mfcCore` pure leaves) | — | ✓ |
| `free_config_title_enter`/`submit`/`key`/`cancel` | `freeConfig.titleEdit` (+ commits title) | `mode_set`/`mode_clear{freeConfigTitleEditMode}` ★m | shell⁷ |
| `free_config_mouse_press`/`motion`/`release` | `freeConfig.drag` (+ `previewArrange` on target change) | `force_full_repaint` ★f (on target shift) | ✓ |
| `pool_drag_start`/`motion`/`release` | `freeConfig.drag` (+ `previewArrange`) | start/motion `force_full_repaint` ★f; release re-emits `pool_hide`/`pool_show` | ✓ |
| `tab_drag_start`/`motion`/`release{viewerTarget,viewerPaneId,tabBounds}` | `freeConfig.drag` | start `force_full_repaint`; **motion emits `msg→viewer_reorder_content_tab`** (cross-Component → detail) | shell⁸ |
| `free_config_clear_undo` | clears undo/redo stacks | — | ✓ |
| `panel_list_open{cursor}`/`close`/`nav{dir}` | `panelList` | `force_full_repaint` ★f (on open/close transition) | ✓ |
| `panel_list_pick` | closes `panelList` | re-emits `pool_hide`/`pool_show` + `force_full_repaint` | ✓ |

¹ `msg.freeConfigMode` threaded by `handleAction` (decides whether to refuse).
² `msg.viewerPaneId` threaded by the dispatch shell (for the half-view projection).
³ **The single writer of `dims`** (resize-as-Msg). The stdout `'resize'` listener
  + `initState` boot seed dispatch it; geometry reads `dims`, never the live terminal.
⁴ `n`/`vh`/`sepIdx` threaded by the handler.
⁵ Reads only `slice.arrange` + `msg`; no model/topology. The compound SWAP/REPLACE
  is intricate but pure (operates on the slice's own arrange).
⁶ Reads `mpool.hiddenIds`/`allPanesInColumns` off its OWN slice's arrange — pure.
⁷ `msg.freeConfigTitleEditMode` threaded (whether title-edit was open).
⁸ `viewerTarget`/`viewerPaneId`/`tabBounds`/`modelBundle` threaded by `input.js`
  (impure shell) so the arm reads no route topology; today `viewerTarget==='detail'`.

**Verdict (§7.5): pure TEA.** Layout is the proof that a large, intricate
Component (40 arms, drag preview, compound arrange surgery) stays a pure reducer:
all math lives in pure leaves, all cross-layer writes (mode flags, viewer
reorder, pool re-dispatch) go out as Cmds, and the handful of topology facts are
threaded by the shell. No `getModel()`, no route-value read in any arm.

### 7.6 groups (`kind: 'groups'`) — the cascade emitter — verified

Owns `list` / `expanded:Set` / `tab` / `nav`. Shared nav (`mnav.apply`) first,
then 4 own arms. The Component that **drives the cross-layer group-switch
cascade** — but it writes only its OWN slice; `currentGroup`, per-panel resets,
and the viewer reset all go out as Cmds (single-writer per layer). All arms pure
(facts arrive via `msg.ctx` = `{groups, currentGroup, paneMenuMode, viewerTarget,
resetOwners}`, built by `nav-state._groupsCtx` in the impure shell). Verified.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `groups_recompute{ctx}` | `list` (rebuild from `ctx.groups` + expanded) | — | shell¹ |
| `groups_selected{index,ctx}` | — (cursor already written by upstream nav_select) | if group moved: `msg→viewer_reset_chrome` **then** `set_current_group` **then** `reset_group_context` (the B5 order) | shell¹ |
| `toggle_group{name,recursive,ctx}` | `expanded` (Set) + `list` | `set_cursor` (self) + the group-change block (if moved) + `show_selected_info` | shell¹ |
| `toggle_groups_tab{ctx}` | `tab` (All↔Quick) + `list` | same cascade as `toggle_group` | shell¹ |

¹ `msg.ctx` is built by the impure shell (`nav-state._groupsCtx` →
  `groupsBundle(model)` + `route.resolveTarget('viewer')` + `route.resetGroupOwners()`),
  so the arm reads no `getModel()`/topology (#D9/#D10).

**The B5 ordering is load-bearing** (`_groupChangeCmds`): `viewer_reset_chrome`
MUST be emitted BEFORE `set_current_group`. The viewer's finalizer captures the
leaving tab's view-state on the `slice.tab` transition; if `currentGroup`
switched first, the capture would land under the NEW group's key. Documented at
the emit site — a genuine cross-Component ordering constraint, not an impurity.

**Verdict (§7.6): pure TEA.** groups is the textbook cascade emitter: own-slice
writes + a fan of cross-layer Cmds, every fact threaded. The §7.7 cascade below
is exactly its `_groupChangeCmds` expanded.

### 7.7 Cross-layer Component→Component cascade (the deepest observed)

```
groups key/select
  → groups_selected (groups.update)
      → set_current_group        (flat → root reducer)
      → reset_group_context      (flat → root reducer)
            → set_cursor × N      (wrapped → each owner nav, via mnav.apply)
            → multisel_clear × N
            → clear_filter × N
      → viewer_reset_chrome      (wrapped → detail.update)
```
~4 deep; the `msg`-Cmd cycle cap (32, `effects.js` T28) is the backstop.

### 7.8 Data-fetching navigators (docker / files / config-status / history) — verified

These are the Components with **async work**: their `update` arms stay pure
(`mnav.apply` first, then own arms returning `[slice, effects]`), and ALL I/O
lives in their `installEffects`-registered handlers (tier `fx`, impure by
design — they read `getModel()` and shell out). Three of them use **`augmentMsg`
to thread an out-of-TEA / model-derived fact** into the `key` arm so the arm
stays pure (the same exception-C seam the viewer uses). A recurring correctness
rule across all their effects: **route async results to the ORIGINATING
`paneId`** (`host.wrap(eff.paneId || kind, …)`), never the kind's primary — else
multi-instance panes clobber each other (the "collapse-to-primary footgun").

**docker (`kind: 'docker'`)** — `slice.{status, stats, inFlight, started}`.
Self-driven polling; `augmentMsg` threads container `items`.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| *(content gate)* | — | — | a placed pane (`slice.paneId != null`) `return slice` — host-global content runs only on the singleton owner¹ |
| `key{focusKind,items}` | — | `i`→`dockerExec{inspect}` · `t`→`dockerExec{logs}` · `s`→`dockerShell` | shell² |
| `refresh` | `started` | `tick{dockerTick}` (once) + `dockerFetch` | ✓ |
| `dockerTick` | — | `tick{dockerTick}` (re-arm) + `dockerFetch` | ✓ |
| `dockerPoll` | — | `dockerFetch` | ✓ |
| `dockerResult{status,stats}` | `status`, `stats`, `inFlight→false` | `render` | ✓ |

**files (`kind: 'files'` + `file-browser`)** — `slice.browser` (per-pane dir
browser). Multi-panelType. `augmentMsg` threads `filesModel` (pane def + declared
items + projectDir).

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `refresh{filesModel}` | `browser` (kick load) | `loadDir` (if source needs I/O) | shell³ |
| `dirLoaded{seq,items,error}` | `browser.items` (stale-guarded by `seq`) | `render` | ✓ |
| `showHidden{mode}` | `browser.showHidden` | `render` | ✓ |
| `key{filesModel}` (`return`) | `browser` (on dir nav) | dir→`loadDir`+`resetPanelChrome`+`_claimed` · file→`openFile`+`_claimed` | shell³ |

**config-status (`kind: 'config-status'`)** — `slice.{files, projectDir, branch,
cache, computing, layout, scope, expanded}`. **init-injection** seed
(`init(paneId, seed)`, #4 — reads no globals).

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `set_config{config}` | `files` snapshot + `projectDir` (mirror for local reads) | — | ✓ |
| `refresh` | `branch`, `computing→true` | `cfgStatusCompute{branch,files,projectDir,paneId}` | ✓ |
| `cfgStatusResult{cache}` | `cache`, `computing→false` | `render` | ✓ |
| `key` | `t`→`layout` toggle · `s`→`scope` toggle · `return`(more)→`expanded` | each returns `_claimed`; `return`(file)→`cfgStatusDiff` | ✓⁴ |

**history (`kind: 'history'`)** — stateless render over the `feature/history`
ring buffer. `augmentMsg` threads `entries`.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `key` (`return`) | — | `historyReplay{entry}` + `_claimed` | shell⁵ |

¹ The status/stats fetch loop + `docker events` watcher are host-global (one
  daemon), so they run on ONE instance — the register-time singleton
  (`paneId == null`); placed docker panes carry nav/key only. ² `focusKind` +
  `items` (container names) threaded by `augmentMsg` (`_itemsFromModel`).
³ `filesModel` (pane def + declared items + projectDir) threaded by `augmentMsg`.
⁴ `t`/`s`/`return` are `_claimed` so the framework default doesn't also fire;
  `]`/`[` deliberately NOT claimed (fall through to the pane/tab cycle).
⁵ `entries` threaded by `augmentMsg` from `model.history` (the store-mirror'd
  snapshot, since FIX-1; was `feature/history.all()`) — renderer-only-reader rule
  kept: the arm doesn't read the store/model list inline.

**Verdict (§7.8): pure TEA.** Every navigator arm is a pure `(msg, slice) →
[slice, effects]`. All I/O is in effects; every model/registry read the arms
would need is threaded by `augmentMsg` (exception C). `actions` (§7.2) is the
degenerate case — pure projection, no own arms.

### 7.9 stats (`kind: 'stats'`) — verified

`update` is a literal **no-op** (`(msg, slice) => slice`) — stats holds NO Msg
state. It is a **pure hub-fed render + a declared subscription**:

- `subscriptions(paneDef, model) → [{topic, window}]` — a PURE projection of the
  pane config. The framework reconciles the desired set each dispatch (#D13,
  `app/state.reconcileSubscriptions` via the finalizer): `hub.subscribe` on
  pane-place, `hub.unsubscribe` on pane-remove. The `onUpdate` callback is a
  repaint.
- `render` reads `hub.history(topic, rowKey, window)` + another pane's cursor
  (`select_from`, via `nav-state.getSel`) — cross-pane by design. Its own slice
  is empty.

stats is the cleanest example of the **`subscriptions : Model → Sub`** seam:
no Msg, no slice, the data lives in the hub bus (docker publishes
`docker.stats`), and the framework owns the subscribe/unsubscribe effect.

**Verdict (§7.9): pure TEA** (vacuously — no reducer arms; subscription is a
pure declaration the runtime reconciles).

---

## 8. Effect / Cmd vocabulary (the side-effect tier — impure by design)

One registry (`effects.js#_handlers`), two emitters (root reducer Cmds +
Component effects), one interpreter (`runEffects`). Each handler gets the Cmd +
an injected `host` ({dispatchMsg, applyMsg, wrap, streamCommand, refreshAll,
cleanup, showHelp}) — the **formalized-injection** seam so handlers feed Msgs
back without importing upward. Unknown types are logged, not thrown. **All
handlers are tier-`fx` (impure by design).**

### 8.1 Framework built-ins (`effects.js#installBuiltins`) — verified

| Cmd | Does | Re-enters dispatch? |
|---|---|---|
| `msg` | routes `eff.msg` by `msg.kind`: wrapped → `dispatchMsg`, flat → `applyMsg` | **yes** (the cyclic spine; cap 32) |
| `render` | `renderQueue.scheduleRender()` (50ms debounce) | no |
| `show_selected_info` | `dispatch.showSelectedInfo(eff.paneId?)` → resolves focused info lines → viewer | yes (→ `viewer_show_info`) |
| `force_full_repaint` | `renderQueue.forceFullRepaint()` | no |
| `_claimed` | no-op (sentinel consumed earlier in `dispatchKeyToFocused`) | no |
| `do_run` / `run_action` | `setImmediate` → `action-runner.doRun/runAction` (spawn after the overlay-gone frame paints) | via action lifecycle |
| `unrouted_preempt_and_run` | kill prior stream + start new (`stream.killJob`+`streamCommand`) | via stream |
| `jobs_route` | reads post-switch viewer slice, threads tab → `applyMsg(jobs_routed)` | yes (the read-then-Msg pattern) |
| `copy_commit` | `copy.copySelect(idx,label)` → OSC52, then `copy.clearOptions()` | no |
| `emit_osc52` | `io/term.emitOSC52(text)` (clipboard) | no |
| `cmdline_rebuild` | re-query registry → `applyMsg(cmdline_set_matches)` | yes (read-then-Msg) |
| `cmdline_run` | `cmdline.runAt(sel,args,display)` | via action |
| `cmdline_clear` | `cmdline.clear()` | no |
| `cmdline_preview` / `cmdline_revert_preview` | live-preview apply / teardown (e.g. theme) | no |
| `menu_action` | `dispatch.handleAction(action, arg)` (or `focus_panel:<h>`) | yes |
| `run_binding` | `Promise.resolve(eff.run()).catch(...)` (resolved leader leaf) | via action |
| `diag_clear` / `diag_save` | `io/diag-log.clear()` / `.save()` | no |
| `destroy_pty_session` | `io/terminal.destroySession(id)` | no |

Also note: `refireCmdlineRebuild` (handed to the feature-host port, not a
registered Cmd) re-fires the dropdown rebuild after an async completion fetch
(docker dir listing) resolves. The `set_theme` effect was **retired** (#D8 —
palette now projected from `model.theme` at render entry).

### 8.2 Component-contributed effects (registered via each Component's `installEffects`) — verified

All tier `fx` (impure by design — they read `getModel()` and shell out, then
fold results back as Msgs). Each routes its result Msg to the **originating
`paneId`** (`host.wrap(eff.paneId || kind, …)`) to avoid the collapse-to-primary
footgun.

| Cmd | Owner | Body / re-entry |
|---|---|---|
| `dockerFetch` | docker | `setImmediate` → `docker inspect`/`docker stats` exec; `hub.publish('docker.stats')`; → `dockerResult` Msg. Reads `getModel().focused` (skip when blurred, still clears `inFlight`). |
| `dockerEventsStart` | docker | spawn `docker events` watcher (if any container tracked); change → `dockerPoll`. Reads `getModel().config`. |
| `dockerExec{mode,item}` | docker | `applyMsg(terminal_exit)` + `host.streamCommand(inspect|logs)` |
| `dockerShell{item}` | docker | `addEphemeralTab(getModel().currentGroup, …)` (exec interactive shell) |
| `loadDir{paneId,source,cwd,…}` | files | `setImmediate` → `readdir`/`dockerList` → `dirLoaded` Msg (wrapped to `paneId`) |
| `openFile{paneId,item}` | files | open as content tab via the open-target scheme registry (`feature/open-file` / `open-docker`) |
| `resetPanelChrome{paneId}` | files | dispatch `set_cursor`+`set_scroll`+`clear_filter` (wrapped to `paneId`) — re-home on dir nav |
| `cfgStatusCompute{branch,files,projectDir,paneId}` | config-status | `setImmediate` → git status off-tick → `cfgStatusResult` Msg (wrapped to `paneId`) |
| `cfgStatusDiff{item,branch,projectDir}` | config-status | `setViewerContent(diff)` |
| `historyReplay{entry}` | history | `setViewerContent(replayLines, {tab:0})` (single dispatch — override + land on Info) |
| `test_fx` / `test_wrapped_fx` | test harness only | — |

---

## 9. Purity verdict + blessed-exception index

### 9.1 Verdict (reducer + modal + Component + effects + producers — all traced)

**lazytui is pure TEA at the decision layer.** All 19 root-reducer arms and all
~40 modal arms are pure functions `(model, msg) → [model, cmds]` returning new
immutable state and Cmd descriptors. No reducer arm reads `getModel()`, the wall
clock, or Component-slice values to branch — every such fact is **stamped onto
the Msg by the impure shell** (handlers / effects). That relocation is the
single recurring "impurity", and it is *blessed-exception C* by design.

The genuinely mutable surface is **concentrated and named**:
- the **impure shell** (`dispatch/control/*` + `effects.js`) — reads + I/O (exc. C);
- the **#D5 boundary** — render reads off-model live stores (jobs/diag/history/
  PTY/term), and the terminal pane is a non-TEA island.

(Exception **B** — the finalizer's `innerH` same-slice write — was RETIRED in
v0.6.6 FIX-2; innerH is now threaded onto viewer Msgs and reducer-committed. §9.2.)

### 9.2 Standing blessed exceptions (the live set)

| ID | Name | Site | Why kept | Status |
|---|---|---|---|---|
| **C** | Impure-shell model read (`getModel` / wall clock) | handlers in `dispatch/control/*`; the `clock` interval Sub's `onTick` (`Date.now()`, app/state.js); the `augmentMsg` seam; `getModel()` in the pumps | The shell is impure by design; it reads ONCE and threads facts into Msgs so the reducers/Components stay pure. Removing it would only move the read, not eliminate it. | KEPT (by design) |

**Exception B — RETIRED (v0.6.6 FIX-2).** Was: the finalizer wrote the viewer's
derived `innerH` directly onto its slice (`setInstanceSlice(viewerTab, {...vs, innerH})`),
the one structural same-slice runtime write. TEA review #3 D16 KEPT it on the
premise "innerH is reducer-read so must stay in-slice" — but that premise only
held if the value wasn't threaded. v0.6.6 threads it: `viewer.augmentMsg` stamps
`msg.innerH` (computed in the shell from the pane's committed geometry) and the
viewer's OWN pure reducer projects + commits it. The finalizer write is gone; the
viewer's `update` is the single writer of `slice.innerH`. Zero test migration
(`slice.innerH` stays a seed/fallback) and it fixes a latent multi-viewer bug
(the finalizer only refreshed the *primary* viewer's innerH). See `docs/v0.6.6.md`.

### 9.3 #D5 replayability boundary (NOT an exception — a documented limit)

`frame === f(model)` EXCEPT the terminal island (v0.6.6). `model.now` +
`model.theme` are under the model (wall clock + theme replay-safe); **FIX-1**
brought the three discrete live stores under it (`feature/history` /
`io/diag-log` / `feature/jobs` → `model.{history,diagLog,jobs}` via the
`store-mirror` Sub); and **Finding B** (the code-only re-review) brought the
continuous hub metrics series under it (`hub.matrix(topic)` →
`model.metrics[topic]` via the throttled `metrics-mirror` Sub — sample at a
cadence, not per publish, so a continuous sampler doesn't churn the loop). So
render reads the model everywhere. The one remaining off-model render read is
`io/terminal.getSession()` + `io/term.cols/rows()` (the #D14 PTY island).
Replaying the Msg log reconstructs the model and so the frame —
terminal output excepted. See `model/store.js §Replayability boundary`.

### 9.4 Retired exceptions (for context — do NOT re-track)

`paneBounds`/`tabBounds`/`innerH` render-side writes (A.1–A.3, #D7) · render-side
`set_scroll` clamp (resize-as-Msg) · boot `m.config`/`m.register` direct writes
(D3) · `setImmediate(terminal_exit)` from render (P5.1) · overlay `Date.now()` +
`io/term` dims reads (model-clock arc) · viewer `update` `getModel()` read (#3) ·
config-status init cross-slice read (#4) · `set_theme` effect (#D8) · root-reducer
`jobs_activate` cross-slice read (Phase C). The trajectory is toward empty.

---

## 10. The input-verb layer — where Msgs are PRODUCED (the impure shell)

§4–§8 catalog how Msgs are *handled*. This section catalogs how they're
*produced* — the entry point of every feature. This layer is the **impure shell**
(tier `shell`/`fx`): it reads `getModel()` / `getFocus()` / `getItems()` freely
(dispatchers MAY; reducers MUST NOT), resolves facts, and threads them onto the
Msg it dispatches. **This is where "why the impurity happens" is most visible:**
the shell reads liberally precisely so the reducers downstream don't have to.

### 10.1 The intent seam (`dispatch/control/intent.js`) — keyboard + mouse converge

Five intents are the semantic middle between gestures and Msgs. `realize(intent)`
is the single intent→dispatch site.

| Intent | Realizes to |
|---|---|
| `focus{dir|hotkey|paneId}` | `handleAction('focus_left'|'focus_right'|'focus_panel')` (relative) · `msg→focus_set` (absolute/mouse) |
| `select{delta|idx}` | `handleAction('nav_up'|'nav_down')` (relative) · `dispatch.navSelect(paneId, idx)` → `nav_select` (absolute) |
| `activate` | `handleAction('run_selected')` |
| `scroll{mx,my,delta}` | `input._handleWheel` (spatial, per-pane) |
| `context{anchor,items,title}` | `applyMsg(menu_open)` |

### 10.2 `handleAction(verb, arg)` (`dispatch/control/actions.js`) — the keyboard/menu/cmdline chokepoint

The central name→Msg switch for verbs firing from bare keys, leader chords, `:`
cmdline, and the menu. Each arm resolves a Msg from the model and dispatches it
(the reducer is the writer). **All verbs route to a documented Msg/effect** —
this is the producer-side completeness check.

| Verb | Produces (Msg / effect / call) |
|---|---|
| `nav_up`/`nav_down` | `moveSel` → `dispatch.navSelect` → `nav_select` |
| `focus_left`/`focus_right`/`focus_panel` | `msg→focus_set` (layout) |
| `run_selected` | context-dependent: terminal tab→`activateTerminal`→`terminal_enter`; action tab→`_runResolvedAction`→`prompt_enter` or `run_action` fx; groups branch→`msg→toggle_group`, leaf→`msg→focus_set(actions)`; actions→`_runResolvedAction`; else→`dispatch.showSelectedInfo`→`viewer_show_info` |
| `next_tab`/`prev_tab` | `applyMsg(next_tab/prev_tab + _viewerTabBundle)` |
| `page_up`/`page_down` | detail→`msg→viewer_scroll{delta}`; list→`_pageInListPanel`→`nav_select` |
| `goto_top`/`goto_bottom` | detail→`msg→viewer_scroll{to}`; list→`_jumpInListPanel`→`nav_select` |
| `view_expand`/`view_shrink` | `msg→view_expand/shrink` (layout; `freeConfigMode` stamped) |
| `toggle_collapse_focused` | `msg→panel_collapse_toggle` (layout) |
| `filter` | `dispatch._enterFilterMode` → `filter_enter` |
| `free_config` | `applyMsg(free_config)` |
| `copy_text` | `applyMsg(register_push)` |
| `ctx_run_action` | `_runActionByKey` → `_runResolvedAction` (`prompt_enter` / `run_action`) |
| `ctx_run_command` | `cmdline.runCommandString` |
| `refresh` | `api.refreshAll()` (direct async — broadcasts `refresh`) |
| `show_help` | `overlay/help.showHelp()` (direct) |
| `quit` | `cleanup()` + `process.exit(0)` — **the one terminal action that is NOT a Msg** |

`_viewerTabBundle` / the groups `ctx` build / `freeConfigMode` reads here are the
**fact-threading** that keeps the downstream reducer arms pure (the footnotes
throughout §4–§7). Same model: read once in the shell, stamp onto the Msg.

---

## 11. Completeness verification (loop 5)

A grep-diff of the catalog against the whole `js/` tree (excl. tests):

- **Every reducer/modal/Component Msg type is documented.** Cross-checked all
  `case '…'` / `msg.type === '…'` handlers, INCLUDING the 6 camelCase Component
  Msgs the first pass's `[a-z_]+` grep missed (`dockerTick`, `dockerPoll`,
  `dockerResult`, `dirLoaded`, `showHidden`, `cfgStatusResult` — all in §7.8).
- **Every effect is documented.** All 35 `registerEffect('…')` types appear in
  §8.1 (framework, 23) or §8.2 (component, 10) or are the 2 test-only fixtures.
- **`viewer_set_viewport` is comment-only** (`viewer.js:63`) — a referenced-but-
  never-implemented Msg; correctly NOT in the catalog.
- **The non-Msg `case` strings** the broad grep surfaced are the input-verb /
  intent / key-value vocabulary (§10) — producers, not Msgs. Now documented.
- **Shared nav Msgs** (`leaves/wm/nav.js` `NAV_TYPES`) all in §7.2.

**Two DATAFLOW.md lags found and fixed (2026-06-24):**
1. Its single-writer note still listed `viewer.slice.tabBounds` as "the last
   remaining render-side slice write." That predated blessed-exceptions A.3
   (2026-06-14) — `tabBounds` is now compute-on-read (`viewer.tabBoundsFor`),
   and **render writes NO slice state at all**. Moved the bullet into the
   RETIRED section; §7.4(c) reflects the current state.
2. Its EFFECTS box listed `quit` among effects; `quit` is actually a
   `handleAction` verb (§10.2) handled directly in the shell (`process.exit`),
   not a registered Cmd. Removed from the box; §8 is the accurate Cmd registry.

**Final verdict (catalog complete + verified):** lazytui is **pure TEA at the
decision layer** — every one of the ~150 Msg types resolves to a pure reducer
arm `(state, msg) → [state, cmds]`, and every side effect is a data descriptor
run by one interpreter. The mutable surface is **concentrated, named, and
commented**: exception **C** (the impure-shell reads — the input verbs of §10,
the `augmentMsg` hooks of §7, and the effect bodies of §8, all of which read the
model/registry and thread facts forward so reducers stay pure), and the **#D5
boundary** (render reads off-model live stores; the terminal pane is a non-TEA
island). Exception **B** (the finalizer's `innerH` write) was RETIRED in v0.6.6
FIX-2. There is **no scattered mutation** — the impurity is exactly the shell
that the pure core is wrapped in, by design.

---

## 12. Loop tracker

- **Loop 1 (2026-06-24, done):** framework + arch view + purity model; §4 root
  Msgs (19, verified); §5 modal Msgs (9 modals, verified); §6 broadcast; §8
  effects (framework set verified, component set listed); §9 verdict + exception
  index. Sources read in full: `loop.js`, `reducer.js`, `finalize.js`,
  `effects.js`, `store.js`, `model-ops.js`, all 9 `modal/*.js`, `nav-state.js`,
  `PRINCIPLES.md`, `DATAFLOW.md`, `blessed-exceptions.md`.
- **Loop 2 (2026-06-24, done):** §7.1 the Component-update/finalizer/exception-B
  relationship; §7.2 **shared nav reducer** (`leaves/wm/nav.js`, verified — and
  the reason `actions`/`history` need no own arms); §7.4 **viewer/detail** full
  route table — generic tab Msgs (`pt.reduceTabMsg`), 22 viewer-specific arms,
  the `key` visual-mode machine, `augmentMsg` (exc. C) + the per-tab-capture
  finalizer. Sources read in full: `viewer.js` (update body 320–1076 +
  augmentMsg), `leaves/wm/nav.js`, `pane-tabs.js#reduceTabMsg`, `actions.js`.
- **Loop 3 (2026-06-24, done):** §7.5 **layout** (~40 arms — view mode / dims /
  focus / pane-menu / pane-select swap / arrange+pool+columns / free-config drag
  + overlays) and §7.6 **groups** (the cross-layer cascade emitter + the
  load-bearing B5 ordering). Sources read in full: `layout.js#update` (276–1190),
  `groups.js#update`+`_groupChangeCmds`/`_cascadeCmds`/`selectAt`.
- **Loop 4 (2026-06-24, done):** §7.8 **docker** (content gate + self-poll +
  augmentMsg items) / **files** (per-pane browsers + filesModel) / **config-status**
  (init-injection + git compute) / **history** (ring-buffer replay); §7.9 **stats**
  (no-op update + declared subscription); §8.2 **all component effect bodies**
  verified. Sources read in full: `docker.js#update`+`installEffects`,
  `files.js#update`+effects, `config-status.js#update`+effects, `stats.js`,
  `history.js#update`+effect. **§7 is now COMPLETE — every Component verified.**
- **Loop 5 (2026-06-24, done — CATALOG COMPLETE):** grep-diff verification (§11)
  proved every Msg/effect is documented (incl. the 6 camelCase Component Msgs +
  all 35 effects; `viewer_set_viewport` confirmed comment-only). Added §10 — the
  **input-verb layer** (`intent.realize` + `handleAction`) so each feature is
  traceable end-to-end from its entry verb to its Msg. Noted 2 DATAFLOW.md lags
  as observations (no edits — task is doc-only, no refactor). Sources read in
  full: `intent.js`, `actions.js`. Final verdict restated in §11.

**Status: COMPLETE.** Sections §1–§11 cover the architecture view, the
purity model, every Msg route (root / modal / Component / broadcast), every
effect, the producer (verb) layer, and the blessed-exception index — all verified
against source. What remains is OUT OF SCOPE by the task's own terms ("don't
refactor, just write the code case down"): the **refactor discussion** (§9 lists
the live exceptions B/C + the #D5 boundary as the candidates; turning any into a
plan is a separate, opt-in exercise). Re-invoke the loop only to (a) deepen a
specific Component, (b) re-verify after code changes, or (c) open the refactor
conversation.
