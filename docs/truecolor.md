# Truecolor — design spec (the v0.6.13 arc)

> **Status:** SPEC FROZEN 2026-08-03 — planning conversation complete
> (shape + 4 scope decisions user-pinned), no code yet. Three review
> rounds hardened this spec before freeze: an architecture/TEA/replay
> recheck (moved depth adaptation out of the pure bottom, §P3) and a
> perf & test recheck (measured baselines, found two pre-existing
> hot-path hazards now scoped in as Phase-1 hardening, §"Hardening").
>
> **Goal:** close the color-depth gap against btop-class TUIs — RGB
> theme slots, value-mapped gradients, braille graphs, block meters —
> while leaving every structural invariant untouched: `frame = f(model)`,
> pure-bottom leaves, Msg-WAL replay, the acyclic module graph, and the
> cell-diff's string-determines-output contract. The arc introduces
> **zero new Msgs, Cmds, Subs, or model slices**: it lives entirely in
> the pure view projection plus one device-boundary adaptation.
>
> Root-cause analysis (2026-08-03, pre-arc): lazytui's glyph vocabulary
> is already at parity with btop; the gap is color depth — flat 16-color
> SGR + reverse-video highlights vs truecolor theme slots, gradients,
> tuned selection/footer — plus the missing braille/meter rasterizers.

## Scope decisions (user-pinned 2026-08-03)

1. **Full-app tuned background — OUT.** btop paints its own `bg`
   everywhere; that drags in background-color-erase / clear-color
   strategy and terminal-transparency interactions. Selection + footer
   bg (Phase 3) captures most of the perceived value. Revisit as its
   own arc if wanted.
2. **Terminal-pane color — follow-on arc, not this one.** The embedded
   PTY pane renders monochrome text *by documented design*
   (`js/io/term-screen.js` header; [foreign-components.md]). Coloring
   it means reading emulator cells with attributes and revising that
   contract — cleanly separable.
3. **Selection restyle — attempt, with verification.** Phase 3 tries
   tuned fg/bg selection; the `select-core` contract
   (`js/leaves/text/select-core.js:124` — `theme().selected ===
   'reverse'`, no inner markup, PRINCIPLES §8) gates it. If the
   contract fights back, selection stays `reverse` this arc and only
   the literals sweep lands.
4. **Version: v0.6.13.**

Also out of scope: user-authored theme files (candidate follow-on —
could ride the global config), live theme reload (previously dropped by
user decision in the config arc).

## Design pins

- **P1 — Early resolution.** Markup carries color *values*, never slot
  names. Panels keep fetching slots in JS (`` `[${theme().selected}]…` ``)
  and splicing the value into the row string. This preserves the
  load-bearing property that **the markup string alone determines
  output**: `diffRowToAnsi` re-parses the *previous* row through
  `richToAnsi` and must get what is on screen — resolution against
  ambient theme state would silently break the `prevRows` cache on
  theme switch. Free consequence: theme changes alter row strings, so
  the existing diff sees every row dirty with no forced-repaint
  special case.
- **P2 — Slot discipline by tripwire, not grammar.** All RGB lives in
  `themes.js`; panels obtain colors only via `theme()` / `gradient()`.
  Enforcement is a suite scan (hex color literals permitted only in
  `themes.js` and the quantize leaf's device palette table; scope
  `js/` excluding `js/test/`), not a slot-tag grammar — grammar-level slots were considered and rejected (they
  push theme state into the pure bottom and break P1).
- **P3 — Canonical-truecolor pipeline; depth adapts at the write
  boundary.** Hex atoms ALWAYS compile to `38;2`/`48;2`. Color depth
  is a property of the output *device*, so adaptation happens where
  the device is touched: the `render/paint.js` emit funnel (its
  `stdout.write` sites + the injected draw writer, `paint.js:42`),
  via a pure quantize leaf (truecolor → 256 → 16). Depth resolves once
  at startup in the impure shell: `COLORTERM`/`TERM` auto-detect,
  `LAZYTUI_COLOR=truecolor|256|16` env override, `color_depth:` global
  config key — the `LAZYTUI_CELL_DIFF` config-constant class. Frames,
  cells, and the diff are **depth-independent** (test-pinned, §Tests).
  `leaves/text/ansi.js` gains no state and no imports; the pure bottom
  stays pure. Bonus: content SGR from child streams (already truecolor
  in the wild) gets properly quantized on legacy terminals instead of
  being emitted raw.
- **P4 — Depth ≠ glyph choice.** Graph style is pane config
  (`graph: braille|blocks`, default `braille`), never derived from
  device depth — SGR depth and font glyph coverage are unrelated
  capabilities, and render must not consult the device.
- **P5 — Themes own gradients.** Theme slots gain hex values; gradient
  slots are `start/mid/end` anchor triples per metric class, expanded
  lazily into ~100-step arrays **cached per theme name** (`setTheme`
  runs per frame; expansion must not). API: `gradient(name, frac) →
  '#rrggbb'`. Graph leaves take the gradient fn as a *parameter*
  (leaves purity wall); the panel injects it. The derived-array cache
  lives inside the existing #D8 stateful-infra store — no new blessed
  exception.
- **P6 — Named tags stay byte-identical.** Existing 16-color tags emit
  exactly today's SGR (pinned by `test-ansi.js`), so Phase 1 lands
  with zero visual change.
- **P7 — Quantization is hand-rolled.** The 6×6×6 cube + gray ramp and
  nearest-of-16 are fixed math (~25 lines), not a spec-evolving
  standard — no dependency (dep policy: contrast `charWidth`, where
  the standard evolves and libs are mandatory).
- **P8 — Colorize run discipline.** Every gradient color run in
  generated markup is terminated with `[/]`. Reset-free per-column
  color is the quadratic-accumulation shape (§Hardening); the
  discipline is pinned by a contract test asserting linear output
  bytes.

## Phases

### Phase 1 — RGB pipeline + hardening

Visual impact: 1a/1b/1d land with zero visual change (P6, hardening);
1c's canonical hex palettes are the arc's first *deliberate* visible
change — theme colors become the schemes' true shades.

- **1a** `ansi.js` tag *parser* replaces the fixed `CODES` table: a tag
  is space-separated atoms — `bold|dim|reverse`, the named 16 colors,
  `#rrggbb` (fg), `on <name|#rrggbb>` (bg). Compiled SGR memoized in a
  module-level Map (bounded cap; vocabulary is finite — theme slots +
  swept literals + gradient steps; content cannot mint tags because
  `esc()` escapes brackets). Unknown atoms keep collapsing to RESET.
  Gate: ~1 µs/row (§Bench baseline A), named-tag bytes unchanged (P6).
- **1b** Depth detection + write-boundary downgrade per P3: pure
  quantize leaf (`leaves/`), applied at the paint emit funnel;
  identity fast-path at truecolor depth (the common case pays
  nothing). `color_depth:` key joins the global config allowlist.
- **1c** `themes.js`: the 6 themes move to their canonical upstream
  hex palettes (monokai/dracula/solarized/gruvbox/nord have published
  sets; minimal stays restrained); gradient slots + `gradient()` per
  P5. Slot values are already free-form strings — no schema change.
- **1d — Hardening pair** (perf recheck findings, both pre-existing,
  both promoted to the hot path by this arc's workload; land as their
  own commits, zero visual change, gated by the extended equivalence
  oracle + bench A/B):
  - **H1** Canonical per-channel SGR fold in `rowToCells`: `active`
    becomes last-wins per channel (fg / bg / attrs) instead of string
    accumulation. Kills the quadratic: reset-free per-column color
    measured at **128,530 bytes for one 120-col row** (cell N carries
    N concatenated sequences); reachable today via child-process
    content in the viewer. Bounds `cell.sgr`, and improves diff
    precision (equal-net-style cells with different histories stop
    reading as changed).
  - **H2** CSI scan without per-escape `slice(i).match()` (sticky
    regex): the old shape allocated ~the remaining row per escape —
    an O(row²) allocation class. LANDED 2026-08-03; measured effect
    at 120 cols is modest (26.7 → 23.3 µs/row escape-dense). The
    freeze-time "616 µs" attribution was WRONG: profiling during H2
    showed that probe figure was dominated by `richToAnsi`'s tag
    regex scanning from every raw `\x1b[` toward a `]` that never
    comes — catastrophic only on UNESCAPED escape-dense input, which
    production rows cannot be (content SGR arrives `esc()`-escaped;
    the sentinel round-trip reassembles it after tag replacement).
    Defensive guard (ESC excluded from tag interiors) folds into the
    1a parser regardless.
- **1e** Gates: tripwire scan (P2), bench A/B (§Bench), full suite ×2
  modes.

### Phase 2 — graph leaves + the stats payoff

- **2a** Braille rasterizer (2×4 dots/cell) as a sibling of
  `panel/monitor/stats-graph.js` (same home while single-importer, per
  the model-leaf pattern), same contract: samples newest-last, NaN
  gaps, right-aligned.
- **2b** Colorize layer for both rasterizers: value-mapped per-column
  color via the injected gradient fn, batching same-color runs into
  one tag, every run `[/]`-terminated (P8).
- **2c** `stats.js` adoption: braille graphs colored by value, plus an
  eighth-block horizontal meter row for percent-type current values.
  YAML: `graph: braille|blocks` (P4). STATS.md updated.

### Phase 3 — attribute sweep

- **3a** New semantic slots (`success`, `warning`, `match`,
  `match_current`, …); sweep the hardcoded `[green]`/`[yellow]`
  literals (`panel/commands.js`, `panel/free-config-view.js`,
  `panel/content/pty-lifecycle.js`, `panel/content/search.js`) onto
  slots.
- **3b** Footer restyle (`dim reverse` → tuned fg/bg pair) and the
  selection attempt per scope decision 3 — includes the select-core
  verification step and a PRINCIPLES §8 touch either way.
- **3c** Render-sim visual verification (captured-stdout template) at
  truecolor AND quantized-16 depth, per theme.

**Ship:** standing 4-track pre-release review, full gate (suite ×2 ·
smoke · acyclic · dead-exports · tripwire · bench), tag on user
closure.

## Tests (additions)

- **Truecolor vectors in the equivalence oracle** (`test-cell-grid.js`
  apply-patch battery; its simulator already parses SGR generically):
  styled rows, gradient rows, accumulation/canonicalization cases.
  This battery gates H1/H2. The suite currently contains **zero**
  `38;2` vectors — a truecolor regression would pass silently today.
- Parser units: hex fg/bg, compounds, invalid atoms → RESET, escaped
  brackets.
- Quantizer pins: known hex→256/16 mappings + the round-trip property
  (cube colors map to themselves).
- Theme validity: every slot value of every theme compiles to
  non-fallback SGR; gradient slots well-formed. Catches a typo'd hex
  at suite time instead of as a silently-RESET slot.
- **Depth-independence pin**: identical frame markup under all
  `LAZYTUI_COLOR` values — locks P3 so it cannot erode.
- Tripwire scan per P2.
- Colorize contract: run termination + linear output bytes on a
  gradient row (pins P8 / the H1 mitigation).
- Braille rasterizer battery mirroring the `rasterize` contract; a
  stats smoke with `graph: braille`; `test-stats.js` extension for the
  key.
- ×2-mode coverage is inherited via the `LAZYTUI_CELL_DIFF` env
  convention.

## Bench (additions + frozen baselines)

Additions: `richToAnsi` case in `bench-hotpaths.js` (nothing guards
the 1a rewrite today); truecolor scenarios in `bench-cell-grid.js`
(styled-row edit, gradient scroll tick); the downgrade transform at
256/16. A/B runs on the same filesystem (`/tmp`), per the standing
rule.

Baselines (2026-08-03, dev box, pre-arc tip `43ba148`; probe script:
scratchpad `bench-truecolor-probe.js`, to be carried into `js/test/`
during Phase 1):

| Probe | Result |
|---|---|
| A `richToAnsi`, 4-tag 120-col row | 0.9 µs/row — 1a gate: stay in this ballpark |
| B 1-cell change, 16-color vs truecolor styled row | 8.5 → 11.1 µs; 51 → 142 B (changed rows only — acceptable) |
| C graph scroll tick, mono vs reset-free per-col gradient | 24.8 µs / 134 B → 284.7 µs / **128,530 B** (H1 target) |
| C3 same, `[/]`-terminated runs | 2,725 B (linear ✓); the 616 µs was a probe artifact of unescaped input — see H2 |
| D unchanged-row `===`, 180 vs 336-char rows | 1.2 µs both — row widening is a non-issue |

`bench-cell-grid` 48×120 full-frame baselines: clock tick −85% bytes /
cell 240k ops/s; selection bar +1% / 117k; scroll −69% / 6.5k.

Acceptance: no regression on 16-color content; truecolor overhead
recorded here; gradient tick linear in bytes and materially under the
616 µs pre-H2 figure.

## Risks & watchpoints

- **H1 touches the most battle-tested leaf.** Cell identity semantics
  change (canonical vs accumulated `sgr`). Own commit, extended oracle
  + bench gates, both diff modes.
- **select-core §8** (scope decision 3): selected lines already strip
  inner markup, so a tuned fg/bg pair *should* be mechanically safe —
  but this is the one non-mechanical Phase-3 item; verify, don't
  assume.
- Two hexes may quantize to the same 16-color → occasional
  visually-noop cell emit at 16 depth. Accepted; legacy-only,
  bytes-level.
- Content SGR now quantized at legacy depths (was: emitted raw).
  Behavior change, an improvement — CHANGELOG note.
- Memo staleness is a non-issue by construction (entries are
  depth-independent per P3) — the cap is defensive only.

[foreign-components.md]: foreign-components.md
