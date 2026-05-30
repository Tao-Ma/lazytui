# Event Hub

A single in-process pub-sub data bus that decouples *who collects data*
from *who shows it*. Plugins publish samples to named topics; panels and
other plugins subscribe and read history. The hub doesn't know what any
topic *means* — it just routes.

This document specifies the contract. The hub stands alone — it has no
pre-committed consumers and no pre-planned follow-up branches.

## 0. Status & retrospective

**Status:** the hub is shipped (`js/panel/hub.js`, 32/32 smoke tests). The
first production consumer is `history.js` — the action-history ring
buffer is now backed by hub topic `actions.lifecycle` (single-stream,
window=100). No other producers or consumers wired in yet. The
foundation pattern stands: features plug in when they need streaming
data, not before.

**Why this section exists.** An earlier draft of this branch bundled
three concerns into one delivery:

1. The hub itself (data foundation).
2. A `decorateRow` plugin hook (UI extension surface).
3. A specific cpu/mem sparkline rendering for the containers panel.

That bundle shipped, was reviewed, and was reverted. The bundling was
the mistake — three different layers fused into "the sparklines branch"
because (3) was the only motivating end-user visible feature, and (1)+(2)
got dragged along to support it. Each of those layers deserves its own
design and its own branch:

| Layer | What it is | Status |
|-------|-----------|--------|
| **Hub** (this doc) | Pub/sub data bus. No opinion about UI. | Shipped. |
| **Decorator framework** | Generic plugin extension for UI surfaces — footer/status line (powerline / tmux style), panel rows, panel titles. Slot-based. | Retired in v0.5 Phase 5. Footer contributions now live on Component `viewContributions`; row/title/tab decorations inline in each Component's `render()`. See DECORATORS.md for migration notes. |
| **Stats panel type** | A YAML-declarable `type: stats` (or `type: graph`) panel that takes `topic:` and renders bars / tables / sparklines from hub data. | Shipped. |

A specific cpu/mem sparkline rendering is a ~20-line utility, not a
plugin and not a hook. It belongs inside whichever of the layers above
ends up consuming it (decorator slot or stats panel) — and the decision
is best made *with the consuming framework already in hand*, not
guessed at in advance.

**Lesson.** Foundations get *more* valuable when they're shipped naked.
A hub with no consumers is harder to misuse than a hub shipped with one
specific consumer's hooks pre-wired.

## 1. Why it exists

Without a hub, a feature that wants another plugin's data has to either
tightly couple to that plugin, duplicate the collection, or invent one-off
hooks. With a hub:

- Producers don't know who consumes their data.
- Consumers don't reach into producer internals.
- Multiple consumers share one collection cost (any number of panels and
  decorators can read the same `docker.stats` topic).
- If nobody listens, retention is zero — producer's `publish()` is a
  cheap drop. **Cost scales with what's rendered, not what's possible.**

## 2. The three data shapes

Different panels want different access patterns over the same producer.
The hub supports all three from one publish API.

| Pattern        | Example use                          | Producer publishes per tick | Consumer reads                    |
|----------------|--------------------------------------|-----------------------------|-----------------------------------|
| **Time series** | Sparkline of one container's CPU    | one row, scalar fields      | `history(topic, rowKey, N)` → list of samples |
| **Snapshot**    | Process table (top-style), latest only | many rows                | `snapshot(topic)` → Map<rowKey, sample> |
| **Matrix**      | Multi-line graph of all containers' CPU over 60s | many rows | `matrix(topic, N)` → Map<rowKey, [samples]> |

**Single-stream is the degenerate case of multi-row** with `rowKey = '_'`.
Logs (`docker.logs.<container>`), action lifecycle events, etc. all fit
the multi-row API trivially.

## 3. Core abstractions

### Topic

Hierarchical dotted name. Naming convention: `<plugin>.<dataset>` or
`<plugin>.<dataset>.<scope>`.

```
docker.stats                       # all container stats
docker.events                      # docker daemon events
docker.logs.<container>            # log stream per container
actions.lifecycle                  # action start/end events
history.entries                    # the existing action history (future
                                   # migration target)
```

Wildcards in subscriptions: `docker.*`, `docker.stats.*`. Producers never
publish wildcards.

### Row key

Identifies which row of a multi-row dataset a sample belongs to. For
`docker.stats` it's the container name. For a process table, the PID.
For pure single-stream data, callers pass `'_'` (or `null`, normalized
to `'_'` internally) and ignore it.

Row keys are strings. Producer chooses the format — they're opaque to
the hub.

### Sample

A plain object with at minimum a `ts` field (epoch ms). Other fields are
the row's columns at that timestamp.

```javascript
{ ts: 1735000000000, cpu: 12.3, mem: 245_000_000 }
```

The hub does **not** validate sample shape (see §6 for the optional
schema hint).

## 4. Producer API

```javascript
hub.publish(topic, rowKey, sample)
```

Drops the sample if zero subscribers (no buffer allocated).

If subscribers exist, appends to the per-(topic, rowKey) ring buffer,
trimming to `max(subscriber.window)`.

```javascript
hub.defineTopic(topic, schema?)        // optional
```

Lets the producer announce what columns / row key shape this topic uses.
Lightweight — purely informational. The hub doesn't enforce it; it's for
discoverability (the `:` cmdline could list "what topics exist") and for
generic table renderers that want a `unit` hint per column.

```javascript
{
  rowKey: 'container_name',                   // human label for the row dimension
  columns: {
    cpu:      { type: 'percent', unit: '%' },
    mem:      { type: 'bytes',   unit: 'B' },
    memLimit: { type: 'bytes',   unit: 'B', meta: true },  // scale ref, not a metric
    net_rx:   { type: 'rate',    unit: 'B/s' },
  },
}
```

Types are advisory: `'number' | 'percent' | 'bytes' | 'rate' | 'string' |
'duration'`. Unknown types render as plain numbers.

`meta: true` marks a column that's data, not a metric — generic
graph/stat consumers (e.g. STATS.md's auto-metrics inference) skip it
in default selection. Use it for ceiling/scale references (memLimit,
cpuQuota) that producers expose so consumers can scale a metric against
them, but aren't themselves worth graphing.

```javascript
hub.delete(topic, rowKey)
```

Producer-driven. When a container disappears, docker plugin calls
`hub.delete('docker.stats', 'gone-container')` so the row's history
clears. Hub does not GC by itself — producers know lifecycle, hub doesn't.

## 5. Consumer API

```javascript
hub.subscribe(topic | wildcard, opts) → token
```

Options:
| Field      | Default | Meaning                                            |
|------------|---------|----------------------------------------------------|
| `window`   | `1`     | How many samples to retain per row                 |
| `onUpdate` | none    | Optional callback `(topic, rowKey, sample) → void` invoked on publish |

`onUpdate` lets a panel request immediate re-render instead of waiting
for the next render-loop tick. Use sparingly — most panels can re-read
on the existing 10s refresh-driven render.

Wildcard subscriptions: `'docker.stats.*'` matches any topic with that
prefix. The same `window` applies to every matched topic.

```javascript
hub.unsubscribe(token)
```

When the last subscriber for a topic-row goes away, the ring buffer
shrinks (or empties) on the next publish.

### Three read methods (the access patterns from §2):

```javascript
hub.history(topic, rowKey, limit?) → [sample, ...]
```
Newest last. `limit` defaults to the full retained window.
For single-stream consumers: `hub.history('actions.lifecycle', '_', 100)`.

```javascript
hub.snapshot(topic) → Map<rowKey, sample>
```
Latest sample for every row in the topic. The native shape for table
panels — render straight into rows × columns. O(rowCount).

```javascript
hub.matrix(topic, limit?) → Map<rowKey, [sample, ...]>
```
Per-row history of the last N samples. Native for time-series-grid
visualizations (e.g. a multi-line graph, or per-row inline bars). Same
data as `snapshot()` would be `matrix(topic, 1)` — they share storage.

```javascript
hub.topics() → [string]
hub.schema(topic) → { rowKey?, columns? } | null
```

For introspection. The cmdline `:` could expose `:hub list` and `:hub
inspect <topic>` later.

## 6. Lazy retention

The hub computes the retention window per `(topic, rowKey)` as the max
`window` across all subscribers (including wildcards that match the
topic). Recomputed on subscribe / unsubscribe.

```
publish(topic, rowKey, sample):
  window = max(window across active subscribers matching topic)
  if window === 0: drop  # nobody cares
  buffer[topic][rowKey].push(sample)
  if buffer[topic][rowKey].length > window: shift()
  notify(topic, rowKey, sample)  # triggers onUpdate callbacks
```

So:
- No subscriber: publish is one map lookup + drop. ~O(1).
- Snapshot-only consumers (window=1): one sample per row in memory.
- History consumers (window=N): N samples per row.
- Subscribers come and go: window adjusts; existing buffer truncates on
  next publish (or immediately if you want — implementation detail).

## 7. Wildcards and hierarchical fan-out

```
hub.subscribe('docker.stats.*', { window: 40 })
```

Matches every topic whose name has the `docker.stats.` prefix. A
publisher pushing to `docker.stats.dev9-env` sees this subscriber and
keeps 40 samples. A separate `docker.stats.gitea` topic is independent.

This is how multi-row datasets fan out without per-row subscriptions:
a single subscribe to the wildcard yields every container's history.

Wildcard subscribers also get `onUpdate` for every matched topic.

## 8. Schema hint — when does it pay off?

Optional, never required. Worth setting when:

- The topic feeds a **generic table panel** that auto-formats columns
  (`unit: 'B'` → "245 MB"; `unit: '%'` → "12.3%"; `type: 'duration'` →
  "1m23s"). Without the hint, the table renders raw numbers.
- You want the topic to show up in `:hub list` with column names.
- You want type-aware bar/graph scaling (a `percent` series scales
  0–100; a `bytes` series auto-scales).

Plugins that publish ad-hoc without a generic consumer in mind can skip
`defineTopic()` entirely. Consumers that know their topic structure
hardcode the field names.

## 9. Concrete examples

### Time-series read for one row at a time

```javascript
// producer side — publishes once per refresh tick
for (const [name, stats] of containerStats) {
  hub.publish('docker.stats', name, {
    ts: Date.now(), cpu: stats.cpuPct, mem: stats.memBytes,
  });
}
hub.defineTopic('docker.stats', {
  rowKey: 'container_name',
  columns: {
    cpu: { type: 'percent', unit: '%' },
    mem: { type: 'bytes',   unit: 'B' },
  },
});

// consumer side — read one row's recent history
hub.subscribe('docker.stats', { window: 40 });

renderOneRow(name) {
  const samples = hub.history('docker.stats', name, 40);
  // → caller decides how to visualize: bars, ticks, line graph, etc.
  return samples.map(s => s.cpu);
}
```

### Process table (snapshot)

```javascript
// top-plugin (producer) — every 2s
const procs = collectProcesses();          // [{pid, cmd, cpu, mem}, ...]
for (const p of procs) {
  hub.publish('top.processes', String(p.pid), { ts: now, ...p });
}

// process panel (consumer)
hub.subscribe('top.processes', { window: 1 });    // snapshot-only

render() {
  const rows = hub.snapshot('top.processes');     // Map<pid, sample>
  // → standard table renderer using schema column types
}
```

### Multi-line graph (matrix)

```javascript
// graph plugin (consumer)
hub.subscribe('docker.stats', { window: 60 });

render() {
  const series = hub.matrix('docker.stats', 60);  // Map<container, samples>
  // → render N lines, one per container, last 60 samples each
}
```

### Single-stream (logs / events)

```javascript
// docker plugin (producer)
hub.publish('docker.logs.gitea', '_', { ts: now, line: 'Started' });

// log panel (consumer)
hub.subscribe('docker.logs.gitea', { window: 200 });

render() {
  const lines = hub.history('docker.logs.gitea', '_', 200);
}
```

`rowKey: '_'` is the single-stream convention. Same API path, no special
case in the hub.

### Action history (shipped consumer)

`history.js` publishes each action lifecycle as one sample on
`actions.lifecycle` (rowKey `'_'`, window 100). The entry object is
mutable and held by reference — `start()` publishes once, then
`append(line)` and `end(exitCode)` mutate the same object so the panel
always reads live state on render. No `onUpdate` callback needed: the
existing render-queue tick already drives history-panel repaint.

The panel reads via `history.all()` which wraps
`hub.history('actions.lifecycle', '_', 100)` and reverses for newest-
first display. Public API (`history.start`, `history.all`) is unchanged
from the pre-hub implementation; this is a pure refactor.

## 10. Tables — what the hub gives you, what's still on the panel

The hub stores **rows × columns × time**. A table panel renders
**rows × columns at one time** (latest snapshot). What the panel still
owns:

- Column **order** (hub doesn't define it; schema gives names but not order)
- Column **width** (display concern)
- **Sorting** (the panel sorts the snapshot map; hub stays oblivious)
- **Selection** (existing `getSel/setSel` per-panel state)
- **Filtering** (existing filter system, applied to rendered rows)

Schema hint provides:
- Column **types** for default formatters (`bytes` → human-readable; `%`
  → fixed precision; `duration` → `1m23s`).

This split is intentional: the hub is data, panels are presentation. A
generic table panel type (`type: table` in YAML, takes a `topic:` field)
becomes feasible once the hub ships — that's a separate ~80 LOC follow-up
plugin, not part of the hub itself.

## 11. Component API additions

```javascript
// panel/api.js — re-exports the hub singleton
const { hub } = require('./api');
```

The hub is a singleton accessed through `panel/api.js`. No new
top-level dependency for Component authors.

Components that publish should call `hub.defineTopic()` once during
their first refresh (or `init`) so introspection (`:hub list`) shows
their schema.

## 12. Subscription lifecycle and panel coupling

A panel-bound consumer must unsubscribe when the panel is removed from
layout. Two strategies:

- **Subscribe in `init()`** — for stable, Component-lifetime
  subscriptions. Most cases.
- **Subscribe per-render** — for transient consumers. Costs a
  subscribe/unsubscribe per frame. Discouraged.

If a Component is loaded but its panels aren't in the active layout,
consumers still subscribe (cheap) but no rendering happens. The hub
doesn't care; window stays small if the Component is the only
subscriber and only needs latest.

## 13. Threading / concurrency

The TUI is a single Node.js event loop. No threads, no locks. Publishes
are synchronous; `onUpdate` callbacks fire inline. Consumers must not
block in `onUpdate` (no I/O, no `execSync`) — same rule as `getItems`
and other Component callbacks (see PRINCIPLES.md §12 discipline rules).

## 14. Storage primitives

Per-(topic, rowKey) ring buffer, simple JS array with an index pointer.
At typical lazytui scale (50 rows × 60-sample window × 8 columns × 8
bytes per number ≈ 200 KB), no need for typed arrays or external stores.
If a consumer asks for a 10000-sample window, that's still <2 MB total —
fine. If someone requests gigabytes, that's a bug, not a hub problem.

## 15. Open questions (deferred)

- **TTL eviction** — currently producer-driven via `delete()`. If
  producers forget, rows leak. Acceptable for now; revisit if it shows
  up in practice.
- **Persistence** — k9s remembers state across sessions. Hub is in-memory
  only. Persistence would be a snapshot-on-shutdown / restore-on-load
  layer; out of scope.
- **Cross-process** — if lazytui ever spawns helper processes that want
  to publish (e.g., a long-running stats collector), the hub needs an
  IPC adapter. Not on the radar.
- **Backpressure** — onUpdate callbacks are sync. A slow callback would
  stall publish. Mitigate with the existing `async contract` rule:
  `onUpdate` does no I/O, only state mutation + scheduling.

## 16. Status

The hub is shipped (`js/panel/hub.js`, smoke-tested). Production consumers:

- `history.js` — backs the action-history ring buffer with topic
  `actions.lifecycle` (rowKey `'_'`, window 100). See §9.
- Stats panel (STATS.md) — consumes `docker.stats` to render time-series
  graphs. The docker plugin publishes the producer side.

**Layer rule.** Anything that uses the hub is a separate design with
its own doc and its own branch. Don't fuse hub additions with consumer
features in one commit — that's the bundling mistake §0 documents.
