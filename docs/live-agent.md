# Live agent — design spec

> **Status:** BUILT + LIVE-VALIDATED — Phase A (slices A0–A6) shipped on the
> `live-agent` branch; the mock backend is exercised end-to-end (unit + smoke
> + replay), the Pi backend against a wire-exact fixture
> (`js/test/fixtures/fake-pi.js`) AND live against an installed **pi 0.82.1**
> — including a full **agent turn with a real tool execution** driven by a
> local scripted model (§"Live validation without credentials"): streaming
> deltas, tool_execution_start/end (pi really ran the bash tool), settled
> text + usage folds, the retry/error paths, footer/jobs/close/teardown.
> The validation caught one real fold bug (multi-line errors), fixed. Only
> a credentialed run against a REAL provider remains as an optional final
> smoke. §"As built" collects where the implementation refined this design.
>
> This spec models a *live, long-lived agent* as a **managed
> structured-protocol subprocess** — an extension of lazytui's existing
> streaming machinery (`dispatch/runtime/stream.js` + `feature/jobs` + the
> `text-view` instance), staying in **pure TEA**. It is deliberately **not** a
> [foreign component](foreign-components.md) (§"Why not a foreign component").
> The generalized part is the **agent-backend seam**: lazytui owns the
> *live-agent concept*, and a concrete agent (Pi, an in-process SDK loop, …)
> is a pluggable *backend*.

## Why a *live* agent, not a one-shot node

A one-shot `run:` node (`pi -p "…"`) is stateless: fresh agent, no memory, no
ongoing tool use — a nondeterministic *function call*, not an agent. It also
fights the fabric's grain (deterministic / pull-at-invoke) and breaks replay. In
an *operational cockpit* the valuable thing is an agent that **lives in the
cockpit**: holds context, streams a turn, uses tools over time, and (later)
watches the dataflow. That is a long-lived, stateful, side-effectful subprocess we
*drive*, not a function we *call*.

## Why *not* a foreign component

The terminal (`io/terminal.js`, `#D14`) is a foreign component because its
contents — an xterm emulator grid (cursor, scrollback, ANSI state) — are
**un-modelable state you must not re-implement as a reducer**. An agent has no
such state. Apply the foreign-component contract's own three gates:

| Agent surface | (1) foreign reactive system | (2) high-frequency | (3) not replayable from Msg log | Verdict |
|---|---|---|---|---|
| The subprocess handle | it's an IO resource, not un-modelable state | — | — | off-model, but that's true of every `spawn` (`stream.js`'s `procs` map) — **not** a foreign exception |
| In-flight token stream | yes | yes | yes-ish | only this could qualify — and only if we demand silky per-token render (optional polish, §Streaming) |
| **Settled transcript** | no | **no** — coarse turns | **no** — foldable as Msgs | **fails the gates → MODELED, not foreign** |

The settled transcript is coarse, structured, low-frequency text — **exactly what
`stream.js` already folds into a `text-view` instance today** (action output, the
Transcript tab). It is modelable, so it must *not* be a foreign component.

Decisive point: a second foreign component is a **second blessed exception** to
`frame = f(model)`, and lazytui's standing policy is *drive blessed exceptions
toward empty, never add one*. The managed-stream framing adds **zero** exceptions.

## The model — a managed structured-protocol subprocess

lazytui already spawns processes, tracks them in an off-model `procs` map, folds
their output into `text-view` instances, and registers them as jobs for the
`<leader> j` overlay (`dispatch/runtime/stream.js`, `feature/jobs`,
`panel/text-view`). A live agent is that, extended in **three** ways:

1. **Long-lived** — the process does **not** close on turn-complete; it stays open
   across many turns (a session), until the pane closes or the app quits.
2. **Structured** — its stdout is a **JSONL event stream** (the backend protocol),
   parsed by a backend adapter into normalized events — not raw display bytes.
3. **Bidirectional** — lazytui **writes to its stdin** (`send` a message,
   `interrupt`). `stream.js` is output-only today; this is the one genuinely new
   capability.

| Surface | Home | Precedent |
|---|---|---|
| Subprocess handle, in-flight parse buffer | off-model store (`io/agent.js`, like `stream.js`'s `procs`) | any spawned process |
| Turn status (idle / thinking / tool / error), cost/tokens | **modeled** (instance slice) | job/overlay state |
| Settled transcript (messages, tool calls + results) | **modeled** `text-view` lines | action output, Transcript tab |
| Descriptor (backend, model, resumable session id, label) | **modeled** | any pane config |

Everything the user sees is a pure function of the model; the subprocess is an IO
resource at the edge, exactly like a streamed action.

## The backend-adapter seam (the generalized part)

The runtime owns lifecycle, event-folding, jobs, and the pane; it does **not** know
how to talk to any specific agent. That lives behind a **backend adapter** — the
generalization the whole design turns on:

```js
/**
 * @typedef {Object} AgentBackend
 * @property {(cfg) => Handle}                  start   Spawn/open a long-lived session.
 * @property {(h, message, opts) => void}       send    Deliver a user message (opts: images, steer/followUp).
 * @property {(h) => void}                       interrupt   Cancel the in-flight turn.
 * @property {(h) => void}                       stop    Tear the session down.
 * @property {(h, (evt: AgentEvent) => void) => void} onEvent  The NORMALIZED event stream.
 */
```

The crux is the **normalized event vocabulary** every backend maps onto — get this
right and any agent plugs in; get it wrong and it leaks one backend's idioms:

| Normalized event | Meaning | Becomes |
|---|---|---|
| `turn-start` | assistant turn began | status Msg |
| `assistant-delta {text\|thinking}` | streaming increment of the current turn | transcript fold into the provisional streaming preview (throttled at the backend, §Streaming) |
| `assistant-message {text}` | a turn's assistant text settled | transcript fold (the `agent_event` arm) |
| `tool-call {id, name, args}` | agent invoked a tool | transcript fold (one `→ name(args)` line) + tool spinner |
| `tool-result {id, result, isError}` | tool finished | transcript fold (`←`/`✗` block) |
| `status {state, tokens?, cost?}` | idle/thinking/tool/compacting/retrying | status merge |
| `turn-end` | assistant turn completed | flush pending settle |
| `settled` | session idle, nothing queued | status Msg (drives input-ready) |
| `error {message}` | backend/turn error | transcript fold (red `✗` line) |
| `exit {code}` | session ended | lifecycle Msg |

Input commands map the same way: `send`, `interrupt`, `stop`, plus optional
`set-model` / `set-thinking`.

## Backend: Pi via `pi --mode rpc`

Pi's RPC mode is a clean fit (why "then Pi is easy"). It is **JSONL over stdio**
(one JSON object per line — *not* JSON-RPC 2.0), started with
`pi --mode rpc --provider <p> --model <m>` (no trust prompt in non-interactive
mode). Pi owns provider/keys/context/compaction, so lazytui stays thin and
provider-agnostic. Mapping:

| lazytui seam | Pi RPC |
|---|---|
| `start(cfg)` | spawn `pi --mode rpc …` (a long-lived job in the `procs` map) |
| `send(h, msg)` | write a `prompt` command line to stdin (`streamingBehavior: steer/followUp` rides the same command) |
| `interrupt(h)` | write an `abort` command |
| `stop(h)` | close stdin / kill the child |
| `assistant-delta` | `message_update` → `assistantMessageEvent` (`text_delta` / `thinking_delta`) |
| `assistant-message` | `turn_end` message text (`message_end` unused — §As built) |
| `tool-call` | `tool_execution_start` (`toolCallId`, `toolName`, `args`) |
| `tool-result` | `tool_execution_end` (`result`, `isError`) |
| `status` | `agent_start` / `compaction_*` / `auto_retry_*` |
| `settled` | `agent_settled` |
| `error` | error / `extension_error` events |

Pi's RPC has **no built-in tool-approval gate** (bash / file edits run once
queued) — same trust posture as lazytui's embedded terminals (§Trust).

A second backend — a raw `@earendil-works/pi-ai` (or OpenAI SDK) **in-process
loop** — should also be built, *specifically to prove the seam is backend-agnostic*
and to have a non-subprocess option. Caveat: `pi-ai` may be ESM-only while lazytui
is CJS/`require` (the mismatch that killed the Vercel AI SDK route); the subprocess
backend sidesteps this entirely, which is why it goes first.

## Data flow (concrete)

```
user types → send Cmd → io/agent.send(id, msg) → backend stdin
backend stdout (JSONL) → adapter → normalized events → injected handler
   → dispatchMsg(coarse event)                        (NEVER writes the model directly)
       → reducer folds into the agent slice's transcript (the agent_event arm)
       → reducer updates turn status on the agent slice
render = f(model): the transcript + status, painted by the text-view pane
```

Lifecycle mirrors a streamed action: `io/agent.start` registers a job
(`feature/jobs.register`), coarse events dispatch through `dispatch/runtime/loop`
(so they're recorded), and `stop`/`exit` closes the job (`jobs.close`). Turns show
in the `<leader> j` overlay for free.

## The agent pane

A new pane type minted like any other (`mint_tab` with `paneType: 'agent'`, the
same primitive `text-view` / `terminal` use, on the U2 position-tab system):

- Backed by a **`text-view`-style transcript** (its OWN line buffer; scroll /
  search / select) plus a small **status line** and an **input draft**.
- **Agent-mode input** (analogous to terminal-mode): keystrokes compose a message;
  Enter `send`s, Esc leaves, a chord `interrupt`s. Routed in
  `dispatch/control/dispatch.js` (the `agentMode` modeChain handler),
  beside the other modal-mode handlers; terminal raw-stdin stays in input.js.
- Render is pure `f(model)` — no `getSnapshot`, no overlay.

## Replay

Because the transcript and status are **modeled** and coarse events enter through
the dispatch loop, they are recorded by the normal `recordMsg` path — so replaying
the Msg log reconstructs the agent view **without re-calling the LLM**, exactly as
a streamed action's appends replay. Replay **skips effects**, so `io/agent.start`
never spawns a backend; the recorded coarse Msgs re-fold the transcript. **No
side-channel, no `agent` WAL kind** (unlike the terminal's byte stream). Cap the
transcript (like the Transcript tab's 1000-line cap) so checkpoints stay small.

*Streaming caveat:* if we throttle-sample `assistant-delta` into the model
(§Streaming), those samples are Msgs too and replay faithfully; if we keep
in-flight deltas purely transient (spinner only), replay simply shows settled
turns — which is what you want.

## Streaming — the one thing "foreign" would have bought

Per-token live typing is model-pure — no foreign exception. Two options, both shipped:

1. **Spinner + settle** — a "thinking… (tool: …)" status while a turn runs; the
   settled `assistant-message` folds when it lands. Zero per-token cost. This is
   the fallback whenever a backend emits no deltas (a scripted mock turn, a
   backend without streaming).
2. **Throttled delta (BUILT, the default when a backend streams)** — the backend
   adapter coalesces `message_update` text deltas to ~10 Hz `assistant-delta`
   **increments** (the `metrics-mirror` throttle, `PRINCIPLES.md` §12; the pi
   backend gates on `STREAM_THROTTLE_MS`). The fold appends each increment to a
   separate `slice.streaming` field — rendered as a dim **provisional trailing
   line** below the settled transcript — which `assistant-message` clears and
   replaces on settle (so the transcript ring stays append-only, one
   authoritative line per turn). Increments, not accumulated snapshots, keep the
   WAL **linear** in message length; each is a recorded Msg, so replay rebuilds
   the preview progressively and smoothly (or, since the preview clears on
   settle, a checkpoint past the turn simply shows the settled line). thinking /
   toolcall deltas are not streamed (the status line covers "thinking…").

Neither needs a foreign exception. Accepted cost of option 2: ~10 extra small
Msgs/sec/turn in the WAL between checkpoints — bounded by the throttle + the
transcript cap, and the price of smooth replay.

## Session continuity across a restart

The subprocess dies with the app (like any spawned process); the **transcript
survives in the model**. To *continue the conversation* after a restart, the
descriptor carries a durable **backend session id** and `start` resumes it (Pi
persists sessions to JSONL and exposes `switch_session` / `get_entries`; for
pi the durable id IS the session file path — the pane-config `sessionId` knob
feeds `switch_session` directly). Fresh vs. resumed is a descriptor flag — no
foreign machinery.

## Phase B — the agent as a fabric node (DESIGN)

> **Status:** design, decisions pending (§Phase-B open decisions). Phase A is
> shipped (v0.6.9); this section replaces the earlier sketch. Phase C
> (fabric-as-tools: a Pi extension exposing lazytui's ports/components as
> tools, so the agent can *read and drive the cockpit*) stays furthest out.

The whole design rides three seams that already exist — no new fabric
semantics, no new UI:

1. **Identity — a pane-declared component.** The agent pane's config gains
   `name:` (a dot-free fabric name) plus the standard `ports:` / `parse:`
   blocks. `wireFabricHost`'s `componentSpec` / `listComponents` merge a
   SECOND component source — agent panes in the layout — over the action
   set. That one host extension buys everything downstream: the agent
   appears in `listPorts()`, so the **component-ports pane inspects it, the
   connect-to picker wires it, source badges + readiness ✓/✗ render, and
   the wire list shows its edges — all for free** (the P1.5 surface is fed
   entirely by `listPorts`/`portValue`). Group binding: fabric is
   same-group (P1); the agent binds to the group current at mint (stamped
   on the descriptor) so a pane that persists across group switches keeps a
   deterministic fabric home.

2. **Outputs — publish on settle, parse with the existing machinery.** The
   `assistant-message` fold already has the raw text; the slice keeps the
   last turn's raw message, and the `settled` fold arm emits a
   `fabric_output_set {group, name, lines}` Cmd — the SAME recorded Msg a
   `run:` producer's close dispatches. `componentLines` then reads
   `model.fabric.output[group][name]` unchanged, `parse:` + `ports.out`
   project typed values, downstream wires pull them. Because the publish is
   a recorded Msg from a pure reducer arm, **replay re-publishes the
   agent's outputs identically — zero new replay machinery** (the
   replay-as-debugger property extends over the agent's dataflow edges).
   Scope: the final settled assistant text per turn (tool-results are
   intermediates; the settled message is "the result").

3. **Inputs — resolve at send, the pull-at-invoke grain.** Enter runs the
   agent's `ports.in` through the SAME `resolveInputs` (inject > wire >
   default) the `run:` hook uses, in the send path (the impure shell
   resolves; the reducer receives the resolved bundle — the
   handler-stamped-Msg pattern). `{{hole}}` substitution in the TYPED
   MESSAGE mirrors the `run:` argv template: the user writes
   `analyze {{start_lsn}}` and the hole fills with the wired/injected
   value at send. A required input that doesn't resolve blocks the send
   with the error-and-tell readiness message (P5 grain, folded into the
   transcript). The transcript's `›` user line records the FILLED message —
   what was actually sent, replay-faithful.

Reactive re-run ("the agent watches the dataflow" without a keystroke)
stays with P3 subscribe/push, where it belongs.

### Phase-B open decisions

1. **Input-injection shape** — *proposed:* `{{holes}}` in the typed message
   as the primary mechanism (explicit, deterministic, the bind-parameter
   grain), plus an opt-in pane flag (`context: auto`) that prepends ALL
   resolved input ports as a context block when the draft has no holes —
   for the "ambient context" chat style. Alternatives: holes-only (purist),
   or always-attach (magical). Confirm the hybrid or pick a pole.
2. **Output scope** — *proposed:* last settled assistant text per turn.
   Alternative: also publish tool-results under reserved port names.
   Confirm.
3. **Group binding** — *proposed:* stamp the fabric group at mint
   (descriptor carries it; deterministic across group switches). Alternative:
   publish into the group active at settle. Confirm.
4. **Send-gating** — *proposed:* a required unresolved input BLOCKS the send
   (error-and-tell in the transcript). Alternative: send anyway with the
   hole left literal. Confirm.

### Phase-B slice plan (draft — pending the pins)

| # | Slice | Deliverable | Test |
|---|---|---|---|
| **B0** | Identity | pane-config `name`/`ports`/`parse` schema validation (dot-free, name-collision vs actions) + the host's second component source | agent appears in `listPorts`; ports-pane inspects it (smoke) |
| **B1** | Outputs | raw last-message on the slice + `settled` → `fabric_output_set` Cmd; wires agent.out → consumer resolve | fold → publish → `portValue` reads it; replay re-publishes |
| **B2** | Inputs | send-path `resolveInputs` + `{{hole}}` fill + readiness gate | wired/injected/default/missing matrix; filled `›` line; blocked send |
| **B3** | Context opt-in + polish | `context: auto` (if pinned), docs, CHANGELOG | context block content pinned |
| **B4** | Worked demo | a real pipe: producer.port → agent.in, agent.out → consumer `run:` (mock-model scripted; the §Live-validation recipe for pi) | e2e through the real loop |

## Trust

An agent that runs tools (bash, file edits) has the same posture as lazytui's
embedded terminals, which already spawn shells: it operates on the workspace with
the user's authority. Pi's RPC exposes no approval gate, so the trust boundary is
"you launched a config that declares an agent pane" — same as declaring a
`terminal:` or a `run:` action. A future approval seam (gate `tool-call` before
`tool-result`) is possible but out of scope.

## Phasing

- **Phase A — the standalone live-agent primitive.** Extend the streaming machinery
  to long-lived + structured + bidirectional (`io/agent.js` + the backend-adapter
  seam + the normalized vocabulary + the Pi-RPC backend), fold coarse events into a
  `text-view` transcript, add the `agent` pane + agent-mode input, spinner-status +
  replay-for-free. A chat agent living in a cockpit pane, no fabric coupling. Proves
  the whole thesis, adds no blessed exception.
- **Phase B — fabric coupling.** Agent input ports (context injection) + output
  ports (structured results) + reactive re-run once subscribe (P3) lands.
- **Phase C — fabric-as-tools.** The Pi extension exposing lazytui to the agent.

## Phase-A build plan

> **SHIPPED** — all seven slices (A0–A6) landed on the `live-agent` branch (one gated
> commit each), 2026-07-28/29. The one open box is A5's **live** validation:
> `:agent pi` against a real installed Pi (everything else runs on the mock
> + the wire-exact fake-pi fixture).

Takes the §"Open decisions" proposed defaults as settled: subprocess-RPC backend
(Pi) with a **mock backend for tests**, the §"backend seam" event vocabulary,
spinner+settle streaming, standalone agent pane.

**Guiding principle — mock-backend-first.** A deterministic mock backend lets us
build and gate the *entire* pipeline without Pi installed; Pi becomes the last
slice, and even its unit tests run on fixtures. Every slice ships behind the full
gate (suite · smoke · dep-walker `[]` both modes · dead-exports 0), on a
`live-agent` branch, in lazytui's usual slice-at-a-time style.

| # | Slice | Deliverable | Layer | Test |
|---|---|---|---|---|
| **A0** | Protocol + mock | `js/agent/protocol.js` (normalized `AgentEvent` shapes + `AgentBackend` interface) · `js/agent/backends/mock.js` (scripted deterministic events) | pure leaf | schema + mock emits the expected events |
| **A1** | Session host | `io/agent.js` — off-model `sessions` map; `start` / `send` / `interrupt` / `stop`; **stdin write** (the one new capability); `feature/jobs` register/close; injected `setEventHandler` / `setRenderHook` (leaf, no-op when unwired) | io leaf | via mock: send→events→handler; interrupt; stop closes the job |
| **A2** | Model | `panel/agent/agent.js` slice `{ transcript, status, inputDraft, descriptor }` + pure reducer arms folding coarse events → transcript (reuse `leaves/text/text-view-update`) + status; transcript cap | Component + text leaf | fold an event sequence → correct transcript/status; identity-preserved on no-ops |
| **A3** | Wiring | boot host-seam (à la `wireFabricHost`): io/agent's event handler `dispatchMsg`s coarse events (→ recorded, replayable); `send` / `interrupt` effects | dispatch/runtime | end-to-end through the real dispatch loop with the mock |
| **A4** | Pane + input | `agent` pane type (transcript + status + draft), minted via `mint_tab`; `:agent` verb; **agent-mode input** as an `agentMode` modeChain handler in `dispatch/control/dispatch.js` (compose → Enter=send, Esc=interrupt-or-leave), mirroring terminal-mode | panel + dispatch | smoke: mint, type, send, render, leave |
| **A5** | Pi backend | `js/agent/backends/pi.js` — spawn `pi --mode rpc`; JSONL framing (parse stdout lines + partial-line buffer / write command lines); Pi events ↔ normalized; `send`/`interrupt` → `prompt`/`abort` | io leaf | fixture Pi lines → normalized events (unit); **live** validation needs Pi installed |
| **A6** | Replay + polish | verify recorded coarse Msgs reconstruct the transcript with `io/agent.start` skipped under replay; transcript cap; spinner; CHANGELOG; doc status | — | replay property test + full gate |

**Notes & risk areas**

- **Layering:** `js/agent/` = pure/io leaves (protocol, backends); `io/agent.js` =
  io leaf (injected hooks, standalone in tests, exactly like `io/terminal.js`);
  `panel/agent/` = Component; reducers/effects/wiring in `dispatch/`. Dep-walker
  stays acyclic in both modes.
- **Nail A0's event vocabulary first** — it's the contract A1–A5 all build against;
  one careful pass before any backend is written.
- **Genuinely new mechanics:** bidirectional stdin (A1) and JSONL line-framing +
  partial-line buffering + backpressure (A5). Everything else reuses existing
  patterns (procs/jobs, text-view fold, `mint_tab`, terminal-mode input, host-seam
  wiring).
- **A0–A4 + A6 are fully buildable and gated with the mock backend**; only A5's
  *live* validation needs Pi on the dev machine.

## As built (Phase A) — where the implementation refined the design

All four §"Open decisions" proposals were taken as settled and held up. The
deltas worth recording:

- **Wire spec verified** against the pi repo's
  `packages/coding-agent/docs/rpc.md`: commands are `{type:'prompt',message}`
  / `{type:'abort'}` JSONL lines; **`turn_end` carries the settled assistant
  message** (content parts + per-turn usage) and **`agent_settled` is the
  settle signal** — `message_end` is unused (avoids double-fold). Framing is
  spec-mandated `\n`-only splitting (never readline: U+2028/U+2029 are legal
  inside JSON strings), pinned by a fixture test.
- **Deltas are throttled at the adapter** (`message_update` text deltas buffer
  on the handle and emit as `assistant-delta` INCREMENTS at most every ~100 ms,
  §Streaming), not filtered downstream: folding raw per-token events would push
  every token through dispatch + the WAL. Phase A shipped this arm as
  spinner+settle (deltas → nothing); the throttled-delta slotted into exactly
  that arm, as designed. Thinking / toolcall deltas are still dropped — the
  status line already says "thinking…".
- **Usage**: per-turn `message.usage` accumulates on the backend handle and
  rides the `status {state:'idle', tokens, cost}` emitted at settle; the
  pane's status-merge keeps the totals displayed.
- **Extension-UI dialogs auto-cancel**: Pi extensions can raise blocking
  confirm/select/input dialogs; with no approval seam they'd hang the agent.
  The adapter answers `cancelled: true` immediately and folds an error line
  saying why (§Trust — the approval seam remains future work).
- **Input ergonomics**: **Esc interrupts while a turn is in flight and leaves
  agent mode when idle** — one key, no new chord. Enter on the pane starts
  the session **lazily and idempotently** (a minted-but-never-entered pane
  spawns nothing; Enter after an exit restarts). `x` closes an *exited*
  agent pane (the dead-terminal analog). PageUp/PageDown scroll the
  transcript while composing; `↑`/`↓` recall previously-sent messages into
  the draft (readline-style history — editing a recalled line edits a
  transient working copy at that position; `↓` past the newest, or sending,
  always restores your in-progress line, so a browse can never eat the
  draft).
- **Identity**: the session id IS the tab-instance id (like a terminal's PTY
  id); orphan-dispose destroys the session entry first so straggler events —
  including the backend's own final `exit` — drop via a stale-session guard.
- **Delivery contract hardening** (protocol.js): backends emit nothing in
  `start`'s tick, `settled` on ready, an interrupted turn still terminates
  (`turn-end` + `settled`), and `exit` is once-and-last.
- **Multi-line errors fold as blocks** — live-Pi validation caught that a
  real backend error can be multi-line (pi's no-API-key message); an
  embedded `\n` inside one transcript row corrupts row rendering, so the
  error arm folds through the same split-before-esc block helper as tool
  results. (Every fixture error had been single-line — the value of the
  live pass.)

## Live validation without credentials (the recipe)

Pi has no dedicated test mode, but its `~/.pi/agent/models.json` custom-
provider mechanism (the Ollama path) IS one: point a provider at a **local
scripted OpenAI-completions server** and pi runs a genuine agent loop
against it — real streaming, real tool execution, real settle — with no
API keys. The recipe used for the Phase-A live pass:

1. `models.json`: a provider (`baseUrl: http://127.0.0.1:<port>/v1`,
   `api: openai-completions`, a dummy `apiKey`) with one model id.
2. A ~60-line node http server speaking SSE chat-completions: first
   request (no `role:"tool"` message in the conversation) streams a
   `tool_calls` delta invoking pi's bash tool (`echo live-tool-ok`);
   the follow-up request streams the settled text + usage.
3. An agent pane with `config: { backend: pi, provider: <name>,
   model: <id> }` — send a prompt, watch the tool line, result block,
   settled text, and `N tok` fold live.

Caveat: pi inherits lazytui's environment — an `http_proxy` in the env
routes the local baseUrl through the proxy (connection errors that look
like model failures). Unset the proxy vars for local-endpoint runs.

## Open decisions — RESOLVED (build took the proposals)

1. **Backend seam scope** — subprocess-RPC first (Pi) ✓; the mock backend
   already proves a second, non-subprocess implementation of the same seam.
   An in-process SDK backend remains a candidate follow-on.
2. **Normalized event vocabulary** — the §"backend seam" table shipped as-is
   (10 closed types, open extra fields), pinned by `test-agent-protocol.js`.
3. **Streaming** — throttled-delta preview ✓ (~10 Hz increments folding into
   the transcript, §Streaming; Phase A shipped spinner+settle first).
4. **Phase-A boundary** — standalone pane ✓; fabric wiring stays Phase B.

## See also

- [foreign-components.md](foreign-components.md) — the pattern this deliberately
  does **not** use, and why (`#D14` is for un-modelable state; an agent has none).
- `dispatch/runtime/stream.js`, `feature/jobs.js`, `panel/text-view/` — the
  streaming machinery this extends.
- `PRINCIPLES.md` §12 — the live-external-state decision table + `metrics-mirror`
  throttle.
- [ports-and-wires.md](ports-and-wires.md) — the fabric the agent later joins.
