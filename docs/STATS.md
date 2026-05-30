# Stats Panel

A YAML-declarable, multi-line live-graph panel — the first non-trivial
visual consumer of the event hub (HUB.md). Generic over the
underlying hub topic; docker is the first producer to wire in but
not the only conceivable one.

This document is the design record **before the first line of code
lands**. It captures the alternatives considered, the chosen shape,
and the rationale, so future work inherits the trade-offs rather than
rediscovers them.

## 0. Status & framing

**Status:** shipped (`d4274d6` impl + `6fc9edb` live-repaint fix).
Producer: docker Component publishes per-tick numeric samples on
`docker.stats`. Consumer: `components/stats.js` renders the focused
container's CPU + MEM as multi-row block-char line graphs. Schema
flag `meta: true` keeps scale-reference columns (memLimit) out of
auto-graphed metrics.

This doc was written *before* the implementation landed (the goal:
lock the shape before coding so we don't repeat HUB.md §0's mistake of
bundling three layers because one of them was the only visible
feature). Sections that drifted from what shipped are noted inline.

**Framing question.** The hub gives us per-row time-series. What does a
panel look like that's *worth a panel*?

A sparkline glyph next to a container row is information-dense — but
it's a one-line decoration, reachable through the existing decorator
framework. If a stats panel renders the same shape stacked vertically
(one sparkline-row per container), it's just decorators with more
borders. The new panel must show something the row decorator *can't*.

That framing is the core of the design. It rules out the
all-containers-mini-graph shape early (§2 alternatives) and points at
the deep-view shape (§2).

## 1. Why a panel earns its space

A dedicated panel justifies itself when it shows information the row
decorator can't:

- **Vertical resolution.** A multi-line line graph reads CPU%
  movement to ~5% precision; a one-line sparkline only resolves to
  one of 8 block heights.
- **Two metrics in parallel.** CPU and MEM stacked vertically, each
  with its own axis scale and units.
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

- **Justifies the panel.** Vertical resolution, axes, dual metric,
  numeric annotation — none reachable from a row decorator.
- **Matches the test stack story.** Chaos profile produces visible
  spikes (flood, crashloop) — a multi-line graph reads them
  legibly; a sparkline blurs them.
- **Idiomatic for the framework.** Cross-panel selection-driven
  content already powers Actions (group-driven) and Detail
  (selection-driven). Stats follows the same pattern.
- **Generic over topic.** Nothing in the panel logic is
  docker-specific — any topic with `percent`/`bytes` schema columns
  renders. Future producers (process top, network rates, request
  latency) drop in without panel changes.

### Considered alternatives

| Shape | Why rejected |
|-------|--------------|
| Per-container tile rows (3 lines each: header + CPU sparkline + MEM sparkline, repeated vertically) | A panel of sparklines is the **anti-pattern** — sparklines are decorator-layer widgets (one-line, slot-shaped), not panel content. Same data is reachable through a future table-column or a footer decorator slot, without the borders. |
| All-containers grid (one row per container, sparkline only) | Same anti-pattern — sparklines belong in slots that already justify their density (column among columns, footer widget), not as a panel's primary content. See HUB.md §0 retrospective (the deferred sparkline-widget discussion). |
| All-containers single multi-line graph (overlaid lines, one per container, color-coded) | Compelling but legibility falls apart past 4–5 lines. Defer until someone asks. |
| Aggregate / system-pulse graph (sum across all containers) | Useful but answers "is the host busy?" not "what's misbehaving?". Defer. |
| Heatmap (rows × time, color = CPU%) | Earns its space at >20 containers; overkill for typical small stacks (5–10). Defer. |

**Sparklines are not deferred — they're a different layer.** A future
table-style panel could carry a stat column rendered as a sparkline,
or the footer could carry a sparkline tracking one live signal. The
footer case is `viewContributions.footerLeft|Right` on whichever
Component owns the signal (DECORATORS.md notes the retirement); the
column case is inline in that panel's `render()`.

## 3. YAML contract

```yaml
layout:
  right:
    panels:
      - type: stats
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

Lives in `components/stats.js` (framework code, alongside
`history.js` / `viewer.js` — not docker-specific).

```javascript
// components/stats.js  (sketch)
const { S } = require('../../state');
const { hub, esc, theme, renderPanel, getSel, getItems: apiGetItems } = require('../api');

const subTokens = new Map();   // panelId -> hub subscription token

function init(panel) {
  // Subscribe with the configured window so the hub retains enough samples.
  const tok = hub.subscribe(panel.topic, { window: panel.window || 40 });
  subTokens.set(panel.id, tok);
}

function render(panel, w, h) {
  const rowKey = resolveSelection(panel, S);   // → '_'-able row key, or null
  if (!rowKey) return renderEmpty('(no selection)');
  const samples = hub.history(panel.topic, rowKey, panel.window || 40);
  if (!samples.length) return renderEmpty('(no data yet)');
  const schema = hub.schema(panel.topic) || { columns: {} };
  const metrics = panel.metrics || defaultMetrics(schema);
  // Split available height across metrics, render one line graph per.
  // ...
}

module.exports = {
  panelType: 'stats',
  def: { mode: 'content', render, init },
};
```

**Lifecycle.** Each `type: stats` panel in the layout subscribes once
at init with its configured window; the hub computes the per-topic
retention as the max across all subscribers, so two stats panels on
the same topic with different windows share storage at the larger.

**Mode: `content`.** The panel is read-only — no list semantics, no
selection state of its own. Selection is *projected* from `select_from`.

**No `getItems`.** The data flow is hub-pull on render, not
panel-collect. Filtering, sorting, idOf — none apply.

## 5. Producer wiring — docker.js

The docker Component already polls `docker stats` every 10s
(`refresh()`#L192–217). The publish is a 5-line addition inside the
existing parse loop, plus parsing the strings into numbers:

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

**Existing `statsCache` stays.** It powers `getInfo()` and
`copyOptions()` (which display human-readable strings, not numbers).
The numeric publish runs alongside, populated from the same parse.

## 6. Cross-panel selection — `select_from`

The stats panel needs to know "which row are we showing?". Today's
framework state already has the answer:

```javascript
// In components/stats.js render()
const { getSel } = require('../state');
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
docker.refresh's `changed` flag flips only when the formatted CPU% /
mem string changes between ticks — `0.0% → 0.0%` leaves it `false`,
so the host's render-on-changed loop skips paints even though the hub
got a new sample. The stats panel subscribes with
`onUpdate: scheduleRender` so each new publish drives a debounced
repaint, bypassing the producer's `changed` heuristic.

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

The rasterizer is in `components/stats-graph.js` (separate file so
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
| `components/stats.js` — panel def, render, selection | ~80 |
| `components/stats-graph.js` — rasterizer + axis labels + overlay formatters | ~80 |
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
7. **Selection projection.** Mock `S.sel.containers` and
   `getItems('containers')`; assert the panel reads the right row key.
8. **Empty states.** No selection → `(no selection)`. Selection but
   no samples → `(no data yet)`.
9. **Window sizing.** Two stats panels on same topic, different
   windows → hub retains the max.

Run via `node js/run-tests.js -q`.

## 10. Open questions / deferred

- **Y-axis labels.** Originally planned, dropped from v1 (see §7).
  Revisit if a wider panel slot becomes available.
- **Color-coded thresholds** (CPU > 80% → red). Trivial extension; defer
  until the v1 visual feels right.
- **Mouse interaction.** Hover for value-at-time, drag-to-zoom. Not
  on the radar; the rasterizer doesn't track per-column source samples.
- **Multi-line overlay.** "All containers, one line each, color-coded."
  Reachable as a follow-up panel mode (`mode: stats-multi`?). Defer.
- ~~**Stream-driven re-render.**~~ Shipped — `onUpdate: scheduleRender`
  on the panel's hub subscription drives repaint per sample (see §6).
  Caught during the live exercise; was incorrectly guessed as
  unnecessary in the design phase.
- **Persistence across restarts.** Hub is in-memory (HUB.md §15); the
  stats panel inherits that limitation. Out of scope.
- **Faster docker stats poll.** Currently 10s (docker Component default).
  Visible motion in the graph requires either waiting through the
  10s tick or lowering the interval globally. A stats-only fast poll
  is a separate concern from the panel itself.

## 11. Branch hygiene (HUB.md §0 lesson applied)

This branch ships:

- ONE producer wiring (`docker.js` publish + delete + defineTopic).
- ONE consumer (`components/stats.js` + rasterizer).
- Tests for both.
- YAML wiring in `test/test.yml` to live-exercise it.

This branch does NOT ship:

- Row-decorator sparklines (would re-bundle the rejected layer).
- A second producer (no premature generalization until a real second
  consumer needs it).
- Mouse / color-threshold / multi-line overlay extensions (§10).

If the implementation grows tendrils into other layers, that's a
signal to stop and split — not to keep going. The rule from HUB.md §0
applies here: foundations get *more* valuable when shipped naked.
