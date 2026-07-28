# Live agent — design spec

> **Status:** DESIGN, not yet built. This spec models a *live, long-lived agent*
> as a **managed structured-protocol subprocess** — an extension of lazytui's
> existing streaming machinery (`dispatch/runtime/stream.js` + `feature/jobs` +
> the `text-view` instance), staying in **pure TEA**. It is deliberately **not** a
> [foreign component](foreign-components.md) (§"Why not a foreign component"). The
> generalized part is the **agent-backend seam**: lazytui owns the *live-agent
> concept*, and a concrete agent (Pi, an in-process SDK loop, …) is a pluggable
> *backend*.

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
| `assistant-delta {text\|thinking}` | streaming token(s) of the current turn | **not folded** — spinner, or throttled (§Streaming) |
| `assistant-message {text}` | a turn's assistant text settled | `tv_append` → transcript |
| `tool-call {id, name, args}` | agent invoked a tool | `tv_append` (folded line) |
| `tool-result {id, result, isError}` | tool finished | `tv_append` |
| `status {state, tokens?, cost?}` | idle/thinking/compacting/retrying | status Msg |
| `turn-end` | assistant turn completed | flush pending settle |
| `settled` | session idle, nothing queued | status Msg (drives input-ready) |
| `error {message}` | backend/turn error | `tv_append` + `diag-log` |
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
| `send(h, msg)` | write a `prompt` command line to stdin; `steer` / `follow_up` for queued input |
| `interrupt(h)` | write an `abort` command |
| `stop(h)` | close stdin / kill the child |
| `assistant-delta` | `message_update` → `assistantMessageEvent` (`text_delta` / `thinking_delta`) |
| `assistant-message` | `turn_end` message text / `message_end` |
| `tool-call` | `tool_execution_start` (`toolCallId`, `toolName`, `args`) |
| `tool-result` | `tool_execution_end` (`result`, `isError`) |
| `status` | `agent_start` / `compaction_*` / `auto_retry_*` / `get_state` |
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
       → reducer folds into the text-view instance (tv_append / tv_set_lines)
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

- Backed by a **`text-view`-style transcript** (reuse its `tv_append` / scroll /
  search / select) plus a small **status line** and an **input draft**.
- **Agent-mode input** (analogous to terminal-mode): keystrokes compose a message;
  Enter `send`s, Esc leaves, a chord `interrupt`s. Routed in
  `dispatch/control/input.js` alongside terminal input.
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

Per-token live typing is **optional polish, not structural**. Two model-pure options:

1. **Spinner + settle** (default) — show a "thinking… (tool: …)" status while a
   turn runs; fold the settled `assistant-message` when it lands. Zero per-token
   cost, trivially replayable.
2. **Throttled delta** — sample `assistant-delta` at ~10 Hz into the transcript's
   last line via a `tv_set_lines`-style update (the `metrics-mirror` throttle
   pattern, `PRINCIPLES.md` §12). Smooth-enough typing, still pure TEA.

Neither needs a foreign exception.

## Session continuity across a restart

The subprocess dies with the app (like any spawned process); the **transcript
survives in the model**. To *continue the conversation* after a restart, the
descriptor carries a durable **backend session id** and `start` resumes it (Pi
persists sessions to JSONL and exposes `switch_session` / `get_entries`). Fresh
vs. resumed is a descriptor flag — no foreign machinery.

## Fabric coupling (later phase)

Once the standalone primitive is solid, the agent becomes a **live fabric node**:

- **Inputs** — the agent's input ports are wired from producers; on `send` (or
  reactively, once subscribe/P3 lands) the wired values are injected into the
  message context — the agent *watches the dataflow*.
- **Outputs** — the agent's `tool-result` / final `assistant-message` can be
  parsed (kv/json/regex — the existing port machinery) into **typed output ports**
  for deterministic downstream nodes.
- **Fabric-as-tools** (furthest out) — ship a Pi *extension* (Pi extends via
  TypeScript tools) exposing lazytui's ports/components as tools, so the agent can
  *read and drive the cockpit*.

Keep all of this out of Phase A.

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

## Open decisions (to confirm before building Phase A)

1. **Backend seam scope** — *proposed:* subprocess-RPC first (Pi), in-process SDK a
   second backend to prove genericity; the interface must not leak subprocess
   assumptions. Confirm.
2. **Normalized event vocabulary** — the table in §"The backend-adapter seam" is the
   proposed contract; highest-leverage thing to get right. Confirm / refine.
3. **Streaming** — *proposed:* spinner + settle for Phase A; throttled-delta later
   if wanted. Confirm.
4. **Phase-A boundary** — *proposed:* standalone agent pane; fabric wiring deferred
   to Phase B. Confirm.

## See also

- [foreign-components.md](foreign-components.md) — the pattern this deliberately
  does **not** use, and why (`#D14` is for un-modelable state; an agent has none).
- `dispatch/runtime/stream.js`, `feature/jobs.js`, `panel/text-view/` — the
  streaming machinery this extends.
- `PRINCIPLES.md` §12 — the live-external-state decision table + `metrics-mirror`
  throttle.
- [ports-and-wires.md](ports-and-wires.md) — the fabric the agent later joins.
