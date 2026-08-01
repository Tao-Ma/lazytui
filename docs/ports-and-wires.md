# Component dataflow — ports, wires & injects (P1 · P1.5)

**Status:** **shipped — P1 + P1.5** on branch `fabric-groundwork` (decisions pinned
2026-07-02; see "Decisions (pinned)" and "P1.5 — as shipped" below). This is the
*foundation* phase of the AI-integration direction — it is deliberately
**humans-only**; the agent (P2) rides on top of it and adds no new fabric semantics.
The fabric ships in `js/fabric/`; `js/ports/` was vacated (its DI seams moved to
`js/hosts/`) and is held as the name of the dataflow-fabric *concept*.

> **Not** `DATAFLOW.md`. That doc maps the *internal* flow — how a keystroke becomes
> a paint (input → dispatch → reducer → render). **This** doc is the *component*
> dataflow: typed values flowing **between components**, so pipelines of tools can be
> composed. Different axis entirely.

---

## Why

LLMs are powerful but expensive, and using one to parse output that never changes
(pull an LSN out of `pg_controldata`, every time) is wasteful and *less* reliable
than a five-line parser. So:

> **Deterministic work belongs in code; the model is only for irreducible reasoning.**

The fabric lets components **publish** typed values and **consume** them, so
deterministic tools compose into pipelines with no model in the loop. Each component
an author writes is permanent leverage — it removes a class of work from the model's
plate, and a parser doesn't drift like a prompt. When the agent lands (P2), it
**orchestrates** the graph (decide which components to wire and run, interpret the
small distilled results) while the bulk data flows component→component and never
enters its context. That is the token win, and the reason this phase comes first.

## Scope

**In (P1):** ports, wires, injects, pull-at-invoke resolution, readiness, discovery,
the right-click "send to port" entry.
**In (P1.5):** the component-ports pane (operate + check), the wire list, and
replay-as-debugger.
**Deferred:** the agent as a fabric node (**P2**); reactive push / subscribe so
consumers re-run on value change (**P3**); serialising the port registry over MCP for
external clients (**P4**, optional).

**Non-goals (deliberate):**
- **No common type system.** The core is type-agnostic (see below).
- **No MCP server.** We borrow MCP's *ideas* (typed contracts, addressing,
  discovery, subscribe), not its wire protocol.

---

## Concepts

| Term | What it is |
|---|---|
| **Component** | Anything that owns a slice (a panel, or an action that streams output). Can be a producer, a consumer, or both. |
| **Output port** | A named, typed value a component publishes — a projection of its slice. |
| **Input port** | A named, typed value a component consumes. The consumer's named typed parameters. |
| **Wire** | A *standing* connection `producer.out → consumer.in`, stored in config. Resolves **by reference** — re-reads the upstream each invoke. |
| **Inject** | A *one-shot* value pushed into an input port (right-click, later the agent). **By value** — a frozen literal, sticky until replaced or cleared. |
| **Port value** | The current value of an output port — a derived, memoized selector over the source slice. Not stored in the model. |

## Type model — type-agnostic core

A port's `type` is an **opaque string the component author chooses**. The core never
interprets it. Wire legality in P1 is **plain string equality** (`out.type === in.type`),
validated at load/creation; a mismatch is rejected with a clear message.

"Each app dev builds their own type system" means: authors pick their own tag
conventions and matching rules across *their own* components. The core ships no
ontology — no `pg`/`docker`/`file` vocabulary. `pg.lsn` is a userland string.

- **Extension point (later):** a per-author matcher hook `canWire(fromType, toType) → bool`
  lets an author add coercion/subtyping *within their vocabulary*, owned entirely by
  them. Ship equality first.
- **Accepted tradeoff:** two unrelated authors' components won't auto-wire unless they
  happen to share type strings. Composition is rich *within* a coherent component set,
  not free across vendors — the right cost for a framework with no ontology.
- The agent (P2) needs no ontology either: it reasons from each port's author-written
  `desc` plus the opaque tag, and can soft-bridge fuzzy matches by splicing a transform
  where strict equality won't connect.

---

## Output ports — parse once, project many

A producer's raw output is parsed **once** into a structured record; each output port
is a cheap projection of a field. This avoids re-declaring (and re-running) a regex per
field.

```yaml
controldata:
  run: [ pg_controldata, "$PGDATA" ]
  parse: { kv: { sep: ':' } }        # ONE pass → { "Latest checkpoint's REDO location": "0/1A2B3C0", ... }
  ports:
    out:
      redo_lsn:  { type: pg.lsn,   from: "Latest checkpoint's REDO location" }
      timeline:  { type: pg.tli,   from: "Latest checkpoint's TimeLineID" }
      state:     { type: pg.state, from: "Database cluster state" }
```

- **Producer-level `parse`** — slice → structured record. `parse` is **component-level**
  (a sibling of `run`/`ports`, one pass over the whole output), NOT per-port. P1 built-ins
  (pin 3): `{ kv: {sep} }` (key:value lines), `{ json: true }`, `{ lines: true }`. Code
  components may pass a function (`fn`, implicit — not a config feature).
- **Per-port projection** — `{ type, desc, from }`; `from` selects a key out of the parsed
  record. With **no `from`**: a keyed object (kv/json object) defaults to the **port-name**
  field; an **array or primitive** record (a `{ lines: true }` producer, a whole-JSON value)
  IS the value — a whole-record port. `from` can carry a component's ugly source key while
  the *port* keeps a clean name (`redo_lsn`), so `kv` + `from` gives clean names over ugly keys.
- **Escape hatch** — a per-port `extract: { regex, group }` for a bespoke field the
  structured parse didn't capture. Runs on the raw output. (A DRY regex-*table* at the
  producer level is deferred to P1.5 — see Decisions.)

This is the parse→selector (model→view) split lazytui already uses. `parsed(component)`
is the memoized "model" of the output; ports are selectors over it.

### Port values are derived, not stored

```
portValue(componentId, portName)   // = memoized  project/extract( sliceOf(componentId) )
                                    //   recomputed only when that slice changes
```

Port values are **not materialized in the model** — same discipline as the
[viewer-lines selector arc](viewer-lines-selector.md), which *deleted* materialized
`slice.lines`/`search.matches` in favour of derived+memoized selectors. Memoize with a
`WeakMap` keyed on the underlying line-array identity — the same pattern as
`ms.matchesFor`. The parse runs once per slice change; never per read, never per model turn.

## Input ports — named typed params, multi-input by construction

`ports.in` is a **map**, so multiple inputs are the default case, not a special one.

```yaml
xlogminer:
  run: [ xlogminer, --start, "{{start_lsn}}", --end, "{{end_lsn}}", --timeline, "{{timeline}}" ]
  parse: { lines: true }        # COMPONENT-level: xlogminer's OWN output → a line array
  ports:
    in:
      start_lsn: { type: pg.lsn, required: true }
      end_lsn:   { type: pg.lsn, required: true }
      timeline:  { type: pg.tli, required: false, default: 1 }
    out:
      records:   { type: pg.wal_records, desc: "decoded WAL records" }   # no `from` → the whole array
```

Input ports are the consumer's **named, typed parameters** — they are the fabric's *only*
parameter model (they replace positional `args` for fabric consumers). Each carries
`type`, `desc`, `required` (default `true`), and an optional `default`. Values reach the
command via the no-shell command model below, so `{{start_lsn}}` is a **bound parameter**,
never shell-interpolated text.

## Command model — no shell, bind parameters

A fabric component's `run:` is a **command template** — a program plus argument slots,
authored as a **list** (canonical; a bare string is tokenised as sugar):

```yaml
run: [ xlogminer, --start, "{{start_lsn}}", --end, "{{end_lsn}}" ]
```

- The **list structure is fixed code** — one element = one argument, no whitespace-splitting.
- `{{name}}` are **holes = bound parameters** (an input port's resolved value). Embedding
  works (`"--start={{start_lsn}}"`, `"{{dir}}/{{file}}"`) via JS string concat.
- `$VAR` slots resolve at fill from the `vars` block / `process.env` (static values), the
  same convention `resolver.js` already uses; the fabric leaves `{{}}` alone at parse.

At invoke: resolve each `{{name}}` (pull-at-invoke, below), fill the template in JS to a
concrete argv array, then `spawn(argv[0], argv.slice(1), { shell: false, cwd, env })`.

`execve` hands each element to the program **verbatim** — no shell, no expansion, no
word-splitting, no globbing, no quoting, no escaping. This is the **prepared-statement /
bind-parameter** model: structure is code, values travel out-of-band, so **injection is
structurally impossible**, exactly like a parameterised SQL query. A value may contain
spaces, quotes, `$`, backticks, `;`, newlines — it arrives as one literal argument.

- **No shell metacharacters** in a fabric command (`|`, `&&`, `>`, `*`). The gaps map onto
  the design: env via `spawn`'s `env`; **pipelines are the fabric's job** (two components +
  a wire, not a shell `|`); a list-typed hole `"{{files}}"` splices into N argv elements
  *explicitly* (no accidental splitting).
- **Residual:** argv can't carry a NUL byte — nothing in this domain does.

## Addressing

`component.port` (attribute-access), e.g. `controldata.redo_lsn`. In P1 addresses are
**same-group** — wires live in a group's `wires:` block, so the group is implicit. A
component that declares `ports` (and its port names) must be a **dot-free identifier**
(`[A-Za-z_][A-Za-z0-9_]*`) so the single `.` splits unambiguously.

Parsed by a small dedicated `parseFabricAddr(str) → { group?, component, port }` —
**not** the `:open` scheme registry (that opens *targets as content tabs* and doesn't
parse a component→port relationship). Cross-group is **deferred**; when a real cross-group
pipe motivates it, a qualified form (`group.component.port` or `group://component.port`)
in a top-level `wires:` block, parsed by the same `parseFabricAddr`.

## Wires — standing connections (by reference)

```yaml
wires:
  - { from: controldata.redo_lsn, to: xlogminer.start_lsn }
```

Wires live in config → the model → the WAL, so they are replayable. They are **standing**
producer→consumer connections resolved **by reference** — each invoke re-reads the current
upstream value, so the consumer tracks the producer. Use them for pipelines, not one-off
values. Fan-in (several producers → one consumer) is just several independent wires.

## Injects — one-shot pushes (by value, sticky)

An inject pushes a concrete value into one input port. It is **by value** — a frozen
literal captured at inject time, distinct from a wire's by-reference tracking. It is a
Msg (`port_inject { port, value }`) → WAL → replayable, and lives in the model at
`model.fabric.injects` keyed by `component.port` — **transient (never serialised to
config), but in-model** (so replay reproduces it; same discipline as
`model.modal.continuation`). Written by a small `confirm.js`-shaped sub-reducer
(`TYPES = ['port_inject', 'port_clear']`).

**Sticky** — an inject persists until (a) a new `port_inject` to the same key overwrites
it (last-write-wins), or (b) an explicit `port_clear` — it is **not** auto-consumed after
one run. This matches a form-field mental model (re-run without re-selecting; the operator
pane keeps its values). The one risk — a stale inject silently shadowing a now-working
wire — is closed by the pane's source badge, which shows `inject` vs `←wire` (P1.5).

Sources: a right-click selection now, the agent in P2. Injects keep the wire list pure
dataflow (no transient literal junk) and give humans and the agent **one shared push
primitive**.

## Resolution & readiness — the one new dispatch hook

When a consumer runs, each input port is resolved **before** the command executes, by
precedence:

> **inject  >  wire  >  default  >  (required ? error : omit)**

**Readiness:** the run fires only when *every required* input resolves; otherwise it
**errors and tells**, naming exactly which are missing and *why* (the check knows the
reason):

- no source at all — *"xlogminer: `end_lsn` unset — wire it or send a value."*
- wired but upstream empty — *"xlogminer: `start_lsn` ← controldata.redo_lsn has no value
  yet — run controldata first."*

**Unavailable upstream is not a special path** — it's one reason a required input fails to
resolve, folded into the same readiness gate. Auto-running the upstream (implicit chains,
topo-order, cycles, surprise side effects) is **P3**, not P1.

The resolution is a **pure read** of current model state (upstream slices for wires,
inject state, defaults) performed in `doRunFabric` just before spawn; it produces the argv
fill (above) or the unresolved list. The command run is the existing effect channel.
Insertion point: `js/dispatch/runtime/action-runner.js#doRunFabric`. The "tell" surfaces via the
`appendViewerLines('[yellow] not ready: …')` convention (as spawn/background already do)
and the P1.5 pane readiness badge.

## Discovery

- `listPorts()` → `[{ component, port, dir, type, desc }]`
- `listWires()` → current wires

These power the pane and the wire list now, and the agent (P2) later.

## Right-click → "Send selection to port"

Grounded in the existing context-menu machinery
(`js/leaves/input/context-menu.js` `SECTIONS`, `ctx.selectionText` resolved by
`_resolveContextAt` in `js/dispatch/control/input.js`, handlers in
`js/dispatch/control/actions.js`, menu overlay `js/overlay/menu.js`):

```
SECTIONS entry (build: ctx => ctx.selectionText ? ['Send selection to port','send_to_port',ctx.selectionText] : null)
  → send_to_port  (arg = selected text)
    → port-pick menu, rows = input ports from listPorts()   (reuse js/overlay/menu.js, compatible-first)
      → port_inject { port, value }
        → pull-at-invoke resolves (inject > wire) → run consumer
```

A menu row is a flat `[label, action, arg]`, so the target is a **second step**: the
entry fires one action carrying the selection; its handler opens the port picker. A
manual send is a **human override** of the type check — the selection is raw text; type
equality only *orders* the picker (compatible first), it does not block. (Copied text is
also available as `model.register.history[0]` from `js/leaves/register.js` if we want a
"send last yank" variant.)

---

## P1.5 — Component-ports pane

**One pane *kind*** (a new `panelTypes[...]`, not one per component) that shows a
component's whole port surface — inputs (the "operate" half) and outputs (the "check"
half), since components are usually both:

```
xlogminer                                   [✗ not ready: end_lsn]
  start_lsn  pg.lsn   0/1A2B3C0   ← controldata.redo_lsn
  end_lsn    pg.lsn   ▏           (type, or wire / inject)
  timeline   pg.tli   1           default
  ─────
  ▸ Run    ▸ Clear
  out:
  records    pg.wal_records   1,204 lines
```

**Instance model — hybrid (decided):** a single **follows-focus** inspector by default
(retargets to the focused component, IDE-inspector style), plus the ability to **pin** a
bound instance for a workbench (controldata's ports beside xlogminer's). Panes open on
demand via the existing panes-as-containers layout — never auto-spawned per component.

**Adds no new fabric semantics** — it is a view + editing surface over primitives that
already exist:
- **Manual field input = an inject** (`port_inject`). The form is a nicer multi-field
  injector than the one-off right-click.
- **Run = the existing action dispatch** + pull-at-invoke. No new run path.
- **Readiness + source badges = `listPorts()`** + the resolution check, rendered. The
  `inject`/`←wire`/`default` badge is also what makes sticky injects safe (see Injects).
- **Wiring from the pane:** each input row offers "connect to…" — summons the existing
  `js/overlay/menu.js` picker populated from **global `listPorts()`** (compatible-first),
  and selecting a producer port emits a wire-create Msg. Because the picker is global, a
  follows-focus pane can still wire to *any* producer. This **subsumes a standalone ports
  overlay** — one interaction surface per component (see Decisions).

**Check half — the authoring/debugging win.** The output rows show each port's value and
the raw→match→value chain, so an author can see whether an extract fired:

```
controldata
  raw:  Latest checkpoint's REDO location:    0/1A2B3C0
  redo_lsn   0/1A2B3C0   ✓ matched
  timeline   —           ✗ regex no match     ← the bug, visible
```

The regex-*table* parser (`parse: { fields: {…} }`) lands here, with this check-half UI —
its ✓matched/✗no-match display is the reason it exists beyond DRY (see Decisions).
Cheaper components → more components → less model work, so lowering the authoring barrier
matters.

**Build cost:** a multi-field editable form. lazytui has single-field text editing today
(cmdline, search); a field reuses that input-buffer + cursor, and the new part is
focus/tab *between* fields — modest.

## P1.5 — Wire list & replay-as-debugger

**Wire list** — a global edge view (a pane by default; a `jobs`-style overlay-summon
optional) rendering the value currently on each wire plus validity, and offering delete:

```
controldata.redo_lsn → xlogminer.start_lsn   0/1A2B3C0   ✓
elsewhere.x          → xlogminer.end_lsn      —           ✗ upstream unset
```

The pane owns wire *creation* (contextual, per input); the wire list owns the global
*view + delete*. No standalone ports overlay between them.

**Replay-as-debugger.** Every fabric value is a derived selector over the model, so
observability is a *property*, not a feature — any port or wire value is renderable at
any time. Combined with the existing WAL + checkpoint **replay** ([v0.6.6](v0.6.6-replay.md),
debugger in [v0.6.7](v0.6.7.md)), you can step recorded history and watch values propagate
through producers, wires, and consumer inputs at each Msg — a **time-travel dataflow
debugger**, mostly "render derived values during replay." The debugger is a *lens* on the
fabric, not a second system.

---

## Worked example — the pg pipe

> *Schematic — it shows the two-input, wire + inject shape. The runnable pipes ship as
> `demo/postgres/tui.yml` (real pg: a single-input `waldump` consumer,
> `controldata.redo_lsn → waldump.start_lsn`) and `demo/fabric/tui.yml` (infra-free echo:
> two producers exporting the same type so a consumer can pick its source, plus a
> fan-in `compare` node wired from both).*

```yaml
groups:
  pg:
    components:
      controldata:
        run: [ pg_controldata, "$PGDATA" ]
        parse: { kv: { sep: ':' } }
        ports:
          out:
            redo_lsn: { type: pg.lsn, from: "Latest checkpoint's REDO location" }
      xlogminer:
        run: [ xlogminer, --start, "{{start_lsn}}", --end, "{{end_lsn}}" ]
        parse: { lines: true }
        ports:
          in:
            start_lsn: { type: pg.lsn, required: true }
            end_lsn:   { type: pg.lsn, required: true }
          out:
            records:   { type: pg.wal_records }   # no `from` → the whole line array
    wires:
      - { from: controldata.redo_lsn, to: xlogminer.start_lsn }
```

1. Run `controldata` → `pg_controldata` output streams into its slice.
2. `controldata.redo_lsn` becomes derivable → memoized kv parse → `0/1A2B3C0`.
3. Provide `end_lsn`: select an LSN somewhere → right-click → **Send to port** →
   `xlogminer.end_lsn` (a sticky inject); or type it in the component-ports pane.
4. Run `xlogminer` → runner resolves `start_lsn` (wire, by reference) + `end_lsn` (inject,
   by value), both required and present → fills the argv template →
   `execve(xlogminer, ["--start", "0/1A2B3C0", "--end", "<injected>"])`, no shell.
5. Output streams into xlogminer's slice → `xlogminer.records` is now available to the
   next consumer, and visible in the component-ports pane's check half.

Zero model involvement — deterministic tools composed into a pipe.

---

## TEA / purity

- **Extractors** are pure functions of a slice, memoized on slice identity, and **not
  materialized** in the model (viewer-lines precedent).
- **Resolution** is a pure read of current model state in `doRunFabric` before spawn;
  the effect channel (an argv `execve`) is unchanged in shape.
- **Wires and injects** are model/config state; edits are Msgs → WAL → **replayable**.

## Build surface

**Reused as-is:** components/slices, actions + command execution, stream buffers, the
context menu (`context-menu.js` `SECTIONS`), menu overlay (`overlay/menu.js`), selection
(`panel/select-view.js` + `leaves/text/select-core.js`), register (`leaves/register.js`), WAL + replay,
panes-as-containers layout, the derived-selector + memo pattern (`ms.matchesFor`), the
`shQuote`-free `spawn(…, { shell:false })` argv path (extends the existing `-- ...args`
safe channel), the `confirm.js` sub-reducer shape.

**New (small), living in `js/fabric/`** (the DI seams that used to own `js/ports/` are now
`js/hosts/`):
1. `ports` declaration + the declarative parser (`kv` / `json` / `lines`; `fields`
   regex-table added in P1.5) + per-port `from` / `extract:{regex}`.
2. `portValue(component, port)` — memoized selector; `listPorts()` / `listWires()`.
3. `parseFabricAddr` + `wires` in config + equality-validate + dot-free-name guard.
4. Injects: `port_inject` / `port_clear` Msgs + a `confirm.js`-shaped sub-reducer +
   `model.fabric.injects` transient store.
5. The argv-template fill + pull-at-invoke resolution/readiness hook in `action-runner`
   (`spawn(…, { shell:false })`).
6. `send_to_port` context-menu entry + handler + port-pick menu.
7. **P1.5 (shipped):** the component-ports pane (`panel/fabric/ports-pane.js`, new
   `component-ports` panel kind) + the wire list (`panel/fabric/wire-list.js`,
   `fabric-wires`) + the `fields` regex-table parser + check-half ✓/✗ + the runtime
   wire store (`model.fabric.wires` + `fabric/wires.js#mergeWires`) + the in-grid
   field editor (`fabricFieldMode` + `dispatch/update/modal/fabric-field.js`).
   Replay-as-debugger fell out for free (a property — see below).

## P1.5 — as shipped

Landed on branch `fabric-groundwork` in seven slices (A runtime-wire store · B
read-only inspector · C1 nav · C2 field-edit → inject · D connect-to wiring + Run
· E wire-list · F `fields` parser + check-half · G replay property).

- **Runtime wires.** Interactive wire creation (the pane's "connect to…" + the
  wire list's delete) lives in a transient-in-model store `model.fabric.wires`,
  mirroring injects (session-only, rides the WAL, replayable). The fabric host
  MERGES it over the config `wires:` (`fabric/wires.js#mergeWires`, runtime
  overrides config per input `to`, `source`-tagged); the config file stays purely
  user-authored. `wire_create` / `wire_delete` are pure sub-reducer arms.
- **Field editing = an inject**, via a dedicated in-grid edit mode
  (`fabricFieldMode`, not the args-prompt — the fabric needs the RAW value never
  re-parsed). Commit folds `applyInject` (the shared canonical write, also behind
  `port_inject`) + closes the editor in one atomic reduction.
- **Component-ports pane key map:** `↵` run the component (existing action
  dispatch + pull-at-invoke) · `e` edit the selected input (→ inject) · `w`
  connect it (compatible-producer picker → `wire_create`) · `x` clear its inject.
  Follows-focus: runtime pin → config `component:` → `select_from` selection →
  focused pane's selection. Row/component resolution needs model access, so the
  keys claim + defer to `fabric_field_open` / `_clear` / `_connect_open` /
  `fabric_run` effects (the pure `update` lacks model/focus).
- **Check-half** shows whether each extract fired — ✓ matched · ✗ no match
  (producer ran, field null) · — no value (not produced) — the reason the `fields`
  table exists beyond DRY.
- **Replay-as-debugger is a property, not a feature.** Port/wire values are pure
  selectors over the model, and the whole fabric state (output + injects + wires)
  rides the WAL as recorded root Msgs. Folding recorded history reconstructs the
  model, so the two panes render correct values at every stepped frame with zero
  fabric-specific replay code (locked by `test-fabric-replay.js`).

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **P1** | Fabric: ports (parse/project) · wires · injects · resolution/readiness · discovery · right-click send. Validated on the pg pipe **by config alone**. | shipped (branch `fabric-groundwork`) |
| **P1.5** | Interactive/observability: component-ports pane (hybrid instances) · wire list · replay-as-debugger · regex-table + check-half UI. | shipped (branch `fabric-groundwork`) |
| **P2** | Agent as a fabric node — reads ports (resources), invokes consumers (tools), proposes/creates wires; value-feed = an inject. Provider-agnostic, OpenAI SDK behind a swap seam. | not started |
| **P3** | Reactive push/subscribe — consumers re-run when a required input changes (readiness + "≥1 changed"); auto-run upstream. | not started |
| **P4** | Optional: serialise the port registry over MCP for external clients. | not started |

## Decisions (pinned)

Walked one-by-one and pinned 2026-07-02.

1. **Injects vs wires** — **ratified split.** By-reference wire (config→model→WAL) vs
   by-value inject (`model.fabric.injects`, transient-in-model, replayable). Injects are
   **sticky** (persist until replaced/cleared, not auto-consumed). `confirm.js`-shaped
   sub-reducer (`port_inject`/`port_clear`). Precedence `inject > wire > default > error`.
2. **Ports vs `args`** — **`ports.in` is the fabric's sole parameter model.** Values fill an
   **argv template run with `shell:false` (`execve`)** — bind-parameter semantics, zero
   quoting/escaping, injection-impossible. `{{name}}` holes; list-form `run:` canonical.
   `$VAR` stays parse-time-static. Legacy positional `args:` is untouched but out-of-scope
   for the fabric. *(Superseded the earlier shell-env-var and single-quote proposals — no
   value ever touches a shell parser.)*
3. **Extractor breadth** — P1 ships `kv` + `json` + `lines` + per-port `from` + per-port
   `extract:{regex,group}`. The regex-*table* (`parse:{fields}`) defers to P1.5, landing
   with its check-half ✓/✗ UI. `fn` is implicit for code components (not a config feature).
   *(Build note — RESOLVED: `viewerStreamBuffer` is display-capped at 1000 lines, but the
   fabric parse path captures a SEPARATE, uncapped raw-output buffer (`model.fabric.output`,
   flushed on process close), so a big-output producer parses its full output.)*
4. **Addressing** — **`component.port` (attribute-access `.`)**, same-group in P1, group
   implicit (wires in the group's `wires:`). Dot-free-identifier guard on fabric names.
   Cross-group deferred. `parseFabricAddr` owns parsing — **not** the `:open` registry
   *(this overturns the earlier "reuse the scheme registry" idea; the URI-fragment `#`
   form was considered and rejected in favour of `.`)*.
5. **Unavailable upstream** — **error-and-tell**, folded into the required-input readiness
   gate; a pure pre-run read in `action-runner`; precise per-input reasons. Auto-run /
   reactive re-fire are **P3**.
6. **Pane absorbs wiring** — **yes.** The component-ports pane owns contextual wire creation
   (via the `listPorts()`-fed `menu.js` picker); the wire list is the global view + delete
   (pane by default); **no standalone ports overlay**.

## Build notes

- **`js/fabric/` = the fabric impl; `js/hosts/` = the DI seams.** Rename done 2026-07-02
  (commit on `fabric-groundwork`): `js/ports/{panel,feature}-host.js` → `js/hosts/`. "Port"
  is the proper term for a dataflow endpoint (flow-based-programming sense); the seams are
  dependency-inversion *hosts*. The fabric code lives in `js/fabric/`; `js/ports/` is
  vacated and reserved for the dataflow-fabric *concept*.
- **Full-output capture for parse** — DONE: the fabric run path captures raw stdout into
  `model.fabric.output` (un-esc'd, uncapped), separate from the 1000-line display buffer
  (see decision 3's note).
- **Dot-free fabric names** — see decision 4; enforced at load for `ports`-declaring
  components and their port names.

## Related

[`DATAFLOW.md`](DATAFLOW.md) (internal flow) · [`viewer-lines-selector.md`](viewer-lines-selector.md)
(derived-memoized precedent) · [`keymap.md`](keymap.md) (E9 dispatch-from-data; the
agent-invoke analogy for P2) · [`v0.6.6-replay.md`](v0.6.6-replay.md) (WAL + checkpoints).
