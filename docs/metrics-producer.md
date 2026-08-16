# Metrics Producer — YAML-declarable hub source

**Status:** implemented — merged to `main` as the first v0.6.18 `[Unreleased]`
work (after v0.6.17 shipped). The parser block, the `metrics-poll` Sub kind +
app-global sourcing, the pure extractor, and the `stats` `row:` companion all
ship with tests (`test-metrics-extract.js`, `test-metrics-producer.js`,
`metrics` cases in `test-parser-schema.js`). Deferred items in §10 remain
future work.

A generic, YAML-declarable **producer**: poll a shell command on an
interval, extract numbers from its stdout, and publish them as hub
samples under a declared topic + schema. It is the missing half of the
`stats` panel — today the *only* thing that can feed a hub metrics topic
is `js/panel/navigator/docker.js` (`hub.defineTopic('docker.stats', …)`
in its `init()`, `hub.publish` in the fetch effect). This makes the same
braille line-graphs generic over **any** command: `top`, `vmstat`,
`mpstat`, `free`, `iostat`, `nvidia-smi`, `/proc`, `kubectl top`, …

This doc specifies the producer only. The consumer (`stats`) already
exists; §9 notes the one small companion change needed to render a
*single-stream* host metric, and defers the gauge / per-core / process
table work to their own backlog items.

---

## 1. The gap, precisely

The `stats` panel (`js/panel/monitor/stats.js`) is already generic over
its hub topic — it reads `model.metrics[topic]`, and the topic's
`schema.columns[*].type` (`percent` / `bytes` / `number`) drives axis
scaling and value formatting. What is *not* generic is the **write**
side:

- A topic's schema is announced with `hub.defineTopic(topic, schema)`,
  called only from inside a framework Component's `init()`.
- Samples arrive via `hub.publish(topic, rowKey, sample)`, called only
  from `docker.js`'s off-tick fetch effect.
- The poll itself is a per-pane `subscriptions()` `interval` Sub —
  declared by the **placed** `containers` pane. No pane placed → no
  poll.

So every metric today is coupled to the docker container pane. A host
monitor needs a source that is **headless** (owns no pane) and
**config-driven** (no new JS per metric).

## 2. Design principles it must satisfy

- **YAML defines, TUI renders** (PRINCIPLES §1). The command, the
  extraction, the schema, the cadence — all in YAML. The framework
  contributes one generic poll-exec-parse-publish loop and one pure
  extractor; it holds no knowledge of `top` or `%Cpu`.
- **Producer decoupled from panes.** A producer is an app-global
  source, sourced from `config`, exactly like the `resize`, `clock`,
  and the three `store-mirror` Subs in `_appSubscriptions(model)`
  (`js/app/state.js`). It is *not* a pane and is *not* placed in the
  layout.
- **The hub is the only coupling.** Producer writes `topic`; consumer
  reads `topic`. Neither imports the other. A producer with zero
  matching subscribers drops every publish for free (the hub's
  window-cache returns 0 → early return).

## 3. YAML contract

A new top-level `metrics:` block — a map of **topic name → producer
def**. The map key *is* the hub topic; one producer owns one topic
(which may carry many rows).

```yaml
metrics:
  host.cpu:                              # map key = hub topic
    cmd: "top -bn1 | grep '^%Cpu'"       # shell; run via sh -c (execAsync)
    interval: 2000                       # ms between polls (default 2000)
    timeout: 2000                        # ms; kill a hung poll (default min(interval, 5000))
    focus_gate: true                     # skip the poll while the TUI is backgrounded (default true)
    extract:
      mode: regex                        # regex | columns | json
      fields:
        cpu: '([0-9.]+)\s+us'            # field -> where to read it (a capture group)
    schema:
      columns:
        cpu: { type: percent, unit: '%' }   # field -> how to coerce + scale
```

Multi-row (a table — e.g. top processes):

```yaml
metrics:
  host.proc:
    cmd: "ps -eo pid=,pcpu=,rss=,comm= --sort=-pcpu | head -20"
    interval: 2000
    extract:
      mode: columns
      delimiter: whitespace              # whitespace | tab | ","
      skip: 0                            # leading lines to drop (headers)
      row_key: pid                       # which field identifies a row
      fields:                            # field -> 0-based column index
        pid: 0
        cpu: 1
        rss: 2
        comm: 3
    schema:
      row_key: pid
      columns:
        cpu: { type: percent }
        rss: { type: number }   # ps reports rss in KiB, not bytes
        comm: { type: string }
```

### 3.1 Field location vs. field type — one source of truth

`extract.fields` says **where** a value is (a regex capture, or a
column index). `schema.columns[field].type` says **how** to coerce and
scale it. Type lives only in the schema — never duplicated in
`extract` — so the consumer's formatting and the producer's coercion
can never disagree. A field named in `extract` with no `schema.columns`
entry defaults to `number`.

### 3.2 Fields

| field | required | default | meaning |
|---|---|---|---|
| `cmd` | yes | — | shell command; run `sh -c cmd` via `execAsync` |
| `interval` | no | `2000` | ms between a poll completing and the next starting (polls are sequential — §4.1) |
| `timeout` | no | `min(interval, 5000)` | ms; SIGTERM a hung poll |
| `focus_gate` | no | `true` | skip the exec while `model.focused === false` (mirrors docker) |
| `extract.mode` | yes | — | `regex` \| `columns` |
| `extract.fields` | yes | — | field → capture (regex) or column index (columns) |
| `extract.delimiter` | columns | `whitespace` | `whitespace` \| `tab` \| any literal |
| `extract.skip` | no | `0` | leading lines dropped before parsing |
| `extract.row_key` | multi-row | — | which field is the rowKey; omitted → single stream (`_`) |
| `schema.columns` | recommended | `{}` | per-field `{ type, unit?, meta? }` (HUB.md §16) |
| `schema.row_key` | no | — | advisory row-key label |

## 4. Architecture — one new Sub kind, sourced from config

The producer is a new Sub **kind** (`metrics-poll`), added to
`_subKinds` in `js/app/state.js` beside `interval` / `process-stream` /
`metrics-mirror`. It is self-contained: the kind's `start` owns the
whole poll-exec-parse-publish-GC loop and its teardown, the same way
`process-stream` owns spawn + line-split + reconnect + teardown. No
Component, no Msg, no reducer arm — a producer has no UI and no user
interaction, so the Component machinery would be pure overhead.

Descriptors are sourced **app-globally** from config. In
`_appSubscriptions(model)`:

```js
for (const [topic, def] of Object.entries((model.config && model.config.metrics) || {})) {
  subs.push({ kind: 'metrics-poll', id: `metrics:${topic}`, topic, ...def });
}
```

`_desiredSubs` folds these in beside the existing app-global sources;
`reconcileSubscriptions` starts each on boot. Today config is immutable
after boot (no live reload — see §7), so producers start once and are
never torn down mid-session; the diff-by-key lifecycle (which *would*
stop a producer whose entry disappeared, on a hypothetical reload) is the
same every Sub gets. Keyed `metrics-poll:metrics:<topic>` so it is a
stable singleton per topic.

```
_appSubscriptions(model)              reconcileSubscriptions (finalizer, #D13)
  reads config.metrics  ──►  desired  ──►  start metrics-poll kind
                                                │
        ┌───────────────────────────────────────┘
        ▼   self-rearming setTimeout(interval), unref'd
   tick ──► (focus_gate && !focused) ? skip : execAsync(cmd, {signal, timeout})
                                                │  off-tick, never blocks the loop
        ┌───────────────────────────────────────┘
        ▼
   extract(stdout, def.extract, schema.columns)  ──►  [{rowKey, sample}]   (pure leaf, §6)
        │
        ├─ for each row:  hub.publish(topic, rowKey, sample)
        └─ GC: hub.delete(topic, rk) for rows in prev set but not this one
                                                │
        the existing metrics-mirror Sub (declared by a stats/table/gauge pane)
        samples hub.matrix(topic) → model.metrics[topic] → consumer repaints
```

Note the producer stops at `hub.publish`. It never touches
`model.metrics` — the `metrics-mirror` Sub the `stats`/`table`/`gauge` panes
declare (v0.6.6 Finding B) throttle-samples the hub into the model, so
`frame = f(model)` (#D5) is preserved unchanged. Producer and consumer
share nothing but the topic string.

### 4.1 The `metrics-poll` kind (shape)

> This sketch shows the base shape only. The **counter→rate** additions (§6.1) —
> `token.prev` as a `Map<rowKey,{sample,t}>`, the `counter`→`rate` schema rewrite
> before `defineTopic`, and publishing the derived `Δ/Δt` — are omitted here for
> clarity; see §6.1 for the shipped form.

```js
'metrics-poll': {
  normalize: (d) => (d && d.id && d.topic && d.cmd && d.extract ? d : null),
  key: (d) => d.id,
  start: (d, ctx) => {
    _hub().defineTopic(d.topic, d.schema || {});          // announce schema once
    const token = { timer: null, stopped: false, inFlight: false, prev: new Set(), ac: null };
    const ms = d.interval > 0 ? d.interval : 2000;
    const poll = async () => {
      token.timer = null;
      if (token.stopped) return;
      const skip = (d.focus_gate !== false && getModel().focused === false) || _replay().isReplaying();
      if (!token.inFlight && !skip) {
        token.inFlight = true;
        token.ac = new AbortController();
        try {
          const out = await execAsync(d.cmd, { signal: token.ac.signal, timeout: d.timeout || Math.min(ms, 5000) });
          if (!token.stopped) {
            const rows = extract(out, d.extract, (d.schema && d.schema.columns) || {});
            if (rows.length) {                             // empty/failed poll must NOT wipe the topic
              const seen = new Set();
              for (const { rowKey, sample } of rows) { seen.add(rowKey); _hub().publish(d.topic, rowKey, sample); }
              for (const rk of token.prev) if (!seen.has(rk)) _hub().delete(d.topic, rk);   // GC vanished rows
              token.prev = seen;
            }
          }
        } catch (e) { if (!token.stopped) console.error(`[metrics:${d.topic}] ${e && e.message}`); }
        finally { token.inFlight = false; token.ac = null; }
      }
      schedule();
    };
    const schedule = () => {
      if (token.stopped || token.timer) return;
      token.timer = setTimeout(poll, ms);
      if (token.timer.unref) token.timer.unref();
    };
    token.timer = setTimeout(poll, 0);                     // first poll ASAP; tracked + unref'd so stop() can cancel
    if (token.timer.unref) token.timer.unref();
    return token;
  },
  stop: (token) => {
    token.stopped = true;
    if (token.timer) { clearTimeout(token.timer); token.timer = null; }
    if (token.ac) { try { token.ac.abort(); } catch (_) {} }   // kill an in-flight child (execAsync signal)
  },
},
```

Lifecycle guarantees this mirrors from the proven kinds:

- **No pile-up** — polls are strictly SEQUENTIAL: the next `setTimeout`
  is armed only *after* the current poll's `await` completes (the
  `schedule()` call is at the end of `poll`), so overlapping ticks never
  exist. The gap between polls is therefore `interval` + the command's
  run time (not a fixed "poll start every `interval`"). The `inFlight`
  latch is a belt-and-braces re-entry guard on top of that.
- **Clean teardown** — the timers (including the initial `setTimeout(poll,
  0)`) are tracked + `unref`'d, so `stop()` cancels them and none holds the
  process open; `stop()` also aborts the in-flight child via the `execAsync`
  signal, so a producer torn down (at quit today, or a hypothetical live
  reload) cannot publish after teardown (docker's C5 keyed-abort). The
  publish/GC block is additionally gated on `!token.stopped`, so an
  in-flight poll that resolves *after* `stop()` publishes nothing.
- **Focus gate** — reads `getModel()` **live** inside the tick (the
  sanctioned pattern: the tick fires after the declaring model is
  stale, exactly like the `overlay-repaint` and `clock` Subs). Skips
  the exec while backgrounded so a hidden TUI doesn't wake the machine.
- **Row GC** — on a **non-empty** tick the producer diffs this tick's
  rowKeys against the prior set and `hub.delete`s the vanished ones, so an
  exited process / removed device drops out of the graph (docker deletes
  rows for non-running containers). An **empty** tick (a failed/timed-out
  poll — `execAsync` resolves `''`) is skipped, not read as "all rows
  gone", so one blip can't wipe the graph.

## 5. Why a Sub kind, not a Component

`process-stream` already sets the precedent: a Sub kind that owns real
IO (spawn, stream, reconnect) as a thin lifecycle wrapper, with the
domain logic (here, extraction) factored into a pure leaf. A producer
has no slice, no Msg the reducer would branch on, and no user input — a
`type: metrics` **Component** would need a whole new *headless instance*
mount path (Components are collected only from **placed** panes in
`_desiredSubs`), plus an empty `init`/`update`/effect triple per the
docker template. The kind route reuses the app-global sourcing seam that
already exists and adds exactly one entry to `_subKinds`. See
[reducer-route-purity](reducer-route-purity.md) for why keeping non-UI
IO out of the reducer/Msg path is the disciplined choice.

## 6. The extractor — a pure leaf

`js/leaves/metrics/extract.js` (NEW). Pure, no IO, unit-testable without
spawning anything:

```
extract(stdout: string, spec, schemaColumns) -> [{ rowKey, sample }]
```

- **`mode: regex`** (single stream, `rowKey = '_'`): for each `field →
  pattern`, run the regex (compiled multiline) over `stdout`, take
  **capture group 1 if the pattern has one, else the whole match**,
  coerce by `schemaColumns[field].type`, assign `sample[field]`. Emits
  one row. Prefer a capture group — a groupless pattern that matches more
  than the number (e.g. `cpu [0-9.]+`) feeds the whole match to `coerce`
  and yields `NaN`.
- **`mode: columns`** (multi-row): drop `skip` leading lines; split each
  remaining line on `delimiter` (`whitespace` → `/\s+/`); for each
  `field → index`, coerce by type; the field named by `row_key` supplies
  the rowKey (kept as a string — `string`-typed fields like `comm` pass
  through un-coerced). **Multi-line output needs a `row_key`** — with none,
  every line is keyed `'_'` and they collide (last line wins), i.e. it is
  only meaningful for genuinely single-row output.
- **`mode: json`** (single stream, or multi-row): `JSON.parse(stdout)`,
  then each `field → path` reads a **dotted/bracketed path** (`$.load.1m`,
  `a.b`, `cores[0].pct`, `cores.0.pct`) — dep-free, no `jq`. One row keyed
  `'_'` by default; with `row_key` set **and** an array root (the parsed
  value, or a `root:` path pointing at an array) it emits **one row per
  element**, each field path resolved *within* the element. A missing path
  → `NaN`/`''` (renders `—`); malformed JSON → no rows (a gap), never a
  throw.

Coercion by schema type (generalizes docker's `_parsePercent` /
`_parseMem`, which stay as docker's compound `used / limit` parser):

| type | coercion | example |
|---|---|---|
| `percent` | strip `%`, `Number` | `47.2%` → `47.2` |
| `bytes` | parse human size | `1.2GiB` → `1288490188` |
| `number` | `Number` | `128` → `128` |
| `string` | pass through (rowKey / label only) | `postgres` |
| `counter` | `Number` (raw tally); the producer derives its RATE — §6.1 | `6210830315` |
| `rate` | `Number` (a pre-computed per-second value) | `4076` |

A field that fails to parse yields `NaN`; the `stats` panel already
renders `NaN` as `—` and filters it from peak/avg, so a transient
mis-parse degrades gracefully instead of throwing.

### 6.1 `counter` → `rate` derivation

Net and disk throughput come as **monotonic counters** — `/proc/net/dev`
rx/tx bytes, `/proc/diskstats` sectors — that only ever increase. A
graph wants the *rate* (bytes/s), not the ever-climbing tally. Mark such
a field `type: counter` and the producer does the arithmetic:

- The `metrics-poll` kind keeps the previous RAW sample + its timestamp
  per row (in `token.prev`, which also drives row-GC). Each tick it
  publishes `Δcounter / Δt` (per second) in place of the raw value.
- `defineTopic` advertises the column to consumers as **`rate`** (so the
  `stats`/`table` panels format it as `B/s`); the *author* writes
  `counter`, the *consumer* sees `rate`.
- The **first** sample per row (no prior) and a **counter reset / wrap**
  (Δ < 0, e.g. an interface bounces) publish `NaN` — a one-tick `—`, never
  a bogus negative or huge spike.

```yaml
host.net:
  cmd: "cat /proc/net/dev | tail -n +3 | tr -d ':'"   # iface(0) rx_bytes(1) tx_bytes(9)
  extract: { mode: columns, row_key: iface, fields: { iface: 0, rx: 1, tx: 9 } }
  schema: { row_key: iface, columns: { rx: { type: counter }, tx: { type: counter } } }
```

A `table` on `host.net` then shows live per-interface `rx`/`tx` in `B/s`.
(Rates are formatted as byte rates; a non-byte counter still graphs
correctly, just labelled with byte units.)

## 7. Reconcile-gate & live rate-stepping

`reconcileSubscriptions` has a PERF gate (`_lastSubGate`) that skips the
desired-set rebuild when nothing relevant changed. For **v1 the producer
set is genuinely immutable post-boot** — there is **no live config
reload** in lazytui (config is loaded once at boot; `:restore-layout`
rebuilds `arrange` from the *already-loaded* config, it never re-reads
`config.metrics`). So the desired producer set never changes after the
first reconcile, and omitting `config.metrics` from the gate is safe —
**no gate change is required**.

Note the asymmetry with docker, which is worth remembering if live
reload is ever added: docker's producer rides the `arrange` ref because
it is a **placed pane**, so an arrange rebuild re-runs its
`subscriptions()`. A metrics producer is **headless (no pane)**, so an
arrange rebuild would *not* pick up an added/removed `config.metrics`
entry. The day live reload lands, `config.metrics` (and any live
rate-step's `refreshMs`, via a future `- Ns +` on a producer) MUST be
folded into `_lastSubGate` — the treatment docker's `dockerRefresh`
already gets (`state.js`) — or producers won't start/stop on a reload.

## 8. Replay & determinism

A producer's exec output is non-deterministic, but this does **not**
break replay:

- `hub.publish` is recorded in the event log (`hub.js` → injected
  `_recorder`), so a fold replays the exact samples the producer saw.
- The Sub reconciler is **skipped under replay** (`finalize.js:122`,
  `if (replay.isReplaying()) return;`), so a fold never *starts* a
  `metrics-poll`. And a fold is **synchronous** (the driver applies every
  entry in one loop), so a producer that was already live cannot fire a
  poll *mid-fold* either — a macrotask timer can't run until the loop
  yields. The `isReplaying()` check inside `poll` is therefore defensive
  (it can't observe `true` during a synchronous fold); the same pattern
  guards the overlay-repaint sub. Caveat: during an *interactive* replay
  session (playback driven by its own timers, live event loop running), a
  producer live at entry is not torn down and keeps polling — a known
  limitation shared with the other always-on polling subs, not specific
  to metrics.

So the producer is a pure external *source* at record time and a no-op
at replay time; `frame = f(model)` holds throughout.

## 9. Consumer side — the one small companion change

The `stats` panel is a **drill-down**: it renders the row currently
selected in another panel (`select_from`). That fits a multi-row topic
(`host.proc` selected from a process-list panel) but not a **single
stream** (`host.cpu` has exactly one row, `_`, and nothing to select).

Minimal companion (in scope for a usable host-cpu demo): let `stats`
accept a static `row:` when there is no `select_from` —

```yaml
sys_cpu:
  type: stats
  topic: host.cpu
  row: _            # render THE single stream, no select_from
```

`_resolveSelection` returns `panel.row` when `select_from` is absent.
~5 lines in `stats.js`, no new panel type.

The live-sorted numeric process **table** consumer that browses a
multi-row topic **shipped** — `type: table` (`js/panel/monitor/table.js`),
the list sibling of this drill-down `stats` panel. Select a row in the
table and a `stats` pane with `select_from: <table>` graphs it.

The snapshot **gauge** consumer also **shipped** — `type: gauge`
(`js/panel/monitor/gauge.js`), the bar sibling of the graph (`stats`) and
the list (`table`): it renders a topic's latest sample as horizontal meter
bars (built on the same `meterRow` primitive in `stats-graph.js` and the
percent colour ramp), one bar per row, ordered by the metered value. Its
rows are selectable too, so `select_from: <gauge>` works.

The **row detail card** shipped alongside — selecting a row in a `table`
or `gauge` projects it into the viewer's **Info tab** as a labelled card of
every **non-meta** schema column (not just the tabled subset), each formatted by its
type. This is `getInfo(rowKey, paneId)` on both panels: it resolves the
pane's topic (via `sliceForPane` — arm 1 keys off the paneId, so two panes
on different topics don't collapse) and hands the row to the pure
`rowInfo(metric, rowKey)` leaf (`js/leaves/metrics/row-info.js`), the
row-detail sibling of the compact cell `fmt`. Carry extra columns on the
producer's `schema` — even ones no panel tables — and they surface in the
card: the host-monitor demo's `host.proc` carries state / threads / rss /
ppid / user / full command line, turning the Output pane's Info tab into
btop's process-detail popup. Column ORDER in the schema is the card's order.

Still **deferred to their own backlog items** (not this doc): an
aggregate / per-core overlay mode (STATS.md already lists this as deferred).

## 10. Scope — v1 vs. deferred

**In v1 (this doc):**
- `metrics:` config block + parser recognition.
- `metrics-poll` Sub kind (poll / exec / extract / publish / GC /
  focus-gate / abort-on-teardown).
- Pure `extract` leaf: `regex` + `columns`, coercion for
  `percent` / `bytes` / `number` / `string`.
- Companion: static `row:` on `stats` for single-stream topics.

The **`counter` → `rate` derivation** (net/disk throughput) **shipped** —
`type: counter` on a field makes the producer publish `Δ/Δt` and advertise
the column as `rate`. See §6.1.

The **`json` extract mode** also **shipped** — `mode: json` reads dotted-path
`fields:` (`$.load.1m`, `cores[0].pct`) via `JSON.parse`, dep-free; an array
root + `row_key` (or a `root:` path) emits one row per element. See §6.

**Deferred (own backlog items — [[project_host_monitor_arc]]):**
- **Live rate-stepping** via `refresh_ladder` + the `- Ns +` control
  (§7).
- Consumer panels: aggregate/per-core overlay (§9). The process **table**
  (`type: table`) and the snapshot **gauge** (`type: gauge`) shipped — see §9.

## 11. Worked examples

Host CPU (single stream, regex):

```yaml
metrics:
  host.cpu:
    cmd: "top -bn1 | grep -E '^%?Cpu'"
    interval: 2000
    extract: { mode: regex, fields: { cpu: '([0-9.]+)[ ]*(?:us|%?us)' } }
    schema: { columns: { cpu: { type: percent, unit: '%' } } }
```

Per-core CPU (multi-row, one row per core — `mpstat`):

```yaml
metrics:
  host.core:
    cmd: "mpstat -P ALL 1 1 | awk '/^[0-9]/ && $2 ~ /[0-9]/ {print $2, 100-$NF}'"
    interval: 2000
    extract:
      mode: columns
      row_key: core
      fields: { core: 0, busy: 1 }
    schema:
      row_key: core
      columns: { busy: { type: percent, unit: '%' } }
```

Top processes (multi-row table — feeds the process table (`type: table`) and
the gauge (`type: gauge`), plus the `stats` drill-down):

```yaml
metrics:
  host.proc:
    cmd: "ps -eo pid=,pcpu=,rss=,comm= --sort=-pcpu | head -20"
    interval: 2000
    extract:
      mode: columns
      row_key: pid
      fields: { pid: 0, cpu: 1, rss: 2, comm: 3 }
    schema:
      row_key: pid
      columns: { cpu: { type: percent }, rss: { type: number }, comm: { type: string } }
```

> `ps -eo rss=` reports **KiB**, not bytes — so `rss` is typed `number`
> (the graph shows the KiB value). For a true `bytes` axis, multiply in
> the command (e.g. pipe through `awk '{$3=$3*1024; print}'`) and type it
> `bytes`.

## 12. Testing

- `js/test/test-metrics-extract.js` — the pure leaf: regex + columns
  modes, each coercion (`47.2%`, `1.2GiB`, `128`, string rowKey), `skip`,
  alternate delimiters, `NaN` on mis-parse, plus the hardening cases
  (grouped/space numbers → `NaN`, tab-delimited empty column, CRLF). No
  spawning.
- `js/test/test-metrics-producer.js` — the sub-kind end-to-end via the
  real `reconcileSubscriptions` seam: descriptor sourcing from
  `config.metrics`, `normalize` rejection, a `printf` single-stream poll
  landing coerced samples in `hub.snapshot(topic)`, and a temp-file-driven
  sequence proving **row-GC on a successful poll** and that an
  **empty/failed poll does NOT wipe** surviving rows, then teardown. Uses
  `hub._reset` / `_resetSubscriptions` for isolation. (There is no
  separate `smoke/` file; this top-level test is auto-discovered.)

## 13. File-change checklist

1. `js/parser/index.js` — recognize top-level `metrics:` → validate
   shape (each entry needs `cmd` + `extract`), collect `config.warnings`
   for malformed entries, land on `config.metrics`.
2. `js/leaves/metrics/extract.js` — **NEW**, pure extractor + coercion.
3. `js/app/state.js` — add the `metrics-poll` kind to `_subKinds`; emit
   one descriptor per `config.metrics` entry in `_appSubscriptions`.
4. `js/panel/monitor/stats.js` — companion: honor a static `row:` when
   `select_from` is absent (§9).
5. Tests (§12).
6. Docs — cross-ref from HUB.md (§16 producers) and LAYOUT/PLUGINS
   (new top-level section); CHANGELOG `[Unreleased]` when v0.6.18 opens.

---

*See [[project_host_monitor_arc]] for the surrounding arc and the
prioritized backlog this producer heads. STATS.md for the consumer it
feeds; HUB.md for the bus contract; `js/panel/navigator/docker.js` for
the proven poll → extract → publish reference this generalizes.*
