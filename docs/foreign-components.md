# The foreign-component contract

> **Status:** living contract. The reference implementation is `io/terminal.js`
> (the embedded PTY/xterm terminal, tagged `#D14`). Read this before adding any
> Component that embeds a system whose state cannot live in the TEA model.

A **foreign component** is a region of the UI whose mutable state lives **outside
the TEA model** — owned by an external, self-driving reactive system that lazytui
embeds rather than re-implements. The model holds the region's *lifecycle and
intent*; the foreign system holds its *contents*; the two talk only by
message-passing at a narrow boundary.

This is the **single sanctioned exception** to lazytui's core invariants
(`frame = f(model)`, pure reducers, single-writer, replayability). It exists
because some systems — a terminal emulator, and plausibly a future embedded
viewer/graph/editor — are large, fast-moving state machines that you should *use*,
not *model*. It is a **last resort, not a default escape hatch**: before reaching
for it, confirm the data genuinely can't enter the model as a Cmd (one-shot) or
Sub (ongoing) with render reading only the model (see `PRINCIPLES.md` §12).

## When a foreign component is the right call

Reach for it **only** when all of these hold:

1. The state is owned by a **foreign reactive system** you embed (a library or a
   child process), not data you produce — so modelling it means re-implementing
   that system as a reducer.
2. It is **high-frequency** — folding every change through a Msg into the model
   would be heavy and redundant (a terminal emits a byte stream; a graph widget
   re-lays-out continuously).
3. Its contents are **not something you need to replay** from the Msg log (or you
   accept recording them on a separate side-channel — see *Replay*, below).

If any of these fails, it belongs in the model. A discrete low-frequency store →
mirror it in via a `store-mirror` Sub. A continuous metric feeding a view →
throttle-sample it via a `metrics-mirror` Sub. (Both: `PRINCIPLES.md` §12.) Those
keep `frame = f(model)`; a foreign component does not.

## The principle

- **The model holds the descriptor, not the contents.** The model carries a
  *declarative description* of which foreign components should exist and their
  parameters — id, which pane/tab, size, focus, the source/command. It does **not**
  carry the contents (the screen grid, the rendered widget state).
- **An imperative reconcile step drives the real resource to match the model.**
  The post-dispatch finalizer (`dispatch/runtime/finalize.js`) ensures the live
  instances match the model's descriptor each dispatch: spawn newly-desired ones,
  resize to committed geometry, dispose removed ones. (This is the
  "render-the-desired-set, reconcile imperatively" pattern.)
- **The boundary is message-passing.** Input/intents go **down** (a write call);
  coarse events come **up** as Msgs through the dispatch loop (exited, bell,
  title-change, resize-needed). The foreign component **never writes the model or a
  slice directly** — it invokes an injected handler, and the higher layer turns
  that into a Msg.
- **Render reads a live snapshot.** The one sanctioned off-model read: render asks
  the foreign component for its current contents (`getSnapshot`) at frame time.
  This is *why* such a frame is not a pure function of the model.
- **It is a true leaf.** It reaches nothing upward. Everything it needs from higher
  layers — the repaint signal, the event fan-out, any registry adapter — is
  **injected at boot** (dependency inversion). Unset hooks make it a no-op, so it
  runs standalone in tests.

## The contract

A conforming foreign component is a module that owns an encapsulated instance store
and exposes these seams. (Names below are generic roles; the terminal's concrete
method names are mapped in the next section.)

```js
/**
 * @typedef {Object} ForeignComponent
 *
 * --- Encapsulated state (NOT in the TEA model) ---
 *   A module-local store of live instances (`id -> handle`). No reducer reads or
 *   writes it; it is never part of the model snapshot.
 *
 * --- Boot-injected upward dependencies (it is a leaf) ---
 * @property {(fn: () => void) => void}        setRenderHook   Repaint signal: the
 *           component calls this when its contents change. Unset = no-op.
 * @property {(fn: (id, ...evt) => void) => void} setEventHandler  Coarse events up
 *           (exit, etc.). The higher layer dispatches a Msg in response. Unset = no-op.
 *           (Optionally also registry adapters, e.g. setJobsHooks.)
 *
 * --- Lifecycle (reconciled from the dispatch finalizer to match model intent) ---
 * @property {(id, descriptor, ...dims) => handle} ensure   Create-on-demand / return
 *           existing. Idempotent: re-running for a live id is a no-op.
 * @property {(id, ...dims) => void}    resize   Resize to committed geometry.
 * @property {(id) => void}             destroy  Tear down one instance (dispose
 *           listeners BEFORE the underlying resource; kill the child).
 * @property {() => void}               destroyAll  Tear down all (on app quit —
 *           a spawned child does NOT die with the TUI).
 *
 * --- Input down ---
 * @property {(id, input) => void}      write    Send intents/bytes to the instance.
 *
 * --- Snapshot read (the one sanctioned off-model read, at render) ---
 * @property {(id) => handle|null}      getSnapshot   The current contents to paint.
 *           (Plus any derived read-only views, e.g. scroll info.)
 *
 * --- Events up ---
 *   On an async transition (the child exits, a bell, a title change), invoke the
 *   injected event handler. NEVER write the model/a slice directly — the handler's
 *   job is to dispatch a Msg so state changes flow through the reducer.
 */
```

### Replay

A foreign component's **contents are outside the Msg-log replay boundary** (`#D5`).
Replaying the Msg log reconstructs the model — including the component's *descriptor*
(which instances exist, their size/focus) — but **not its contents**. A replay
harness must therefore: skip the lifecycle reconcile (do not spawn the real
resource), and accept that the region replays blank.

If you ever need to replay the *contents*, do **not** move them into the model.
The contents are a deterministic fold over the foreign system's input stream
(e.g. a terminal grid is a deterministic function of its PTY byte stream + resize
events), so record that **input stream as a separate side-channel** and re-feed it
on replay — orthogonal to, and never mixed into, the Msg log.

## Reference implementation — `io/terminal.js` (`#D14`)

The terminal maps element-for-element onto the contract:

| Contract role | `io/terminal.js` |
|---|---|
| Encapsulated state | `sessions = {}` (`id -> { pty, xterm, … }`) |
| `setRenderHook` | `setRenderHook(fn)` — called from `xterm.write`'s completion |
| `setEventHandler` (+ adapters) | `setExitHandler(fn)`, `setJobsHooks({register, close})` |
| `ensure` | `ensureSession(id, cmd, cols, rows, cwd)` — lazy, idempotent |
| `resize` | `resizeSession(id, cols, rows)` |
| `destroy` / `destroyAll` | `destroySession(id)` / `destroyAll()` (+ `restartSession`, `isSessionDead`) |
| `write` | `writeToSession(id, data)` |
| `getSnapshot` (+ derived) | `getSession(id)`, `sessionScrollInfo(id)`, `sessionMouseMode(id)` |
| Events up | `pty.onExit → _onSessionExit → _exitHandler` (boot-injected fan-out → dispatches Msgs); jobs via the injected adapter |

The lifecycle reconcile lives in `dispatch/runtime/finalize.js` (the active
terminal tab's `ensureSession`/`resizeSession` to the pane's committed geometry).
The descriptor lives in the model: which tab is a terminal, its session id, the
pane dims. The contents (the xterm grid) never enter the model. Render reads them
live in `render/paint.js` (`getSession`/`sessionScrollInfo`) and `render/footer.js`.

## Where this sits in the wider ecosystem

This is the well-trodden answer for embedding a foreign reactive widget in a pure /
unidirectional UI. The Elm Architecture's interop guidance embeds such widgets as
opaque **custom elements** whose internal state is explicitly *not* part of the
model — data flows down via attributes/properties, events flow up as custom events
→ Msgs. The same lineage frames it as the **controlled vs. uncontrolled** component
distinction: a *controlled* component's state is held by the framework (lazytui's
normal Components — slice in the model); an *uncontrolled* one manages its own
internal state and you read it through a handle (a foreign component). lazytui's
contract is that pattern, made explicit and kept minimal.

See also: `PRINCIPLES.md` §12 (live-external-state convention + decision table),
`model/store.js` (§Replayability boundary, `#D5`/`#D14`),
`docs/v0.6.6-replay-readiness.md` (replay design brief).
