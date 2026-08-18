# Msg route catalog — the TEA purity map

> **STATUS — re-audited 2026-08-14 (loop 6) against current source.**
> The original catalog was a 5-loop snapshot (2026-06-24); loop 6 reconciled it
> with everything shipped since — the U2f one-tab-system, live-agent, the dataflow
> fabric (P1.5), kitty-keyboard detection, the store-/metrics-mirror Subs, and the
> v0.6.7 jumplist. It documents *where every Msg goes and what it writes*, so each
> feature's dataflow is visible in one place and the "pure TEA vs mutable" question
> can be answered per-route. It is a **review/learning aid**, not a canonical spec
> — `docs/PRINCIPLES.md §11/§12` and `docs/DATAFLOW.md` remain the authority. **No
> refactor is implied** by anything here. Findings that suggest a refactor are
> parked in §9.
>
> **What loop 6 reconciled (2026-08-14):**
> - **§4 root reducer — 30 arms now** (was 19): added the agent-mode flags
>   (`agent_enter`/`agent_exit`), kitty detection (`kkp_detected`), the four
>   store-/metrics-mirror arms (`history_synced` / `diag_synced` / `jobs_synced` /
>   `metrics_synced`), and the v0.6.7 jumplist (`nav_record` / `nav_back` /
>   `nav_forward` / `nav_prune`). `next_tab`/`prev_tab` now emit `set_active_tab`
>   (layout, not the retired `tab_switch`); `terminal_*` thread kitty suspend/
>   resume; `set_current_group` emits `nav_capture`; `reset_group_context` emits
>   `select_cancel_all`.
> - **§5 — the sub-reducer table** (`_SUBREDUCER_BY_TYPE`, ex-`_MODAL_BY_TYPE`) now
>   holds **10 modals + 1 fabric-state delegate**: added `fabric-field` (§5.10)
>   and the fabric injects/output/wires store (§5.11).
> - **§7 — the `viewer`/`detail` Component was dissolved (U2f)**; §7.4 is kept as a
>   dated RETIRED record. The content slot is now the `info` / `text-view` /
>   `agent` / `terminal` panes (**new §7.10**), all sharing the `tvu` reducer
>   (`leaves/text/text-view-update`) for scroll/search/select, plus the fabric
>   `component-ports` / `fabric-wires` panes (**new §7.11**). `augmentMsg` is
>   declared by **six** Components (info/agent/text-view/docker/files/history).
> - **§8 — added** the new framework effects (`kkp_suspend`/`resume`, `edit_file`,
>   `select_cancel_all`, `open_doc_tab`, `agent_start`/`send`/`interrupt`,
>   `nav_capture`/`restore`) and the fabric component effects; `destroy_pty_session`
>   **retired** (its only emitter was the dissolved viewer's ephemeral-terminal arm).
>
> This is a point-in-time audit — verify each cited symbol/path against source
> before relying on it.
>
> **Coverage (re-verified 2026-08-14):**
> - ✅ §1 Architecture view · §2 Purity model · §3 Reading the tables
> - ✅ §4 Root-reducer Msgs (30, flat) · §5 Modal + fabric sub-reducers (11)
> - ✅ §6 Broadcast Msgs · §8 Effect / Cmd vocabulary
> - ✅ §7 Component Msgs (wrapped) — §7.2 shared nav · **§7.4 viewer (RETIRED, U2f)**
>   · §7.5 layout · §7.6 groups · §7.8 docker/files/config-status/history · §7.9
>   stats · **§7.10 content-slot panes (info/text-view/agent/terminal)** · **§7.11
>   fabric panes (component-ports/fabric-wires)**
> - ✅ §9 Purity verdict · §10 Input-verb layer · §11 Completeness

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
              │  layout · navigator/* · monitor/* · fabric/*      │  routing
              │  info · agent · terminal · text-view (content panes)
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
                resize / store-mirror / metrics-mirror / process-stream kinds →
                applyMsg/dispatch, async).
              async results (stream onData, fetch, PTY) → dispatchMsg back in.
                                   │
                                   ▼
  FINALIZE    finalizeDispatch()  (ONCE, at depth-0 exit of the outermost pump)
  finalize.js   • reconcile per-pane instances (mint/dispose), gated on arrange-ref
                • reconcile hub subscriptions (Model → Sub diff)            [#D13]
                • keep-in-view scroll clamp → set_scroll Msg per nav pane   [resize-as-Msg]
                • flush a pending nav-capture → one nav_record Msg    [v0.6.7 jumplist]
                • content-pane innerH: NO finalizer write — stamped on each
                  pane Msg by that pane's augmentMsg, committed by its own
                  reducer  [v0.6.6 FIX-2; §7.10]
                • active terminal PTY ensure/resize                [v0.6.5 §5]
                                   │
                                   ▼
  RENDER      render(model)                                   paint.js / footer.js
                projects theme palette from model.theme (per-frame, #D8)
                reads slices + model.now + model.{jobs,diagLog,history,metrics}
                the ONLY off-model read is the terminal island (PTY screen
                buffer + term dims, #D14/#D5)
                returns ANSI; paintColumns diffs vs prev frame → stdout
```

### 1.3 The two state homes

| Home | Module | Writer | Examples |
|---|---|---|---|
| **Root model** (centralized chrome) | `model/store.js` (`_modelRef.current`) | `reducer.update` + `modal/*` + `fabric` sub-reducer ONLY | `modes{}` (modal flags), `modal{}` (editing buffers), `currentGroup`, `now`, `theme`, `history`/`diagLog`/`jobs` (store-mirror'd, FIX-1), `metrics[topic]` (metrics-mirror'd, Finding B), `caps` (kitty-keyboard capability), `nav` (jumplist ring, v0.6.7), `fabric{injects,output,wires}` (dataflow fabric, P1.5), `config`, `register`, `focused`, `prefixNode/Seq` |
| **Component slices** (decentralized) | `panel/route.js` instance store | each Component's own `update` ONLY | `layout` (focus/viewMode/arrange/freeConfig), the content-slot panes `info`/`text-view`/`agent` (lines/scroll/search/select/cursor via `tvu`) + `terminal` (cmd/label; grid is foreign), `groups` (tree/expanded), `docker`, `files`, `config-status`, `component-ports` (pinned target), `fabric-wires` (nav), `nav[panelType]` (cursor/scroll/multiSel/filter) |
| **Out-of-TEA stores** (global-by-nature) | `feature/*`, `io/*` | module-local mutators | `feature/jobs` (live child procs), `feature/history`, `io/diag-log` (ring buffer), `io/terminal` (xterm buffers) |

---

## 2. The purity model — "pure TEA or mutable?"

**Short answer: the reducer layer is pure TEA; the shell around it is
deliberately impure; render is pure of the wall clock and reads the model
everywhere except the terminal island.** Concretely, three tiers:

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

3. **#D5 REPLAYABILITY BOUNDARY — the terminal island (v0.6.6).** Render is pure
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
   throttle window). (The two render-path diag *writes* — strict-miss tripwire +
   plugin guard — are now deferred off the read path and drained by the dispatch
   finalizer; see Finding C in docs/v0.6.6.md §9.)

**Single-writer invariant.** Only `reducer.update` / `modal/*` / the `fabric`
state sub-reducer write the root model (all three delegated through `update`, so
the reducer is still the single entry); only a Component's own `update` writes
its slice. Cross-layer writes have NO direct path — they go out as a
`{type:'msg', msg}` Cmd that re-enters a pump (wrapped → Component fan-out, flat
→ root reducer). The invariant holds with **no structural exception** — since
v0.6.6 FIX-2 retired exception B, even a content pane's derived `innerH` is
committed by that pane's OWN reducer (its `augmentMsg` stamps it, its `update`
writes it — the same seam the four `info`/`text-view`/`agent` panes now share, §7.10).

**So: is it pure TEA or mutable?** It is **pure TEA at the decision layer**
(every state transition is a pure reducer), wrapped in an **intentionally
impure shell** (effects + handlers), with **exactly one standing exception**
(C: impure-shell reads) and one **boundary** (#D5/#D14: render reads the
terminal island). The mutability you see is concentrated, named, and
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
  - `C` touches blessed-exception C directly (superscript `ᴮ` = reads a pane's
    derived `innerH` for a clamp; not a blessed exception since FIX-2 — appears
    only in the retired §7.4 tables, kept as a legend for that historical record)
  - `fx` this is an effect/Cmd handler — impure by design (the interpreter tier)

---

## 4. Root-reducer Msgs (flat `{type}`)

Handled by `dispatch/update/reducer.js#update(model, msg)`, driven by the
**root-Msg pump** `applyMsg` (`dispatch/runtime/loop.js`). Routed here when the
Msg is flat (`msg.kind` absent). Every arm returns a NEW model on change,
identity-preserves on no-op. **All 30 arms are pure** — verified.

| Msg | Emitted by | Writes | Emits (Cmds) | Purity |
|---|---|---|---|---|
| `escape` | Esc handler | `modes.listSelectMode→false` (if set) | `msg→multisel_clear` (focused nav) when `msg.route` set & had selection | shell¹ |
| `list_select` | `v` (toggle) / `*` (on) | `modes.listSelectMode` | `msg→multisel_clear` when toggled OFF | shell¹ |
| `enter_prefix` | leader key | `modes.prefixMode→true`, `prefixNode`=kb root, `prefixSeq=[]` | — | ✓ |
| `prefix_key` | key in prefix mode | `prefixNode`/`prefixSeq` (descend) or clears prefix (leaf/cancel) | `force_full_repaint` (descend) · `run_binding` (leaf) | ✓² |
| `next_tab` / `prev_tab` | `]` / `[` | — | `msg→set_active_tab` (layout — cycle the content slot's position-tabs) | shell³ |
| `nav_select` | row select (kbd/mouse) | — | `msg→set_cursor` + `show_selected_info` (+ `msg→groups_selected` if groups) | shell⁴ |
| `terminal_enter` | enter-terminal verb | `modes.terminalMode→true` | `kkp_suspend` (child owns the terminal → legacy encoding) | ✓ |
| `terminal_exit` | exit-terminal / dead PTY | `modes.terminalMode→false` | `kkp_resume` + `msg→view_drop_full_to_normal` (layout) | ✓ |
| `agent_enter` / `agent_exit` | agent-mode verb / the `agent` pane | `modes.agentMode` | — | ✓ |
| `focus_event` | DEC 1004 focus in/out | `model.focused` | — | ✓ |
| `kkp_detected` | boot kitty-keyboard handshake (input.js) | `model.caps.keyboard` (`kitty`\|`legacy`) | — | ✓⁵ |
| `clock_tick` | `clock` interval Sub | `model.now=msg.now` | `render` | ✓⁶ |
| `history_synced` | `history` store-mirror Sub | `model.history` (whole snapshot) | `render` | ✓⁷ |
| `diag_synced` | `diag` store-mirror Sub | `model.diagLog` (whole snapshot) | `render` | ✓⁷ |
| `jobs_synced` | `jobs` store-mirror Sub | `model.jobs` (whole snapshot) | `render` | ✓⁷ |
| `metrics_synced` | `metrics-mirror` Sub (throttled) | `model.metrics[topic]={series,schema}` | `render` | ✓⁷ |
| `set_theme` | `:theme` / boot | `model.theme` | — | ✓ |
| `mode_clear` | wedge-guard / panic recovery | `modes[msg.flag]→false` (+ drops any staged `modal.continuation`) | — | ✓ |
| `mode_set` | pane search-enter etc. | `modes[msg.flag]→true` | — | ✓ |
| `set_current_group` | groups cascade / jobs_activate / nav_restore | `model.currentGroup` | `nav_capture` (unless `msg.noCapture`) | ✓⁸ |
| `nav_record` | `nav_capture` finalizer flush | `model.nav` (push loc; consecutive-dup no-op) | — | ✓⁹ |
| `nav_back` / `nav_forward` | `o` / `i` (jumplist step) | `model.nav.cursor` (ring step) | `nav_restore{loc,dir}` | ✓⁹ |
| `nav_prune` | `nav_restore` effect (stale spine record) | `model.nav` (drop index) | — | ✓⁹ |
| `set_config` | boot `loadConfig` | `config`, `projectDir`, `configPath` | `msg→set_config` (config-status, if `msg.csOwner`) | shell¹⁰ |
| `set_register` | boot `initState` | `model.register` | — | ✓ |
| `reset_group_context` | groups cascade | `modes.terminalMode/listSelectMode→false` | `select_cancel_all` + per `msg.owners`: `msg→set_cursor`+`multisel_clear`+`clear_filter` | shell¹¹ |
| `free_config` | `:free-config` verb | — | `msg→free_config_enter` (layout) | ✓ |
| *(default)* | — | — | — | ✓ |

¹ The handler stamps `msg.hadMultiSel` + `msg.route = route.bundle(getFocus())`
  (the `{compName, panelType, target}` triple). The arm reads only the stamped
  Msg — no topology read. blessed-A elimination (`docs/reducer-route-purity.md`).
² `kb.resolve` / `kb.tokenForEvent` are pure reads of the dependency-free
  keybinding leaf — not a topology read.
³ U2e P1b: `]`/`[` cycle the content slot's VISIBLE position-tabs (Info /
  Transcript / minted text-views — was the retired viewer's flat inner strip).
  `actions._viewerTabBundle` (handler) stamps `msg.slotPaneId` + the slot's
  ordered visible `tabPoolIds` (via `slot-strip.unifiedSlotStrip`) + `curIdx`;
  the arm keeps only the pure cycle math and emits `set_active_tab` to the layout
  slot. Empty `tabPoolIds` (single visible tab / no slot) → no-op.
⁴ navSelect handler stamps `msg.route`, `msg.viewerTarget`, `msg.resetOwners`.
  The `groups` branch builds `ctx` via `groups.groupsBundle(model)` — a pure
  projection of the **`model` arg** (NOT `getModel()`), so the arm stays pure.
⁵ The terminal-side enable/disable of the CSI-u protocol is an impure-shell
  effect the caller (input.js) owns; the arm only RECORDS the learned capability
  onto `model.caps`, so it rides the WAL and folds identically on replay.
⁶ `msg.now` is threaded from the `clock` interval Sub's `onTick`, which reads the
  wall clock in the impure shell (exception C). The arm is pure of the clock and
  no longer re-arms — the Sub owns the cadence (FIX-3 Phase 6; the `arm_clock`
  effect + `clockArmed` latch are retired). Its `render` Cmd is LOAD-BEARING: the
  clock tick carries no implicit repaint, so it is the SOLE driver for every armed
  case — the live action-status line (a PANEL, `frame=f(model.now)`) AND the
  jobs/diag age overlays (cell-diff-bounded — `docs/model-now-tick.md`).
⁷ The four **mirror-sync arms**. Each lands an external source's whole snapshot on
  the model; `frame=f(model)` (#D5, FIX-1 / Finding B). The value is stamped by
  the impure shell — the Sub's cb reads the off-model store / hub bus (exception
  C) and dispatches via `ctx.applyMsg`. The `render` Cmd is LOAD-BEARING: those
  Msgs run `update→setModel→runEffects` with NO implicit repaint, so the arm
  re-instates the repaint the pre-FIX-1 stores did directly. store-mirror fires
  per store mutation (discrete: history/diag/jobs); metrics-mirror once per
  throttle window (continuous series, so a sampler doesn't churn the loop).
⁸ A committed group change is a jumplist push point; `msg.noCapture` (stamped by
  `nav_restore`) suppresses the push while retracing, so travelling history
  doesn't record new locations.
⁹ **Jumplist arms** — all four are PURE ring math (`leaves/wm/nav-history`). The
  impure work is relocated to the effects (§8.1): `nav_capture` reads post-commit
  coords by STABLE identity (group name, active tab poolId, focused-item `idOf`)
  and stamps them onto a `nav_record` Msg at the depth-0 finalizer boundary;
  `nav_restore` resolves a stable location → a LIVE address and re-fires the
  primitive Msgs (`set_current_group`/`focus_set`/`set_active_tab`/`set_cursor`),
  all `noCapture`. The push lives on the Msg path, so the WAL fold reconstructs
  `model.nav` identically.
¹⁰ `msg.csOwner` (the config-status owner) is resolved by `app/state.loadConfig`
  (impure shell), so the reducer reads no ownership registry (#D9).
¹¹ `msg.owners` (`{panelType: ownerComponentName}`) is resolved by the dispatch
  shell from `route.resetGroupOwners()` (#D9); the map's keys decide which panels
  reset, null owner skips. `select_cancel_all` (§8.1) sweeps EVERY active per-pane
  text selection (the instance registry, incl. hidden tabs) so a stale absolute
  selection can't re-own whatever content the new group loads at that spot.

**Verdict (§4): pure TEA.** Every root arm is a pure function of `(model, msg)`.
All topology/model/clock/store/hub reads are relocated to the impure shell via
Msg stamping (exception C) — none survive in a reducer arm.

---

## 5. Modal sub-reducer Msgs (flat, delegated)

`reducer.update` checks `_SUBREDUCER_BY_TYPE` (ex-`_MODAL_BY_TYPE`) first; a hit
delegates the whole arm to that sub-reducer's `update(model, msg) → [model, cmds]`
over its own `model.modal.<name>` buffer + mode flag. The table holds **10 modal
sub-reducers** (§5.1–§5.10) **plus the `fabric` state sub-reducer** (§5.11 — not
a modal, but delegated by the same mechanism; it writes `model.fabric.*`). Shared
write helpers (`withModes` / `withModal` / `withModalMode`) live in `model-ops.js`
(pure, zero imports). Each close/commit arm **guards on its mode flag** so a stale
double-fire after the modal closed is a no-op (not a re-execution of the staged
Cmd). **All arms pure** — verified across all 11 delegates.

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
| `jobs_routed` | — | per job kind: routed/pty/agent → `set_active_tab`+`focus_set` (jump to the owning position-tab) or `focus_set` (content-slot fallback) · background/tmux → `open_doc_tab{job-info}` + `focus_set` | shell⁴ |

¹ `msg.now` threaded from handler (wall clock = exception C).
² `msg.count` (`model.jobs.length`, since FIX-1) + `msg.vh` threaded by handler
  — the reducer never reads the jobs list inline (renderer-only-reader rule, PRINCIPLES §12).
³ `msg.job` is the resolved job entry, threaded by `handleJobsKey` from
  `model.jobs` (the store-mirror'd snapshot, since FIX-1 — the same array render
  highlighted; was `feature/jobs.list()[cursor]`).
⁴ **The Phase-C split** (`docs/blessed-exceptions.md`): `jobs_activate` is a pure
  orchestrator (closes + queues group switch + emits `jobs_route`). The
  `jobs_route` *effect* runs AFTER the switch commits, reads the now-correct
  content slot in the dispatch layer, and threads the SLOT paneId + the owning
  tab's `{jumpPaneId, jumpPoolId}` (U2e P4 — was the retired `viewerTarget` /
  `tabIdx` / `targetKey`) into the pure `jobs_routed` tail — which emits only
  `set_active_tab`/`focus_set`/`open_doc_tab` from the payload. This removed the
  **last** root-reducer cross-slice value read.

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
| `menu_open` | `modes.menuOpen→true`, `modal.menu={items,idx:0,anchor,title,back}` | — | shell¹ |
| `menu_close` | closes (guarded) | — | ✓ |
| `menu_nav` | `modal.menu.idx` (skips null separators) | — | ✓ |
| `menu_activate` | closes (guarded); a `menu_back` item reopens the parent snapshot instead | `menu_action{action,arg}` (routes the picked verb back through `dispatch.handleAction`) | ✓² |
| `menu_back` | reopens the previous-menu snapshot (`mm.back`), or closes if none | — | ✓² |

¹ `msg.items` (action strings, no closures) are built from the layout slice by
  the `menu_open` handler; `msg.anchor` ({x,y} for a right-click) / `msg.title` /
  `msg.back` (the parent-menu snapshot, for submenus) threaded.
² Submenu support (the fabric `send_to_port` → port-picker step, §10.2): a submenu
  `menu_open` carries `back` = the parent snapshot; a "← Back" row or the Backspace
  key emits `menu_back`, which restores it in place rather than closing.

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

### 5.10 `fabric-field` (`modal/fabric-field.js`) — the component-ports in-grid input editor

The `component-ports` pane's field editor (docs/ports-and-wires.md, "Manual field
input = an inject"). Same shape as the cmdline/prompt editors, but the buffer edits
ONE input port's value and commits it as a sticky inject.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `fabric_field_enter` | `modes.fabricFieldMode→true`, `modal.fabricField={paneId,addr,text}` | — | shell¹ |
| `fabric_field_key` | `modal.fabricField.text` (type/backspace/Ctrl+U/paste; single-line) | — | ✓ |
| `fabric_field_submit` | commits the raw text as a sticky inject (`fabric.applyInject`) + closes (guarded) | — | ✓² |
| `fabric_field_cancel` | closes (guarded) | — | ✓ |

¹ Won't open over a live modal (`isChainActive` guard, like `prompt_enter`). The
  selected input row → `component.port` address is resolved by the
  `fabric_field_open` effect (it needs model/focus the pure pane lacks) and
  stamped on `msg.addr`.
² Submit is ONE atomic reduction — the inject write (`model.fabric.injects`) + the
  mode close, no handler cascade. Empty text injects `""` (a real, honoured value);
  use `x`/clear to remove one. The raw text is NEVER re-parsed (bind-parameter model).

### 5.11 `fabric` (`update/fabric.js`) — the dataflow-fabric state store (NOT a modal)

The single writer of `model.fabric.*` (injects / output / wires), delegated by the
root reducer via the same `{TYPES, update}` mechanism as the modals — but it holds
FABRIC state, not a modal buffer. All of `model.fabric.*` is transient (never
serialised to config) yet IN-MODEL, so it rides the WAL and replay reproduces it
(same discipline as `model.modal.continuation`). See `docs/ports-and-wires.md`.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `port_inject{port,value}` | `fabric.injects[port]={value,at}` (last-write-wins; `at` from `model.now`) | — | ✓¹ |
| `port_clear{port}` | removes `fabric.injects[port]` (identity-preserve if absent) | — | ✓ |
| `fabric_output_set{group,name,lines}` | `fabric.output[group][name]` (a producer's raw stdout, replaced per run) | — | ✓ |
| `wire_create{from,to}` | `fabric.wires` (one runtime wire per input `to`, last-write-wins; identity-preserve on a no-op re-wire) | — | ✓² |
| `wire_delete{from,to}` | `fabric.wires` (drop by exact endpoints; a config wire lives in the YAML → no-op) | — | ✓ |

¹ Injects are STICKY (persist until overwritten or cleared, NOT auto-consumed on
  run); resolve-time precedence is inject > wire > default. `at` is stamped from
  `model.now` (the frame clock) — replay-safe, never `Date.now()`. `applyInject` is
  shared with the `fabric_field_submit` modal arm (§5.10) so both paths land
  identical state.
² Shape-guarded here; wire TYPE-equality is validated at the handler (where the
  port types are in scope) so the reducer stays a pure, dependency-light transform.

**Verdict (§5): pure TEA.** Every modal arm — and the fabric state store — is pure;
all view/topology/clock/out-of-TEA reads are stamped onto the Msg by the dispatch
handler (exception C in the shell). Editing buffers, register history, cmdline
match-set selection, overlay clamps, and the fabric injects/wires are all pure
model transforms.

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
exception C; **six** Components declare one today: docker/files/history (§7.8) +
info/agent/text-view (§7.10)), then runs `comp.update(msg, slice)`.
Key events arrive as `{type:'key'}` only to the FOCUSED component, only when no
modal owns input; a component claims a key by returning a `_claimed` sentinel
effect (filtered out before `runEffects`).

**The two-tier Component update.** Every Navigator's `update` is
`mnav.isNavMsg(msg) ? mnav.apply(slice, msg) : <own handling>` — the shared nav
reducer first, the Component's own arms second. The content-slot text panes
(info/text-view/agent, §7.10) are the same shape via the shared **`tvu` reducer**
(`leaves/text/text-view-update`) — `tvu.reduce` first (scroll/search/select), the
pane's own arms second. So a Component's full Msg set = **shared reducer
(nav §7.2 / tvu §7.10)** + its **own arms**.

**Coverage:** §7.2 shared nav · §7.4 viewer/detail (RETIRED, U2f) · §7.5 layout ·
§7.6 groups · §7.8 docker/files/config-status/history · §7.9 stats · §7.10
content-slot panes · §7.11 fabric panes.

### 7.1 The Component-update / finalizer relationship

```
  dispatchMsg(wrapped) ─┐
                        ▼
   msg = comp.augmentMsg(msg, model, slice)   ← IMPURE SHELL (exc. C): stamps facts —
                        │                        e.g. a content pane stamps msg.innerH
                        │                        from the committed geometry (FIX-2)
   [next, fx] = comp.update(msg, slice)        ← PURE reducer (commits innerH; content
                        │                          panes fall through to tvu.reduce §7.10)
   route.setInstanceSlice(id, next)
   runEffects(fx)
       … (depth-0 exit) …
   finalizeDispatch()  ← reconciles instances/subs + scroll clamp + nav-capture
                          flush (NO innerH write)
```
Two seams keep derived + per-tab state pure: (1) each content pane's `augmentMsg`
stamps `msg.innerH` (the committed viewport height) and the pane's OWN `update` is
the single writer of `slice.innerH` — read for scroll clamps, never
finalizer-written (v0.6.6 FIX-2); (2) the *dispatch-runtime* `finalizeDispatch`
runs once at depth-0 exit — reconciling per-pane instances (mint/dispose) +
subscriptions, clamping scroll, and flushing a pending nav-capture. Per-tab
view-state (scroll/search/select) now rides the framework's mint reconcile +
view-state capture/restore across the slot's position-tabs (the viewer's old
in-`update` `_finalize` retired with it, U2f).

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
| `set_sort{panel?,key}` | `nav.sort{key,dir}` | sort column (null = native order); a new column resets dir→asc. Applied in `api.getItems`; from the `‹ col ›` border control | ✓ |
| `sort_reverse{panel?}` | `nav.sort.dir` (flip) | no-op while unsorted (no churn); from the sort control's label | ✓ |

**Verdict (§7.2): pure TEA.** The whole shared nav layer is a pure leaf. This is
why `actions`/`history` need zero local `update` cases — `mnav.apply` IS their
reducer (they hold no domain state beyond nav).

### 7.3 Per-Component overview (status + vocabulary)

| Component (`kind`) | File | own arms | Own Msgs (beyond the shared reducer) | § |
|---|---|---|---|---|
| **detail** (viewer) | ~~`panel/viewer/viewer.js`~~ | — | — | ⚠ **RETIRED (U2f)** — §7.4 |
| **layout** | `panel/layout.js` | ~40 | see §7.5 | ✅ §7.5 |
| **groups** | `panel/navigator/groups.js` | ~4 +nav | see §7.6 | ✅ §7.6 |
| **docker** | `panel/navigator/docker.js` | 6 +nav | see §7.8 | ✅ §7.8 |
| **files** | `panel/navigator/files.js` | 4 +nav | see §7.8 | ✅ §7.8 |
| **config-status** | `panel/navigator/config-status.js` | 4 +nav | see §7.8 | ✅ §7.8 |
| **history** | `panel/navigator/history.js` | 1 +nav | see §7.8 (effect `historyReplay`) | ✅ §7.8 |
| **actions** | `panel/navigator/actions.js` | 0 +nav | shared nav only | ✅ §7.2 |
| **stats** | `panel/monitor/stats.js` | 0 (no-op update) | `subscriptions(paneDef,model)` (#D13) | ✅ §7.9 |
| **table** | `panel/monitor/table.js` | nav + 2 (killable) | `key`/`item_action`→kill picker (`killable:` panes) | ✅ §7.9a |
| **info** | `panel/info/info.js` | 1 + shared tvu | `info_show_content` | ✅ §7.10 |
| **text-view** | `panel/text-view/text-view.js` | 5 + shared tvu | `tv_stream_start`/`tv_append`/`tv_append_lines`/`tv_set_lines`/`tv_status` | ✅ §7.10 |
| **agent** | `panel/agent/agent.js` | 3 + shared tvu | `agent_event`/`agent_activate`/`agent_input` | ✅ §7.10 |
| **terminal** | `panel/terminal/terminal.js` | 0 (no-op; foreign PTY) | — | ✅ §7.10 |
| **component-ports** | `panel/fabric/ports-pane.js` | 2 +nav | `key`(e/x/w/p/↵)→fabric effects · `fabric_pin` | ✅ §7.11 |
| **fabric-wires** | `panel/fabric/wire-list.js` | 1 +nav | `key`(d/x)→`fabric_wire_delete` | ✅ §7.11 |

The four content-slot text panes (**info** / **text-view** / **agent** — plus
**terminal**, whose grid is foreign) replaced the dissolved viewer in the U2f
one-tab-system; their route tables are §7.10. The two **fabric** panes
(component-ports / fabric-wires) are §7.11. Every Component's `kind` is its
registered `name`; `layout` registers outside `BUILTIN_COMPONENTS` (a chrome
service slot).

### 7.4 viewer/detail (`kind: 'detail'`) — ⚠ RETIRED (U2f — viewer Component dissolved)

> **This section describes code that no longer exists.** The `viewer`/`detail`
> Component, `panel/viewer/viewer.js`, `pt.reduceTabMsg`, `msg.viewerModel`, and the
> "only Component with augmentMsg" claim below were all removed in the U2f one-tab-
> system arc. The content slot is now `info` + `text-view` (+ `agent`/`terminal`)
> panes; selection/search/scroll live in the shared `tvu` reducer
> (`leaves/text/text-view-update.js`, see §7.3's text-view note); `augmentMsg` is
> declared by six Components (§7.8). Kept below as a dated record of the pre-U2f
> shape — do NOT treat it as current.

The richest Component (pre-U2f): tab routing, streaming buffers, per-tab view-state,
search, visual-mode selection. `update(msg, slice)` derived active-tab `lines`
once from `msg.viewerModel` (the threaded bundle), lifted generic tab Msgs
through `pt.reduceTabMsg`, then handled its own arms, then ran its pure `_finalize`.

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

ᴮ Reads `slice.innerH` for scroll clamps — the arm is otherwise pure; it
  doesn't write innerH. Since v0.6.6 FIX-2 `innerH` is stamped on the Msg by
  `augmentMsg` and committed by the viewer's OWN reducer (exception B retired).
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
`innerH` is read for clamps; it is stamped on each viewer Msg by `augmentMsg`
and committed by the viewer's OWN reducer (FIX-2 retired exc. B). The viewer is
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
| `set_active_tab{paneId,tabPoolId}` | `arrange` (multi-tab active switch — **transient**: no undo push, no `dirty`) + focus ★w | `show_selected_info` (if focused) | ✓ |
| `activate_tab{paneId,tabPoolId}` | — | `msg→focus_set` **then** `msg→set_active_tab` (the focus+activate pair as one reducer-owned sequence — round-4 arch T3) | ✓ |
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

(The flat `tab_drag_start`/`motion`/`release` reorder gesture + `leaves/wm/tab-drag.js`
were **deleted in U2f**: content is position-tabs now, and the flat strip the
gesture drove was never populated post-P1b. It emitted the retired
`viewer_reorder_content_tab` Msg — both are gone.)

**Verdict (§7.5): pure TEA.** Layout is the proof that a large, intricate
Component (~40 arms, drag preview, compound arrange surgery) stays a pure reducer:
all math lives in pure leaves, all cross-layer writes (mode flags, tab-activate
focus, pool re-dispatch) go out as Cmds, and the handful of topology facts are
threaded by the shell. No `getModel()`, no route-value read in any arm.

### 7.6 groups (`kind: 'groups'`) — the cascade emitter — verified

Owns `list` / `expanded:Set` / `tab` / `nav`. Shared nav (`mnav.apply`) first,
then 4 own arms. The Component that **drives the cross-layer group-switch
cascade** — but it writes only its OWN slice; `currentGroup`, per-panel resets,
and the content-pane chrome reset all go out as Cmds (single-writer per layer).
All arms pure (facts arrive via `msg.ctx` = `{groups, currentGroup, paneMenuMode,
viewerTarget, resetOwners}`, built by `nav-state._groupsCtx` in the impure shell).
Verified.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `groups_recompute{ctx}` | `list` (rebuild from `ctx.groups` + expanded) | — | shell¹ |
| `groups_selected{index,ctx}` | — (cursor already written by upstream nav_select) | if group moved: `msg→viewer_reset_chrome` **then** `set_current_group` **then** `reset_group_context` (the B5 order) | shell¹ |
| `toggle_group{name,recursive,ctx}` | `expanded` (Set) + `list` | `set_cursor` (self) + the group-change block (if moved) + `show_selected_info` | shell¹ |
| `toggle_groups_tab{ctx}` | `tab` (All↔Quick) + `list` | same cascade as `toggle_group` | shell¹ |

¹ `msg.ctx` is built by the impure shell (`nav-state._groupsCtx` →
  `groupsBundle(model)` + `route.resolveTarget('viewer')` + `route.resetGroupOwners()`),
  so the arm reads no `getModel()`/topology (#D9/#D10). `resolveTarget('viewer')`
  now resolves the content slot's ACTIVE content instance (info/text-view/agent),
  which handles `viewer_reset_chrome` via the shared `tvu` reducer (§7.10).

**The B5 ordering is load-bearing** (`_groupChangeCmds`): `viewer_reset_chrome`
MUST be emitted BEFORE `set_current_group`. The framework captures the leaving
tab's view-state (scroll/search/select) keyed by the CURRENT group; if
`currentGroup` switched first, the capture would land under the NEW group's key.
Documented at the emit site — a genuine cross-Component ordering constraint, not an
impurity. (Pre-U2f the capture was the viewer's own in-`update` finalizer; the
constraint survived the move to the framework's mint-reconcile view-state capture.)

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
      → viewer_reset_chrome      (wrapped → the active content pane:
                                    info/text-view/agent, via the tvu reducer §7.10)
```
~4 deep; the `msg`-Cmd cycle cap (32, `effects.js` T28) is the backstop.

### 7.8 Data-fetching navigators (docker / files / config-status / history) — verified

These are the Components with **async work**: their `update` arms stay pure
(`mnav.apply` first, then own arms returning `[slice, effects]`), and ALL I/O
lives in their `installEffects`-registered handlers (tier `fx`, impure by
design — they read `getModel()` and shell out). Three of them use **`augmentMsg`
to thread an out-of-TEA / model-derived fact** into the `key` arm so the arm
stays pure (the same exception-C seam the content panes use, §7.10). A recurring correctness
rule across all their effects: **route async results to the ORIGINATING
`paneId`** (`host.wrap(eff.paneId || kind, …)`), never the kind's primary — else
multi-instance panes clobber each other (the "collapse-to-primary footgun").

**docker (`kind: 'docker'`)** — `slice.{status, stats, inFlight, refreshMs, refreshLadder}`.
The container poll is a declared `interval` Sub (its `ms` = the owner's `refreshMs`,
config-seeded from the containers panel's `refresh_ms:` and stepped by the refresh
control along `refreshLadder` — the default docker ladder or a configured
`refresh_ladder:`) and `docker events` a `process-stream` Sub (FIX-3 Phase 4/5 —
the `started` flag + self-re-arm are gone); `augmentMsg` threads the CANONICAL
`apiGetItems` list (filtered + sorted), so key actions hit the visible row.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| *(content gate)* | — | — | a placed pane (`slice.paneId != null`) `return slice` for content Msgs — but nav/key/`item_action` are handled ABOVE it (per-pane), so a placed pane still drives its own selection/actions¹ |
| `key{focusKind,items}` | — | maps `msg.key` via the declared `_itemActions` list (`i`nspect·`L`ogs·`s`hell·`S`top·`R`estart·`K`ill; `label[0]` is the key) → `_itemActionCmds` (below) | shell² |
| `item_action{action,item}` | — | inspect→`dockerExec{inspect}` · logs→`dockerExec{logs}` · shell→`dockerShell` · stop/restart/kill→`run_action{docker <verb> <item>, confirm}` (the shared confirm gate). Reached identically by the bottom-bar click, the `key` arm, AND right-click — docker exposes `itemOps` (the item-ops contract, §7.9a), so all three converge on `_itemActionCmds`; `item` resolved at dispatch time | shell² |
| `refresh` / `dockerPoll` | — | `dockerFetch` (inFlight-guarded) | ✓ |
| `dockerResult{status,stats}` | `status`, `stats`, `inFlight→false` | `render` | ✓ |
| `set_refresh_ms{dir\|ms}` | `refreshMs` (owner-only; ladder step or clamp) | `render` | ✓ — re-arms the `interval` Sub (keyed `${id}:${ms}`); the sub-gate keys on `dockerRefresh` (state.js). No-op at a ladder end returns the same slice ref |

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

### 7.9a Per-pane item operations (`itemOps`) + the killable table — verified

**The contract** (`leaves/render/item-ops`): a list/table panelType declares
`itemOps(slice) → [{id, label, key?, surfaces?}]`, resolved once and rendered
across every input surface from a single source (so no surface drifts). `surfaces`
(default **both**) picks where each op appears — the bottom bar (`bottom`) and/or
the right-click menu (`menu`). All three surfaces converge on one execution:

- **bottom bar** — `itemOpsBarSpec` (`leaves/render/action-legend`) renders the
  `bottom`-surface ops (self-suppresses when there are none, keeping paint ↔
  hit-test agreement) and its click dispatches `item_action{action, item}`.
- **keyboard** — the component's `key` arm maps `msg.key` → an op → `item_action`.
- **right-click** — `_resolveContextAt` (`dispatch/control/input`) resolves the
  pointed pane's `menu`-surface ops into `[label,'pane_item_action',{paneId,id,
  item}]` rows; `buildContextItems` inserts them as a section. The
  **`pane_item_action`** verb re-dispatches the SAME `item_action{action,item}` to
  the pane, so the right-click and the bar/key share one execution.

Adopters: **docker** (`containers`, its 6 actions — now on right-click too) and
**table** (`kill`, killable panes).

**The killable table** (`panel/monitor/table.js`) — otherwise nav-only; a
`killable: true` pane (rows are pids) declares one op, `kill` (surfaces both):

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `key{focusKind,items}` | — | `focusKind==='table'` + a `key`-matching op + a rowKey that yields Cmds → `_itemOpCmds` (below) + `_claimed`; else the slice UNCLAIMED | ✓ |
| `item_action{action,item}` | — | the bottom-bar chip AND the right-click both arrive here — same `_itemOpCmds(action, item)`, so no surface drifts | ✓ |

- **`_itemOpCmds('kill', rowKey)` → `_killMenuCmds`** — `buildKillMenu` (`leaves/proc/kill-signals`) projects the pid into `[label, 'kill_signal', {pid, sig}]` rows (SIGTERM first, `[]` for a non-pid rowKey), emitted as a `msg{menu_open}` Cmd (a placed pane emits Cmds, not `applyMsg`). The pid is **frozen into every row's arg** at selection time, so a re-sort of the positional cursor can't redirect the signal.
- **`augmentMsg`** threads the CANONICAL `apiGetItems` list onto a killable pane's `key` Msg (as docker does), so `K` targets the row the paint highlighted — pure of `getModel()`.
- The picked signal runs via the **`kill_signal`** verb (§ menu_action / handleAction): `leaves/proc/kill-signals.killAction` builds the injection-proof `kill -<sig> <pid>` (whitelisted sig, guarded integer pid) → `run_action`.

**Verdict (§7.9a): pure TEA.** The arms are pure (Cmds only, no getModel); the impure menu-open, the right-click re-dispatch, and the exec all live behind effects (`msg` / `pane_item_action` / `run_action`).

### 7.10 Content-slot text panes — info / text-view / agent / terminal (the post-viewer content slot) — verified

The U2f one-tab-system dissolved the monolithic viewer (§7.4) into first-class
panes minted into a slot's `tabs[]`. Three are scrollable text buffers that share
the **`tvu` reducer** (`leaves/text/text-view-update`) for scroll / search /
select / cursor: `update` handles its OWN content arms, then falls through to
`tvu.reduce(msg, slice, lines, ownKind)` (`null` → not a tvu Msg, keep the slice).
All three stamp `innerH` via their own `augmentMsg` (the viewer-FIX-2 seam — the
pane's committed viewport height, so scroll clamps stay pure of geometry). The
fourth, **terminal**, is a FOREIGN component (its grid lives in `io/terminal`), so
its `update` is a no-op and it holds only `{cmd,label}`.

**Shared `tvu` vocabulary** (`leaves/text/text-view-update`; `ownKind` gates the
key state machine): `viewer_scroll` · `viewer_search_enter`/`_key`/`_nav`/
`_commit`/`_cancel`/`_clear_committed` · `select_begin`/`_extend`/`_cancel`/
`_set_cursor`/`_scroll_view` · `viewer_reset_chrome` (group-cascade reset — scroll/
search/select cleared, emitted by the groups cascade §7.6) · `key` (the visual-mode
machine). These are the same arms the retired viewer ran (§7.4b), now factored into
the leaf. All pure; `innerH` read for clamps, stamped by `augmentMsg`.

**(a) info (`kind: 'info'`)** — `slice.{lines, scroll, innerH, search, select,
cursor}`. The Info tab as a pane: content is INJECTED wholesale from the focused
Navigator's `getInfo(selectedItem)` projection.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `info_show_content{lines}` | `slice.lines` (wholesale replace) + `scroll=0` + search-idx reset on real change | — | shell¹ |
| *(shared tvu)* | scroll/search/select/cursor over `slice.lines` | — | ✓ |

¹ `msg.lines` is precomputed by `dispatch.showSelectedInfo` via
  `nav-state.infoLinesFromFocus` (the plugin `getInfo` read is in the shell, not
  the arm); a missing payload safely bails. `_linesEq` buys a ref-stable
  `slice.lines` across no-change refreshes (nav-select fires the arm each move).

**(b) text-view (`kind: 'text-view'`)** — `slice.{lines, statusRows, scroll,
innerH, search, select, cursor}`. The streamed / seeded content pane that
superseded the viewer's flat content-tab machinery.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `tv_stream_start{header,preamble?,append?}` | reseeds `lines` to the header (or, `append:true`, keeps the buffer + adds the run below) + clears `statusRows` | — | ✓¹ |
| `tv_append{line}` / `tv_append_lines{lines}` | appends to `lines` (bottom-stick scroll) | — | ✓ |
| `tv_set_lines{lines}` | wholesale replace `lines`, reset scroll, clear `statusRows` | — | ✓ |
| `tv_status{line}` | appends the completion line + records its index in `statusRows` (render right-aligns it — the action-status chip; its `line` carries semantic theme tokens so it tracks `:theme` at paint) | — | ✓ |
| *(shared tvu)* | scroll/search/select/cursor over `_contentLines(slice, innerW)` | — | ✓² |

¹ `preamble` is an optional line seeded ahead of the header — the unrouted-preempt
  "⊗ killed previous: X" notice that survives the reseed (§DATAFLOW; omitted when
  empty). `append:true` (per-action `output: append`) accumulates runs.
² The tvu runs over the DISPLAY-space buffer (statusRows right-aligned to `innerW`,
  the same transform render decorates + windows), so keyboard select/search
  coordinates match what the user sees.

**(c) agent (`kind: 'agent'`)** — the live-agent chat pane (docs/live-agent.md).
`slice.{transcript, status, inputDraft, history/histIdx/histStash/histEdits,
streaming, descriptor, scroll, innerH, search, select, cursor}`. The subprocess
lives off-model in `io/agent`; every visible byte is folded here by pure arms so
`frame=f(model)` and recorded Msgs re-fold on replay.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `agent_event{evt}` | folds one normalized AgentEvent → `transcript`/`streaming`/`status` (turn-start · assistant-delta/-message · tool-call/-result · status · turn-end · settled · error · exit) | — | ✓¹ |
| `agent_activate` | — | `agent_start{id,cfg}` + `msg→agent_enter` | ✓² |
| `agent_input{key,seq,selfId}` | `inputDraft` (edit) · `transcript`+`history` (send) · `scroll` (page) · draft-history recall (up/down) | send→`agent_start`+`agent_send{id,text}`; Esc→`agent_interrupt{id}` (busy) or `msg→agent_exit` (idle) | shell³ |
| *(shared tvu)* | scroll/search/select/cursor over `transcript` | — | ✓ |

¹ Backend strings route through `esc()` before entering the transcript (T32).
  `assistant-delta` folds into the provisional `streaming` line (rendered dim);
  the settled `assistant-message` supersedes it. Reducer-baked lines use named
  16-color literals ON PURPOSE (a pure reducer must not read the #D8 theme cache).
² Enter on the pane (run_selected fork): start the session idempotently, then flip
  agent mode. ³ `selfId` (the session id) is stamped by the `agentMode` key handler
  so Cmds carry it; `augmentMsg` stamps `innerH` MINUS the 2 reserved rows (status
  line + input draft), so scroll clamps against the real transcript viewport.

**(d) terminal (`kind: 'terminal'`)** — the embedded PTY as a pane (U2d). FOREIGN:
the xterm grid lives in `io/terminal`, painted by the terminal OVERLAY over the
pane's inner bounds; `render` draws only chrome. `slice.{cmd,label,onExit}`. `update`
is a **no-op** — no reducer-managed content; the PTY lifecycle (lazy spawn + resize)
is reconciled in the dispatch finalizer, keystrokes forwarded straight to the PTY.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| *(none — foreign grid; update is a no-op)* | — | — | ✓ (vacuous) |

**Verdict (§7.10): pure TEA.** The content slot is now four small panes instead of
one Component. The three text panes are pure `(msg, slice) → [slice, effects]` —
scroll/search/select factored into the shared `tvu` leaf, content arms pure, the one
model read (info's getInfo lines, agent's session id) stamped by the shell, `innerH`
stamped by each pane's `augmentMsg`. terminal is a foreign no-op. This replaced the
viewer's ~22-arm monolith (§7.4) with small, uniform, independently-testable panes.

### 7.11 Fabric panes — component-ports / fabric-wires (dataflow fabric, P1.5) — verified

The dataflow-fabric UI (docs/ports-and-wires.md). Both are pure navigators whose key
arms defer the model/focus-needing work to effects; the writes land in
`model.fabric.*` via the §5.11 sub-reducer (the panes never write fabric state
directly — single-writer per layer).

**component-ports (`kind: 'component-ports'`)** — a follows-focus INSPECTOR over a
fabric component's port surface (inputs = operate-half, outputs = check-half).
`slice.{nav, paneId, pinned, selectFrom, component}` (init-injection #4). Retargets
to the component under focus / a configured source / a runtime pin.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `key{↵}` | — | `_claimed` + `fabric_run{paneId}` (run the inspected component) | ✓¹ |
| `key{e}` | — | `_claimed` + `fabric_field_open{paneId,cursor}` (edit selected input → inject) | ✓¹ |
| `key{x}` | — | `_claimed` + `fabric_field_clear{paneId,cursor}` (clear its inject) | ✓¹ |
| `key{w}` | — | `_claimed` + `fabric_connect_open{paneId,cursor}` (summon the producer picker) | ✓¹ |
| `key{p}` | — | `_claimed` + `fabric_pin_toggle{paneId}` (pin/unpin the inspector) | ✓¹ |
| `fabric_pin{name}` | `slice.pinned` (runtime pin; null → follows-focus) | — | ✓ |
| *(shared nav)* | `slice.nav` | — | ✓ |

¹ Each `key` CLAIMS so the framework's `run_selected` default doesn't also fire; the
  selected row → `component.port` address needs model/focus, so each defers to an
  effect (§8.2). `j`/`k` etc. arrive as nav Msgs (handled by `mnav`), NOT claimed.

**fabric-wires (`kind: 'fabric-wires'`)** — the GLOBAL edge view: every wire (config +
runtime, merged), its current value + validity, plus delete. Stateless render over
`listWires()`; `slice.{nav, paneId}`.

| Msg | Writes | Emits | Purity |
|---|---|---|---|
| `key{d\|x}` | — | `_claimed` + `fabric_wire_delete{paneId,cursor}` (runtime wires only) | ✓¹ |
| *(shared nav)* | `slice.nav` | — | ✓ |

¹ The row address needs model access, so `fabric_wire_delete` (§8.2) resolves it; a
  config-authored wire warns "edit the YAML" instead of deleting (config wires aren't
  runtime-editable).

**Verdict (§7.11): pure TEA.** Both fabric panes are pure navigators: shared nav + a
handful of key arms that emit effects, no fabric-state write in any arm. All
`model.fabric.*` writes go through the §5.11 sub-reducer (via the `port_inject` /
`port_clear` / `wire_create` / `wire_delete` / `fabric_output_set` Msgs those effects
dispatch), preserving the single-writer invariant.

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
| `force_full_repaint` | `renderQueue.forceFullRepaint()` | no |
| `show_selected_info` | `dispatch.showSelectedInfo(eff.paneId?)` → resolves focused info lines → the content slot's info pane | yes (→ `info_show_content`) |
| `open_doc_tab{key,label,lines}` | `content-tab.addContentTab(currentGroup, …)` — mint a text-view content tab (the jobs job-info card's reducer-side entry, ex-`viewer_set_content`) | via mint |
| `_claimed` | no-op (sentinel consumed earlier in `dispatchKeyToFocused`) | no |
| `kkp_suspend` / `kkp_resume` | `io/term.suspendKKP()` / `.resumeKKP()` — drop to legacy key encoding while an embedded child owns the terminal, restore on exit | no |
| `edit_file{path,isConfig}` | `edit.editFile(…)` — open the file in the user's editor (files pane `e`); synchronously re-enters (mint/focus/view/mode Msgs) | yes (T28 cap) |
| `select_cancel_all` | sweep the instance registry (`select-view.allSelections`) → a wrapped `select_cancel` per owner (incl. hidden tabs) | yes (per selection) |
| `do_run` / `run_action` | `setImmediate` → `action-runner.doRun/runAction` (spawn after the overlay-gone frame paints) | via action lifecycle |
| `unrouted_preempt_and_run` | kill prior stream + start new (`stream.killJob`+`streamCommand`) | via stream |
| `agent_start{id,cfg}` / `agent_send{id,text}` / `agent_interrupt{id}` | drive the off-model `io/agent` session (idempotent start / send a turn / interrupt the in-flight turn) | via async `agent_event` Msgs |
| `jobs_route` | reads post-switch content slice, threads tab → `applyMsg(jobs_routed)` | yes (the read-then-Msg pattern) |
| `nav_capture` | marks the jumplist dirty (`_navDirty`); the depth-0 finalizer reads post-commit coords → one `nav_record` Msg | deferred (finalizer → `nav_record`) |
| `nav_restore{loc,dir}` | resolve a stable location → a LIVE address; re-fire `set_current_group`/`focus_set`/`set_active_tab`/`set_cursor` (all `noCapture`); a dead group → `nav_prune` + continue in `dir` | yes |
| `copy_commit` | `copy.copySelect(idx,label)` → OSC52, then `copy.clearOptions()` | no |
| `emit_osc52` | `io/term.emitOSC52(text)` (clipboard) | no |
| `cmdline_rebuild` | re-query registry → `applyMsg(cmdline_set_matches)` | yes (read-then-Msg) |
| `cmdline_run` | `cmdline.runAt(sel,args,display)` | via action |
| `cmdline_clear` | `cmdline.clear()` | no |
| `cmdline_preview` / `cmdline_revert_preview` | live-preview apply / teardown (e.g. theme) | no |
| `menu_action` | `dispatch.handleAction(action, arg)` (or `focus_panel:<h>`) — verbs incl. `send_to_port`/`port_inject`/`kill_signal` (§7.9a: `killAction` → `run_action`) / `pane_item_action` (§7.9a: re-dispatches `item_action` to a pane — the right-click twin of the bottom item-op bar) | yes |
| `run_binding` | `Promise.resolve(eff.run()).catch(...)` (resolved leader leaf) | via action |
| `diag_clear` / `diag_save` | `io/diag-log.clear()` / `.save()` | no |

Also note: `refireCmdlineRebuild` (handed to the feature-host port, not a
registered Cmd) re-fires the dropdown rebuild after an async completion fetch
(docker dir listing) resolves. Two effects were **retired**: `destroy_pty_session`
(U2d P2b — its only emitter was the dissolved viewer's
`viewer_remove_ephemeral_terminal`; terminal panes now dispose via the finalizer's
instance reconcile), and `set_theme` (#D8 — palette now projected from
`model.theme` at render entry).

### 8.2 Component-contributed effects (registered via each Component's `installEffects`) — verified

All tier `fx` (impure by design — they read `getModel()` and shell out, then
fold results back as Msgs). Each routes its result Msg to the **originating
`paneId`** (`host.wrap(eff.paneId || kind, …)`) to avoid the collapse-to-primary
footgun.

| Cmd | Owner | Body / re-entry |
|---|---|---|
| `dockerFetch` | docker | `setImmediate` → `docker inspect`/`docker stats` exec; `hub.publish('docker.stats')`; → `dockerResult` Msg. Reads `getModel().focused` (skip when blurred, still clears `inFlight`). |
| `dockerExec{mode,item}` | docker | `applyMsg(terminal_exit)` + `host.streamCommand(inspect|logs)` |
| `dockerShell{item}` | docker | `addEphemeralTab(getModel().currentGroup, …)` (exec interactive shell) |
| `loadDir{paneId,source,cwd,…}` | files | `setImmediate` → `readdir`/`dockerList` → `dirLoaded` Msg (wrapped to `paneId`) |
| `openFile{paneId,item}` | files | open as content tab via the open-target scheme registry (`feature/open-file` / `open-docker`) |
| `resetPanelChrome{paneId}` | files | dispatch `set_cursor`+`set_scroll`+`clear_filter` (wrapped to `paneId`) — re-home on dir nav |
| `cfgStatusCompute{branch,files,projectDir,paneId}` | config-status | `setImmediate` → git status off-tick → `cfgStatusResult` Msg (wrapped to `paneId`) |
| `cfgStatusDiff{item,branch,projectDir}` | config-status | `setViewerContent(diff)` |
| `historyReplay{entry}` | history | `setViewerContent(replayLines, {tab:0})` (single dispatch — override + land on Info) |
| `fabric_field_open{paneId,cursor}` | component-ports | resolve row → addr → `applyMsg(fabric_field_enter)` (seed the field editor with the port's current inject) |
| `fabric_field_clear{paneId,cursor}` | component-ports | resolve row → `applyMsg(port_clear{port:addr})` |
| `fabric_connect_open{paneId,cursor}` | component-ports | build the compatible-producer picker (type-matched, current wire floated + tagged) → `applyMsg(menu_open)` (→ `wire_create` on pick) |
| `fabric_run{paneId}` | component-ports | resolve component → `host.runActionByKey(name)` (the existing action dispatch; no new run path) |
| `fabric_pin_toggle{paneId}` | component-ports | resolve component → `dispatchMsg(wrap(paneId, fabric_pin{name}))` (runtime pin toggle) |
| `fabric_wire_delete{paneId,cursor}` | fabric-wires | resolve row; runtime wire → `applyMsg(wire_delete)`; config wire → diag warn ("edit the YAML") |
| `test_fx` / `test_wrapped_fx` | test harness only | — |

---

## 9. Purity verdict + blessed-exception index

### 9.1 Verdict (reducer + modal + Component + effects + producers — all traced)

**lazytui is pure TEA at the decision layer.** All 30 root-reducer arms and every
modal + fabric-state sub-reducer arm (§5) are pure functions
`(model, msg) → [model, cmds]` returning new immutable state and Cmd descriptors.
No reducer arm reads `getModel()`, the wall clock, a store/hub bus, or
Component-slice values to branch — every such fact is **stamped onto the Msg by
the impure shell** (handlers / effects / the mirror Subs). That relocation is the
single recurring "impurity", and it is *blessed-exception C* by design.

The genuinely mutable surface is **concentrated and named**:
- the **impure shell** (`dispatch/control/*` + `effects.js`) — reads + I/O (exc. C);
- the **#D5/#D14 boundary** — render reads the terminal island only (the PTY
  screen buffer via `io/terminal.getSession` + dims via `io/term.cols/rows`), a
  non-TEA region; the former off-model stores (jobs/diag/history/metrics) are
  now under the model via the store-mirror / metrics-mirror Subs (FIX-1 / Finding B).

(Exception **B** — the finalizer's `innerH` same-slice write — was RETIRED in
v0.6.6 FIX-2; innerH is now threaded onto each content pane's Msgs and
reducer-committed by that pane (§7.10). §9.2.)

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
| `run_selected` | context-dependent: focused `terminal` pane→`activateTerminal`→`terminal_enter`; focused `agent` pane→`msg→agent_activate`; action tab→`_runResolvedAction`→`prompt_enter` or `run_action` fx; groups branch→`msg→toggle_group`, leaf→`msg→focus_set(actions)`; actions→`_runResolvedAction`; else→`dispatch.showSelectedInfo`→`info_show_content` |
| `next_tab`/`prev_tab` | `applyMsg(next_tab/prev_tab + _viewerTabBundle)` → `set_active_tab` (layout) |
| `page_up`/`page_down` | content pane→`msg→viewer_scroll{delta}` (tvu); list→`_pageInListPanel`→`nav_select` |
| `goto_top`/`goto_bottom` | content pane→`msg→viewer_scroll{to}` (tvu); list→`_jumpInListPanel`→`nav_select` |
| `view_expand`/`view_shrink` | `msg→view_expand/shrink` (layout; `freeConfigMode` stamped) |
| `toggle_collapse_focused` | `msg→panel_collapse_toggle` (layout) |
| `filter` | `dispatch._enterFilterMode` → `filter_enter` |
| `free_config` | `applyMsg(free_config)` |
| `copy_text` | `applyMsg(register_push)` |
| `send_to_port` | right-click → `applyMsg(menu_open)` (input-port picker; each row → `port_inject`) |
| `port_inject` | `applyMsg(port_inject{port,value})` (the picked port + selection value; also the P2 agent's push primitive) |
| `wire_create` | type-validate, then `applyMsg(wire_create{from,to})` (mismatch → diag warn, no wire) |
| `ctx_run_action` | `_runActionByKey` → `_runResolvedAction` (`prompt_enter` / `run_action`) |
| `ctx_run_command` | `cmdline.runCommandString` |
| `refresh` | `api.refreshAll()` (direct async — broadcasts `refresh`) |
| `show_help` | `overlay/help.showHelp()` (direct) |
| `quit` | `cleanup()` + `process.exit(0)` — **the one terminal action that is NOT a Msg** |

`_viewerTabBundle` / the groups `ctx` build / `freeConfigMode` reads here are the
**fact-threading** that keeps the downstream reducer arms pure (the footnotes
throughout §4–§7). Same model: read once in the shell, stamp onto the Msg.

---

## 11. Completeness verification (loops 5 + 6)

A grep-diff of the catalog against the whole `js/` tree (excl. tests). Loop 5
(2026-06-24) proved the original set; **loop 6 (2026-08-14) re-ran it against
current source** and reconciled every drift.

- **Every reducer / modal / fabric-state Msg type is documented.** Loop 6
  cross-checked every `case '…'` in `reducer.js` + `modal/*.js` + `fabric.js`
  against §4/§5: the 30 root arms and all 11 sub-reducer `TYPES` sets match. New
  since loop 5 — the agent/kkp/mirror/jumplist root arms (§4), the `fabric-field`
  modal (§5.10), and the `fabric` injects/output/wires store (§5.11). Two arms the
  loop-5 tables had missed were caught and added: `menu_back` (§5.8) and the
  round-4 `activate_tab` layout arm (§7.5c).
- **Every Component Msg is documented.** The dissolved viewer's arms now live in
  the shared `tvu` leaf (`leaves/text/text-view-update`) + the four content panes
  (§7.10); `info_show_content` / `tv_*` / `agent_*` / the fabric-pane keys are all
  catalogued (§7.10 / §7.11). `viewer_set_viewport` (the old comment-only Msg) went
  with `panel/viewer/viewer.js`. The 5 camelCase navigator Msgs (`dockerPoll`,
  `dockerResult`, `dirLoaded`, `showHidden`, `cfgStatusResult`) stay in §7.8.
- **Every effect is documented.** All 30 framework `registerEffect('…')` types
  (effects.js) appear in §8.1 and the component effects in §8.2, or are test-only
  fixtures. New since loop 5 — kkp_suspend/resume, edit_file, select_cancel_all,
  open_doc_tab, agent_start/send/interrupt, nav_capture/restore (framework) + the
  six fabric effects (component). `destroy_pty_session` retired (U2d P2b); the
  `dockerTick` / `dockerEventsStart` Msgs stayed retired (interval / process-stream
  Subs, FIX-3).
- **The non-Msg `case` strings** the broad grep surfaces are the input-verb /
  intent / key vocabulary (§10) — producers, not Msgs. The fabric verbs
  (`send_to_port` / `port_inject` / `wire_create`) were added to §10.2.
- **Shared nav Msgs** (`leaves/wm/nav.js` `NAV_TYPES`) all in §7.2, incl. the
  border-control `set_sort` / `sort_reverse` arms.

**Two DATAFLOW.md lags found and fixed (2026-06-24):**
1. Its single-writer note still listed `viewer.slice.tabBounds` as "the last
   remaining render-side slice write." That predated blessed-exceptions A.3
   (2026-06-14) — `tabBounds` is now compute-on-read (`viewer.tabBoundsFor`),
   and **render writes NO slice state at all**. Moved the bullet into the
   RETIRED section; §7.4(c) reflects the current state.
2. Its EFFECTS box listed `quit` among effects; `quit` is actually a
   `handleAction` verb (§10.2) handled directly in the shell (`process.exit`),
   not a registered Cmd. Removed from the box; §8 is the accurate Cmd registry.

**Final verdict (catalog re-verified 2026-08-14):** lazytui is **pure TEA at the
decision layer** — every Msg type (the 30 root arms, the 11 sub-reducers, every
Component arm) resolves to a pure reducer `(state, msg) → [state, cmds]`, and every
side effect is a data descriptor run by one interpreter. Two years of features
(one-tab-system, live-agent, the dataflow fabric, kitty-keyboard, the mirror Subs,
the jumplist) added arms and Components but **no new mutable surface**: the mutable
surface is still **concentrated, named, and commented** — exception **C** (the
impure-shell reads: the input verbs of §10, the `augmentMsg` hooks of §7, the
mirror Subs, and the effect bodies of §8, all reading the model/store/registry and
threading facts forward so reducers stay pure), and the **#D5/#D14 boundary**
(render reads the model everywhere; the one off-model read is the terminal island —
the PTY screen buffer + term dims — a non-TEA region). Exception **B** (the
finalizer's `innerH` write) was RETIRED in v0.6.6 FIX-2. There is **no scattered
mutation** — the impurity is exactly the shell the pure core is wrapped in, by design.

---

## 12. Loop tracker

- **Loop 1 (2026-06-24, done):** framework + arch view + purity model; §4 root
  Msgs (19, verified); §5 modal Msgs (9 modals, verified); §6 broadcast; §8
  effects (framework set verified, component set listed); §9 verdict + exception
  index. Sources read in full: `loop.js`, `reducer.js`, `finalize.js`,
  `effects.js`, `store.js`, `model-ops.js`, all 9 `modal/*.js`, `nav-state.js`,
  `PRINCIPLES.md`, `DATAFLOW.md`, `blessed-exceptions.md`.
- **Loop 2 (2026-06-24, done):** §7.1 the Component-update/finalizer
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
  proved every Msg/effect is documented (incl. the 5 camelCase Component Msgs +
  all 34 effects; `viewer_set_viewport` confirmed comment-only). Added §10 — the
  **input-verb layer** (`intent.realize` + `handleAction`) so each feature is
  traceable end-to-end from its entry verb to its Msg. Noted 2 DATAFLOW.md lags
  as observations (no edits — task is doc-only, no refactor). Sources read in
  full: `intent.js`, `actions.js`. Final verdict restated in §11.
- **Loop 6 (2026-08-14, done — FULL RE-AUDIT):** reconciled the whole catalog with
  ~2 years of shipped features against current source. §4 grew 19→30 arms (agent /
  kkp / mirror / jumplist); §5 gained the `fabric-field` modal + the `fabric`
  state store (9→11 sub-reducers); §7.4 viewer stamped RETIRED (U2f), replaced by
  the content-slot panes (**new §7.10** info/text-view/agent/terminal + shared
  `tvu` leaf) and the fabric panes (**new §7.11** component-ports/fabric-wires);
  §8 gained 10 framework + 6 component effects (`destroy_pty_session` retired); §10
  gained the fabric verbs. Two drifts the loop-5 tables had missed were caught
  (`menu_back` §5.8, `activate_tab` §7.5c). Every purity verdict re-held. Sources
  read in full: `reducer.js`, `fabric.js`, `modal/fabric-field.js`, `effects.js`
  (builtins), `app/state.js` (Subs), `panel/{info,agent,terminal}/*`,
  `panel/fabric/{ports-pane,wire-list}.js`, `leaves/text/text-view-update.js`,
  `dispatch/control/actions.js`.

**Status: COMPLETE (re-verified 2026-08-14).** Sections §1–§11 cover the
architecture view, the purity model, every Msg route (root / modal / fabric-state
/ Component / broadcast), every effect, the producer (verb) layer, and the
blessed-exception index — all verified against current source. What remains is OUT
OF SCOPE by the task's own terms ("don't refactor, just write the code case down"):
the **refactor discussion** (§9 lists the live exception C + the #D5/#D14 boundary
as the candidates). Re-invoke the loop only to (a) deepen a specific Component,
(b) re-verify after code changes, or (c) open the refactor conversation.
