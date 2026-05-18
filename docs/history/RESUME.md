# Resume — picking up TUI work later

> **Historical snapshot.** Written when lazytui still lived under
> `tools/tui/` inside the dev9 monorepo. Branch names (`dev/tui-dev9`,
> `backup/tui-initial`) and reconciliation tasks (wire `do.sh tui`,
> rebuild `dev9.yml`) refer to that bygone layout and do not apply to
> the standalone lazytui repo. Preserved for reference — the "Reload
> context fast", "What's shipped", and "Open design tensions" sections
> are still useful; the "Branch state" and "Next candidates" sections
> are dev9-monorepo specific.

Snapshot for the next session that returns to lazytui work after a
gap. Branch state, what's shipped, what's next, and the pointers
needed to reload context without rereading old transcripts.

## Reload context fast

```sh
node js/tui.js --spec | less
```

`--spec` prints the consolidated plugin-authoring bundle (SPEC.md +
PRINCIPLES.md + PLUGINS.md + HUB.md + DECORATORS.md + LAYOUT.md) to
stdout. Read that first if you're rebuilding context cold — it's the
canonical entry point for both AI and human plugin authors. Pipe it
to a file and feed it to an LLM as context for plugin work.

Feature deep-dives are not in `--spec`. Read separately when relevant:
`CMDMODE.md`, `TERMINAL.md`, `STATS.md`. `FUTURE.md` lists Done +
Closure candidates.

## Branch state

| Branch                       | Purpose |
|------------------------------|---------|
| `dev/tui-dev9`               | Current dev branch. Rebased onto `main`; ready for PR/merge once integration commit lands. |
| `backup/tui-initial`         | Full 192-commit history of the rewrite. Parachute — don't branch from here. |
| `backup/tui-parser-ancestor` | Old parser branch already merged into main. Reference only. |
| `main`                       | Tip includes VPN-only access changes. Start TUI work from `dev/tui-dev9`. |

`dev/tui-dev9` carries the TUI rewrite + this RESUME doc + the
`--spec` doc bundle. The original do.sh / dev9.yml integration
commit was dropped during rebase — needs reconstruction (see "Next").

## What's shipped

Node.js + YAML-driven plugin framework under `tools/tui/`:

- **Subsystems**: hub (HUB.md), decorators (DECORATORS.md), `:cmdline`
  (CMDMODE.md), stats panel (STATS.md), embedded PTY terminals
  (TERMINAL.md), action history, multi-select + bulk verbs.
- **Docker plugin**: live event streaming, bulk container commands,
  stats publish to `docker.stats` topic with `meta:`-flagged
  `memLimit` for scale data.
- **Plugin authoring spec**: `tools/tui/SPEC.md` + `--spec` flag in
  `tui.js`. Single-shot bundle of every doc a plugin author needs.
- **Tests**: 10 JS smoke suites + 124 Python parser tests, all green.
  `node js/run-tests.js -q` and `.venv/bin/python -m pytest tests/ -q`.
- **6 themes**, design mode (`--design`), confirm/prompt/copy/menu
  overlays, diff-paint render loop.

See `FUTURE.md` "Done" for the comprehensive list.

## Next candidates (priority order)

**Reconciliation work first:**
1. **Reconstruct the integration commit.** Wire `do.sh tui` to the
   node launcher (probe PATH + `/usr/local/bin` + `/opt/homebrew/bin`
   + bundled Linux binary in `tools/output/node-install/`). Update
   `dev9.yml` with the new `layout:` + `plugins:` blocks (extracting
   maintenance group into `tui-plugins/maintenance.yml`). Add
   `desc:` fields on actions; `tab: true` on detail-pinnable
   actions. The original commit (dropped during rebase onto current
   main) is at `backup/tui-initial` — useful reference, not direct
   cherry-pick.

**Small wins from `FUTURE.md` Closure candidates:**
2. **Sparkline widget** (~30 LOC). Decorator-only — column in a future
   table panel, OR a footer slot tracking one live signal. Validates
   hub + decorator combo end-to-end. **Anti-pattern**: don't make a
   panel of sparklines — see HUB.md §0.
3. **Per-context help** (~30 LOC). Plugin `keyHints` already exist;
   wire them into a panel-scoped `?` overlay replacing the global
   help screen.

**Medium-effort parity gaps from `FUTURE.md`:**
4. Keymap customization (user-configurable bindings).
5. Process list — top-style panel; new hub topic.
6. Drill-down navigation (parent/child resource hierarchy).

**From `STATS.md` §10:**
7. Faster docker stats poll — currently 10s; the cadence is what
   makes the live graph feel slow. Stats-only fast poll independent
   of the full refresh.
8. Color-coded thresholds; Y-axis labels (deferred from v1).

## Open design tensions

- **Parser coverage gap.** `PanelConfig.config: dict` extras
  pass-through (used by stats panel's `topic` / `select_from` /
  `metrics` / `window`) is verified by manual boot smoke check, not
  pytest. Add ~30 LOC to `tests/test_parser.py` next time the parser
  gets touched.
- **3-panel right-column constraint.** `test/test.yml` had to drop
  `history` to fit `stats`. PRINCIPLES.md §9 says 1–3 right; parser
  doesn't enforce it. If multiple right panels become routine,
  revisit the constraint or the height-split heuristic.
- **`onUpdate: scheduleRender` lesson.** STATS.md design phase guessed
  it wasn't needed; live exercise revealed it was — docker.refresh's
  `changed` flag misses stable strings (`0.0% → 0.0%`), so panels
  fed by polling producers should subscribe with `onUpdate` if
  freshness matters. STATS.md §6 captures the reasoning.

## Live exercise

```sh
./tools/tui/test/run.sh up all       # bring chaos profile up (busybox stack)
./tools/tui/test/run.sh tui          # launch TUI against test.yml
```

`test/test.yml` lays out: Containers + Groups (left) | Actions + Stats
+ Detail (right). Select a container in Containers → Stats follows
(CPU + MEM line graphs, 10s cadence). Try `:tail 50` in cmdline mode
against `tui-test-running` to exercise the args-plumbing path.
