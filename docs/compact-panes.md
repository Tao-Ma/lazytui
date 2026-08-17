# Compact Panes — composite panels for btop-density layouts

**Status:** design (Tier 1). Step 1 of the arc — the narrow-pane phantom-hit
fix (paint publishes its drawn chrome regions; see `js/panel/chrome-regions.js`
and `reference_paint_hittest_agreement`) — **shipped** (`8d6c7580`). This doc
specs the **composite panel** (Tier 1); it is **not yet implemented**. The
interactive-sub-widget / group-box tier (Tier 2) is deliberately deferred — see
§8.

A **composite panel** stacks several *views* of host metrics inside **one**
bordered pane — a btop "box" (CPU graph + per-core bars + a meter together)
instead of lazytui's one-topic-one-pane. It closes the density gap with btop
*without* giving up the composable-panes model: a composite is still a single
draggable, focusable pane.

---

## 1. The gap, precisely

The host-monitor demo (`demo/host-monitor/tui.yml`) draws **12 bordered panes**
for what btop shows in **~4 boxes**. Two compounding causes:

1. **Single-view panes.** A lazytui panel renders *one* view of *one* topic — a
   `stats` graph, *or* a `gauge` bar set, *or* a `table`. btop's CPU box stacks
   the aggregate graph **and** the per-core bars **and** a stat line in one
   frame.
2. **Chrome tax.** Every pane pays a full border: 2 rows + 2 cols + a title.
   Twelve panes = twelve borders.

The measured 2-pane-per-metric redundancies:

| Concern | Today (panes) |
|---|---|
| CPU     | `cpu` (graph) + `cpubars` (per-process bars) |
| Memory  | `mem` (graph) + `disk` (usage gauge) |
| Network | `netgraph` (graph) + `net` (per-iface table) |
| Disk I/O| `diskio` (per-device table) — orphan |

## 2. The seam that makes this cheap

Every monitor renderer already has the exact shape (see `stats.js` /
`gauge.js`, end of `render`):

```js
const lines = [ …built content… ];
return renderPanel({ width, height, lines, title, hotkey, focused, chrome });
```

**Content production (`lines`) and border chrome (`renderPanel`) are already
separate — they're just fused in one function.** Split them:

```js
renderBody(spec, innerW, innerH, ctx) -> string[]   // border-less content lines
render(panel, w, h, …) { return renderPanel({ …, lines: renderBody(…) }); }
```

Once each monitor renderer exposes `renderBody`, a **composite** is nothing but
*stack several bodies, wrap the whole stack in one border.* No new rendering
engine — it reuses `stats._renderSection`, `gauge`'s bar loop, `meterRow`, and
the percent colour ramp verbatim. The elegant consequence: **a composite widget
spec is a today-pane's config minus the border** (§4).

## 3. Design principles it satisfies

- **YAML defines, TUI renders** (PRINCIPLES §1). The box, its widgets, their
  topics and heights — all declared in YAML. The framework contributes one
  generic stacker; it holds no knowledge of "CPU" or "memory".
- **One border, one focus, one draggable unit.** A composite is a single pane:
  the WM (geometry, paint, hit-test, free-config) still sees a flat pane. No
  nesting level is introduced — that is the Tier-2 cost we are *not* paying (§8).
- **Reuse, don't reinvent.** Widget bodies ARE the existing `stats` / `gauge`
  renderers with the border peeled off. The composite adds a height splitter and
  a `subscriptions` union (§7); nothing else.
- **`frame = f(model)`** (#D5). Each widget reads `model.metrics[topic]` (kept
  current by the shared `metrics-mirror` Sub, exactly like `stats`), so a
  composite is a pure render over the model — no new state, no reducer arm.

## 4. YAML contract

A new panel type `composite` with a `widgets:` list. Each entry is what you
would write as a standalone `stats` / `gauge` pane today, **minus** the border
identity (no per-widget `title` border, no `hotkey`), **plus** a height weight.

```yaml
panels:
  cpu_box:
    type: composite
    title: CPU                        # ONE border title for the whole box
    widgets:
      - { type: graph, topic: host.cpu,  row: _, height: 45% }   # aggregate line graph + meter
      - { type: bars,  topic: host.core, column: busy, label: core }   # per-core bars (host.core producer)
```

### 4.1 Widget fields

Each widget carries `type` + `topic` + the same config the matching standalone
panel accepts, plus:

| field | meaning |
|---|---|
| `type` | `graph` \| `bars` \| `meter` (§5) — which body renders |
| `topic` | hub topic (a `metrics:` producer, or a Component like docker) |
| `height` | `N%` of the box's inner height (anchored); omit → flex share (§6) |
| `label` | optional 1-row dim sub-header above the widget (default: none) |
| *(kind-specific)* | `graph`: `row`/`select_from`/`aggregate`, `metrics`, `window`, `graph`, `graph_color` — as `stats`. `bars`/`meter`: `column`, `label`, `max`, `sort_dir` — as `gauge`. |

`type` here is the **widget** kind, not a pane type — it never reaches the pane
dispatch. The composite Component owns the `composite` panelType; it interprets
`widgets[].type` itself.

## 5. Widget kinds (each maps 1:1 to an existing body)

| kind | body reused | renders |
|---|---|---|
| `graph` | `stats._renderSection` (per metric) | braille/blocks line graph(s) for the topic — single stream (`row: _`), `select_from`, or `aggregate`. A `height: 1` graph *is* a sparkline. |
| `bars` | `gauge` bar loop | one horizontal meter bar per row (per-core, per-mount, per-process), ordered by value — btop's bar chart. |
| `meter` | `stats` percent-meter (`meterRow`) | a single-value bar for a single-stream topic (e.g. `host.cpu` → one CPU meter). |

No `sparkline` kind: it is `graph` at `height: 1`. No `table` widget in Tier 1 —
a `table` carries a border-embedded sort control + cursor/scroll (interactive),
which is the Tier-2 case (§8); the read-only process list stays its own pane.

## 6. Rendering architecture

The render **dispatch is unchanged.** A composite is just another Component with
`panelTypes: { composite: { render } }`, registered like `stats`/`gauge`/`table`.
`paint._safeRender` resolves `type: composite` → the Component → its `render`;
placing one in a layout column needs **zero paint changes**.

Inside `composite.render(panel, w, h, _slice, opts)`:

```
innerW = w - 2,  innerH = h - 2
heights = splitWidgetHeights(panel.widgets, innerH)   # §6.1
lines = []
for (widget, i) of panel.widgets:
  if i > 0: lines.push('')                            # 1-row gap between widgets
  if widget.label: lines.push(dimHeader(widget.label))
  lines.push(...renderBodyFor(widget, innerW, heights[i], ctx))
return renderPanel({ width: w, height: h, lines,
                     title: panel.title, hotkey: panel.hotkey,
                     panelType: 'composite', focused, chrome })
```

`renderBodyFor` dispatches on `widget.type` to the reused body:
`graph → stats.renderBody`, `bars → gauge.renderBody`, `meter → stats meter
primitive`. Each body takes `(widgetSpec, innerW, innerH, ctx)` and returns
border-less lines — no `renderPanel` call, no cursor read.

### 6.1 Height budget

The box's inner height splits across widgets with the **same anchored+flex math**
as a column's panels (`js/leaves/wm/geometry.distributeColumnHeights`), one level
down: a widget with `height: N%` is anchored to `floor(innerH · N/100)`, widgets
without a `height` share the remainder equally, everything floors at a minimum,
and anchored widgets scale down proportionally if they overflow. Label rows (1
each) and inter-widget gaps are subtracted first. A widget allocated too few rows
to draw degrades to a one-line `(too short)` marker (as `stats` does today) —
never a broken frame. Reuse or mirror the existing leaf; do not fork the math.

### 6.2 Display-only bodies (the cursor question)

`gauge.render` today reads a per-pane cursor + scroll (`getSel`/`getScroll` by
`paneId`) and highlights the selected row — it is *interactive*. A composite
widget has **no paneId of its own** (the composite pane owns the one paneId), so
its `bars` body renders in **display mode**: sorted rows, no highlight, clipped
to the allocated height (top-N that fit). This is the deliberate Tier-1 boundary
— see §8. `graph` and `meter` are already cursor-less, so their bodies need no
change beyond the border peel.

## 7. Subscriptions — the one non-obvious wiring

`stats`/`gauge` each declare a `metrics-mirror` Sub for their one topic so
`model.metrics[topic]` stays current (v0.6.6 Finding B). A composite reads
**several** topics, so its `subscriptions(paneDef)` returns the **union** across
its widgets:

```js
function subscriptions(paneDef) {
  const seen = new Set(); const subs = [];
  for (const w of (paneDef.widgets || [])) {
    if (!w.topic || seen.has(w.topic + ':' + (w.window||40))) continue;
    seen.add(w.topic + ':' + (w.window||40));
    subs.push({ kind: 'metrics-mirror', topic: w.topic, window: w.window || 40 });
  }
  return subs;
}
```

Mirrors are keyed by topic, so multiple widgets (or panes) on one topic share a
single mirror — the reconciler dedups. This is the *entire* new wiring beyond
render; producers (`metrics:`) and the mirror are untouched.

## 8. What Tier 1 is NOT (the scope boundary)

Tier 1 ships **display composites only**. Explicitly out of scope this phase:

- **Interactive sub-widgets.** No cursor, `select_from`, or click-to-select
  *inside* a composite. The demo's one load-bearing interactive pane — `procs`
  (feeds the `procsel` drill-down + the detail card) — **stays its own pane**,
  which is what btop's PROC box is anyway. Composites don't change the hub /
  selection model, so a *separate* `stats` pane can still `select_from:` a
  *standalone* table as today.
- **Group box** (one border around N *independently focusable* panes). That
  needs a nesting level through geometry / paint / free-config / nav routing —
  high WM cost for UX btop itself doesn't have. Deferred; may never be needed
  once composites exist.

Rationale: display composites alone reach btop parity (§10). Adding interactivity
inside a box is a bigger, separable change to justify on its own demand.

## 9. Per-core CPU, folded in

Per-core is **bars, not overlay.** Overlaying N series in one braille grid is
neither btop's per-core choice (btop shows one aggregate graph + per-core
bars/meters) nor legible past a few homogeneous series — a labelled bar per core
answers "which core is pegged?" instantly; a tangle of same-coloured lines does
not. So per-core = a `bars` widget over a `host.core` producer:

```yaml
metrics:
  host.core:
    cmd: "mpstat -P ALL 1 1 | awk '/^[0-9]/ && $2 ~ /[0-9]/ {print $2, 100-$NF}'"
    interval: 2000
    extract: { mode: columns, row_key: core, fields: { core: 0, busy: 1 } }
    schema:  { row_key: core, columns: { busy: { type: percent, unit: '%' } } }
```

```yaml
      - { type: bars, topic: host.core, column: busy, label: core }
```

This needs **no engine code** — it's the existing `gauge` body over a new
producer. The multi-series *overlay* rasterizer (whose only real payoff is a
2-series net up/down graph) is **dropped** for this phase; note it as a possible
later nicety, not per-core's answer.

## 10. The demo, reshaped

```
   TODAY (12 panes)                    TIER-1 COMPOSITES (4 metric boxes + chrome)
┌CPU──────┐ ┌CPU bars──────┐        ┌CPU───────────┐ ┌Processes─────┐
└─────────┘ └──────────────┘        │ ▁▂▃▅▆▇ graph  │ │ pid  cpu comm│
┌Memory───┐ ┌Processes─────┐        │ core0 ███░ 72%│ │ 240 90%  node │
└─────────┘ └──────────────┘        │ core1 ██░░ 41%│ │ 404 62% claude│
┌Load─────┐ ┌Network───────┐        ├Memory────────┤ └──────────────┘
└─────────┘ └──────────────┘        │ ▁▂▃ graph     │ ┌Selected──────┐
┌Disk─────┐ ┌Disk I/O──────┐        │ MEM ███▊ 24%  │ └──────────────┘
└─────────┘ └──────────────┘        │ / ████░ 77%   │ ┌Host──────────┐
┌Network──┐                         ├Network───────┤ └──────────────┘
└─────────┘                         │ ▁▂▅▆ up/down  │ ┌Output────────┐
                                    │ eth0 ██░ 20K/s│ └──────────────┘
                                    └──────────────┘
```

The 8 *metric* panes (`cpu, mem, load, disk, netgraph, cpubars, net, diskio`)
fold into **4 composite boxes** — CPU, Memory, Network, Processes. That **is**
btop parity. `Selected` / `Host` / `Output` are lazytui-specific chrome btop has
no equivalent for; they stay. Representative composites:

```yaml
cpu_box:
  type: composite
  title: CPU
  widgets:
    - { type: graph, topic: host.cpu,  row: _, height: 50% }
    - { type: bars,  topic: host.core, column: busy, label: core }

mem_box:
  type: composite
  title: Memory
  widgets:
    - { type: graph, topic: host.mem,  row: _, height: 55% }
    - { type: meter, topic: host.mem,  row: _, column: mem }
    - { type: bars,  topic: host.disk, column: pct, label: mount }   # disk usage

net_box:
  type: composite
  title: Network
  widgets:
    - { type: graph, topic: host.nettotal, row: _, metrics: [rx, tx], height: 55% }
    - { type: bars,  topic: host.net,       column: rx, label: iface }
```

The exact final demo layout (which of `diskio`/`cpubars` fold where) is settled
during implementation; the mechanism above is what this doc fixes.

## 11. Scope — v1 vs deferred

**In v1 (this doc):**
- `type: composite` panel + `widgets:` list; parser recognition + validation.
- `renderBody` split for `stats` + `gauge` (border-less body reuse).
- Widget kinds `graph` / `bars` / `meter`; per-widget explicit `height:`.
- `subscriptions` union across widget topics.
- `host.core` producer (per-core bars) added to the demo.
- Demo reshaped to CPU/MEM/NET composites (+ PROC table + chrome).

**Deferred:**
- Interactive sub-widgets (cursor / `select_from` / click) inside a composite (§8).
- Group box — one border around N independently-focusable panes (§8).
- Multi-series overlay rasterizer (§9) — a later net up/down nicety, not per-core.

## 12. Testing

- **`renderBody` parity** — for `stats` and `gauge`, assert
  `render(...)` output equals `renderPanel({..., lines: renderBody(...)})` (the
  border peel is behaviour-preserving for a standalone pane).
- **Height split** — `splitWidgetHeights` unit cases: all-flex, mixed
  anchored+flex, overflow scaling, the too-short degradation, label/gap
  reservation.
- **Composite render** — a headless demo composite renders one border with N
  widget bodies stacked; the rect contract holds (h lines × w cells); a
  too-short box degrades per widget, not the whole frame.
- **Subscriptions union** — a composite over topics {A, A, B} yields exactly two
  `metrics-mirror` descriptors (dedup by topic+window).
- **Density regression** — the reshaped demo places ≤ N panes (guards the win).

## 13. File-change checklist

1. `js/parser/index.js` — recognize `type: composite` + `widgets:`; validate each
   widget has `type` + `topic`; collect `config.warnings` for malformed widgets.
2. `js/panel/monitor/stats.js` — extract `renderBody` (the `_renderSection`
   stack) from `render`; export it + the meter primitive.
3. `js/panel/monitor/gauge.js` — extract `renderBody` (the bar loop) in a
   cursor-less display mode; export it.
4. `js/panel/monitor/composite.js` — **NEW** Component: `render` (stack bodies +
   one border), `subscriptions` (union), empty slice/`update` (like `stats`).
5. `js/leaves/wm/geometry.js` — reuse `distributeColumnHeights` for widgets, or a
   small sibling `splitWidgetHeights` mirroring its anchored+flex math.
6. `demo/host-monitor/tui.yml` — `host.core` producer + CPU/MEM/NET composites;
   update `demo/host-monitor/README.md` sketch.
7. Tests (§12).
8. Docs — cross-ref from STATS.md (the body it reuses), LAYOUT.md (a new panel
   type), PLUGINS.md; CHANGELOG `[Unreleased]`.

---

*See STATS.md + `js/panel/monitor/gauge.js` for the bodies this reuses;
metrics-producer.md for the `metrics:` topics the widgets read; PRINCIPLES.md §1
for the YAML-defines/TUI-renders contract; `reference_paint_hittest_agreement`
for the Step-1 phantom-hit fix that precedes this.*
