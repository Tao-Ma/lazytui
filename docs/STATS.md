# Stats Panel

A YAML-declarable, multi-line live-graph panel — the first non-trivial
visual consumer of the event hub (HUB.md). Generic over the underlying
hub topic; docker is the first producer to wire in.

**Status:** shipped. Producer: docker Component publishes per-tick
numeric samples on `docker.stats`. Consumer: `panel/monitor/stats.js`
renders the focused container's CPU + MEM as multi-row block-char line
graphs. Schema flag `meta: true` keeps scale-reference columns
(memLimit) out of auto-graphed metrics.

## 1. Why a panel earns its space

The panel shows what a one-line row decorator (sparkline) can't:

- **Vertical resolution.** Multi-line line graph reads CPU% movement
  to ~5% precision; a sparkline resolves to one of 8 block heights.
- **Two metrics in parallel.** CPU and MEM stacked, each with its own
  scale.
- **Time-axis labels.** "now − 5m" / "now" labels give scale that a
  sparkline can't carry.
- **Peak / avg annotations.** Numeric overlays alongside the graph
  (`peak 92%  avg 38%`).
- **Drill-down affordance.** The panel reacts to selection in another
  panel — focusing a container in Containers updates the graph in
  Stats. Same pattern as Detail-follows-Group today.

## 2. Shape — focused-row deep view

The panel renders the **currently focused row's** history (as
identified by `select_from:`). For docker, that's the focused
container. CPU as a line graph, stacked over MEM as a line graph, plus
numeric overlays.

```
╭─(7) Stats: tui-test-flood ────────────────╮
│ CPU                  47.2%  peak 92  avg 38│
│ 100% ┤                                     │
│  75% ┤        ▄▄▄                          │
│  50% ┤      ▄█████▄    ▄▄                  │
│  25% ┤   ▄▄█████████▄▄████                 │
│   0% ┴───────────────────────────          │
│      └─ now − 5m              now          │
│                                            │
│ MEM                  125MiB / 2GiB  6.1%   │
│ 100% ┤      ▂▂▃▃▃▃▃▃▃▃▃                    │
│  50% ┤   ▁▁▂▃▃▃▃▃▃▃▃▃▃▃▃                   │
│   0% ┴───────────────────────────          │
╰────────────────────────────────────────────╯
```

When no row is focused (e.g., Containers panel empty for the group, or
the focused container has no history yet), the panel shows
`(no selection)` or `(no data yet)` respectively.

### Why this shape

- Vertical resolution, axes, dual metric, numeric annotation — none
  reachable from a one-line row decorator.
- Cross-panel selection-driven content matches the Detail-follows-
  Group pattern.
- Generic over topic: any topic with `percent`/`bytes` columns
  renders. Future producers (process top, network rates, request
  latency) drop in without panel changes.

Sparklines belong in slot-shaped surfaces (table column,
`viewContributions.footerLeft|Right`), not as a panel's primary
content — a panel-of-sparklines was rejected. Other shapes deferred:
all-containers overlaid graph (legibility past ~5 lines),
aggregate/system-pulse, heatmap (>20 containers).

## 3. YAML contract

Declare the stats panel in the pool, then place it in the layout via
a pool-id cell. Pool fields shown here; placement uses the standard
v0.6.1 cell shapes (see [LAYOUT.md](LAYOUT.md)).

```yaml
panels:
  stats:
    type: stats
    title: Stats
    topic: docker.stats     # which hub topic to read
    select_from: containers # which panel's focused row drives content
    metrics: [cpu, mem]     # which schema columns to graph, top-to-bottom
    window: 40              # samples retained per row (panel-driven sub)
```

| Field         | Required | Default                                | Notes |
|---------------|----------|----------------------------------------|-------|
| `type`        | yes      | —                                      | Always `stats`. |
| `topic`       | yes      | —                                      | Hub topic to subscribe. Must have a registered schema. |
| `select_from` | yes      | —                                      | Panel type whose focused row is the topic's row key. |
| `metrics`     | no       | all `percent` / `bytes` schema columns | Columns to graph, in order. |
| `window`      | no       | `40`                                   | Samples retained. With 10s producer poll → ~7 min of history. |

The schema-driven `metrics` default keeps the simple case
(`type: stats, topic: docker.stats, select_from: containers`) one-line.

**Schema requirements on the topic.** The producer must
`hub.defineTopic()` with column types — the panel uses `type` for axis
scaling and `unit` for value formatting:

- `percent` — fixed 0–100 axis. "30% CPU" reads visually as "around a third."
- `bytes` / `number` — local-max axis (0 to max sample in the window).
  The graph shows shape-of-change; idle and busy containers both get
  rows that fill. Absolute scale (e.g. `mem` vs. `memLimit`) is
  available in the row's data and surfaces via the existing detail
  panel; the stats panel doesn't double up on it.
- Columns flagged `meta: true` (e.g. `memLimit`) are skipped in
  default-metrics inference. The flag exists so producers can publish
  scale references / ceilings as part of the same sample without those
  fields turning into auto-graphed flat lines.

## 4. Plugin contract

Lives in `panel/monitor/stats.js` (framework code, alongside
`history.js` / `viewer.js` — not docker-specific).

```javascript
// panel/monitor/stats.js  (sketch)
const { getModel } = require('../../model/store');
const { esc, renderPanel } = require('../api');

function render(panel, w, h) {
  const rowKey = resolveSelection(panel);   // → row key, or null
  if (!rowKey) return renderEmpty('(no selection)');
  // Finding B (v0.6.6): read the store-mirror'd snapshot off the model, NOT
  // the hub bus live. The `metrics-mirror` Sub keeps model.metrics[topic]
  // current (throttled). Each topic's value is { series, schema }.
  const metric = getModel().metrics[panel.topic];
  const samples = ((metric && metric.series[rowKey]) || []).slice(-(panel.window || 40));
  if (!samples.length) return renderEmpty('(no data yet)');
  const schema = (metric && metric.schema) || { columns: {} };
  const metrics = panel.metrics || defaultMetrics(schema);
  // Split available height across metrics, render one line graph per.
  // ...
}

module.exports = {
  name: 'stats',
  init: () => ({}),
  update: (msg, slice) => slice,   // no-op — stats holds no Msg state
  subscriptions,                   // declares the `metrics-mirror` Sub
  // ... render, def
};
```

**Lifecycle.** Each `type: stats` panel declares a `metrics-mirror`
subscription (`subscriptions(paneDef) → [{kind:'metrics-mirror', topic,
window}]`); the framework reconciles the desired set each dispatch
(`app/state.reconcileSubscriptions`). The mirror subscribes to the hub
with the configured window (so the hub retains enough samples) AND
throttle-samples `hub.matrix(topic)` into `model.metrics[topic]`. The
hub computes per-topic retention as the max across all subscribers, so
two stats panels on the same topic with different windows share storage
at the larger.

**Mode: `content`.** The panel is read-only — no list semantics, no
selection state of its own. Selection is *projected* from `select_from`.

**No `getItems`.** The data flow is a **model read on render** — `render`
reads `model.metrics[topic]`; the `metrics-mirror` Sub does the throttled
hub pull OFF the render path (so `frame === f(model)`, #D5). Filtering,
sorting, idOf — none apply.

## 5. Producer wiring — docker.js

The docker Component already polls `docker stats` every 10s (a declared
`interval` Sub at `POLL_MS = 10000` drives a `dockerPoll` Msg → the
`dockerFetch` effect). The publish lives inside `dockerFetch`'s parse
loop, alongside parsing the strings into numbers:

```javascript
// In refresh(), after the stats parse loop:
const used  = parseBytes(memUsedStr);    // "120MiB"  → 125_829_120
const limit = parseBytes(memLimitStr);   // "2GiB"    → 2_147_483_648
const cpuN  = parsePercent(cpuStr);      // "3.2%"    → 3.2
hub.publish('docker.stats', name, {
  ts: Date.now(),
  cpu: cpuN,
  mem: used,
  memLimit: limit,
});

// On container disappearance (existing seen-set branch):
hub.delete('docker.stats', name);
```

Plus `defineTopic` once in `init()`:

```javascript
hub.defineTopic('docker.stats', {
  rowKey: 'container_name',
  columns: {
    cpu:      { type: 'percent', unit: '%' },
    mem:      { type: 'bytes',   unit: 'B' },
    memLimit: { type: 'bytes',   unit: 'B' },
  },
});
```

**Cost when no panel listens.** `publish()` is one Map.get + drop
(HUB.md §6). Parsing the strings still happens, but that's already in
the existing path — no regression.

**The docker Component slice (`slice.stats`) stays.** It powers
`getInfo()` and `copyOptions()` (which display human-readable strings,
not numbers). The numeric publish runs alongside, populated from the
same parse.

## 6. Cross-panel selection — `select_from`

The stats panel needs to know "which row are we showing?". Today's
framework state already has the answer:

```javascript
// In panel/monitor/stats.js
const { getSel } = require('../nav-state');   // Phase-4a per-Navigator nav slice
function resolveSelection(panel) {
  const items = apiGetItems(panel.select_from);
  return items[getSel(panel.select_from)] || null;
}
```

For docker, `getItems('containers')[getSel('containers')]` is the
focused container name — which is also the hub `rowKey` the docker
Component publishes under. **No new framework hook required**: the
stats panel just reads existing per-panel selection state via the
Phase-4a per-Navigator nav slice.

The contract: `select_from`'s panel must use the same row identity as
`topic`'s row key. The docker Component satisfies this by publishing
under container name, which `getItems('containers')` returns. Future
producers must publish under whatever `getItems(panel)` returns for
their `select_from` source — documented as part of the stats panel
contract.

**Selection changes ride the existing render loop.** input.js →
render-queue already paints on every selection change, so the panel
re-renders naturally when the user moves up/down in the Containers
list. No new framework hook for that path.

**Live samples DO need `onUpdate`** (caught during live exercise).
docker's `changed` flag flips only when the formatted CPU% /
mem string changes between ticks — `0.0% → 0.0%` leaves it `false`,
so the host's render-on-changed loop skips paints even though the hub
got a new sample. Since v0.6.6 (Finding B) the `metrics-mirror` Sub
subscribes to the hub with an `onUpdate` that schedules a *throttled*
trailing sample (`ms`, 250 ms (trailing/coalescing), independent of the
~10 s producer poll): it mirrors
`hub.matrix(topic)` into `model.metrics[topic]` via a `metrics_synced`
Msg, whose model change drives the repaint — bypassing the producer's
`changed` heuristic without re-introducing a per-publish dispatch.

## 7. Rendering — line graph rasterizer

Block-char Y-levels: `▁▂▃▄▅▆▇█` give 8 levels per cell. Stacking two
character cells vertically gets 16 levels — enough for a 5-row graph
to read cleanly.

For a graph rendered in `H` rows of height by `W` columns of width:

1. Right-align: take last `W` samples; left-pad with NaN if shorter
   so the newest sample is always at column `W-1`.
2. Compute scale: `percent` → fixed 0–100; `bytes`/`number` →
   0–max(seenInWindow).
3. For each sample, project value into `[0, H * 8]` "slots".
4. For each row from top to bottom, emit ` `/`▁`-`█` per column based
   on which slot of which row the value falls into.

The rasterizer is in `panel/monitor/stats-graph.js` (separate file so
it's testable in isolation against fixed sample arrays).

**Y-axis labels NOT shipped in v1.** Originally planned (`100% ┤` /
`75% ┤` / ...), dropped during implementation: at the panel widths we
get in practice (~50 cols) the axis labels eat too much horizontal
real estate from the graph itself. Revisit if a wider panel makes
labels worthwhile.

**Numeric overlay** (header line) — what shipped:
- `percent`: `12.8%  peak 49.9%  avg 25.7%`
- `bytes`:   `125MiB  peak 244MiB  avg 164MiB`
- Bytes scale is local-max (see §5 schema requirements);
  `memLimit` is data, not display.

## 8. Sizing

| Piece | LOC |
|-------|-----|
| `panel/monitor/stats.js` — panel def, render, selection | ~80 |
| `panel/monitor/stats-graph.js` — rasterizer + overlay formatters | ~80 |
| `docker.js` — `parseBytes` + `parsePercent` + publish + delete + defineTopic | ~30 |
| `tests/test-stats.js` — rasterizer + selection + producer wire-up | ~120 |
| YAML wiring in `test/test.yml` | ~5 |
| **Total** | **~315** |

Higher than HUB.md §0's "~120 LOC" estimate, which assumed a
sparkline shape. The ~200 extra is the line-graph rasterizer + tests
— the cost of earning the panel.

## 9. Test plan

`tests/test-stats.js` mirrors `test-history.js`'s style: section per
behavior, `assert/eq`, exception isolation per test.

1. **`parseBytes`** — `"120MiB"`, `"2GiB"`, `"500kB"`, `"0B"`,
   malformed input → numeric or `NaN`.
2. **`parsePercent`** — `"3.2%"`, `"0%"`, `"0.0%"`, missing/garbled.
3. **Producer publish.** Mock `execAsync` with a fixed `docker stats`
   stdout; run `docker.refresh(config)`; assert
   `hub.history('docker.stats', name, N)` returns expected samples.
4. **Producer delete.** First refresh publishes for a container, second
   refresh (without that container) calls `hub.delete`; assert
   `hub.history(...)` returns `[]`.
5. **Rasterizer shape.** Feed known samples + dimensions; assert
   exact output line-by-line. Pin the visual contract.
6. **Rasterizer scaling.** `percent` clamps 0–100 regardless of
   sample range; `bytes` scales to local max.
7. **Selection projection.** Mock `nav-state.getSel('containers')` and
   `getItems('containers')`; assert the panel reads the right row key.
8. **Empty states.** No selection → `(no selection)`. Selection but
   no samples → `(no data yet)`.
9. **Window sizing.** Two stats panels on same topic, different
   windows → hub retains the max.

Run via `node js/scripts/run-tests.js -q`.

## 10. Deferred

- **Y-axis labels.** Dropped from v1 — axis labels eat too much
  horizontal space at typical panel widths (~50 cols). Revisit on
  wider panel slots.
- **Color-coded thresholds** (CPU > 80% → red).
- **Mouse interaction.** Hover-for-value, drag-to-zoom. Rasterizer
  doesn't track per-column source samples.
- **Multi-line overlay.** "All containers, one line each." Likely a
  separate panel mode (`mode: stats-multi`).
- **Faster docker stats poll.** Currently 10s. A stats-only fast poll
  is a separate concern from the panel itself.
