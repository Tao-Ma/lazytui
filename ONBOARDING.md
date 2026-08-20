# Onboarding — lazytui

A fast orientation for getting productive in this repo. For the deep contract,
read `docs/` (or run `bin/lazytui --spec`, which concatenates the authoring
bundle into one file). This guide is the map; the docs are the territory.

## What lazytui is

A glue framework for the tools around your real work: you describe your project
in a **YAML config** and lazytui renders it as an interactive **TUI** (and the
same config drives a headless **CLI**). "YAML defines, TUI renders." AI writes
the config; you run it. Node.js, MIT-licensed.

## Get running (2 minutes)

```sh
git clone https://github.com/Tao-Ma/lazytui.git && cd lazytui
npm install --omit=dev          # deps: node-pty, @xterm/headless, js-yaml, eastasianwidth, wcwidth
node js/scripts/run-tests.js     # the full suite (~200 files) — this is the gate
cd demo/postgres && ./run        # a worked demo (needs Docker)
```

Node ≥ 18. `node-pty` is optional (embedded terminals); the core runs without it.

## The mental model

lazytui is a **TEA** (Elm-ish) architecture — internalize these four and most of
the codebase follows:

- **`frame = f(model)`** — rendering is a pure function of the model. No renderer
  reaches into live state or does I/O. (The one sanctioned exception is a
  *foreign component* like the embedded terminal — see `docs/foreign-components.md`.)
- **Single writer per slice** — each Component owns one slice of the model and is
  the only writer. `update(msg, slice) → (nextSlice, cmds)`. Never a 3rd arg.
- **Messages in, Cmds out** — side effects are declared as Cmds and run by the
  runtime, then their results come back as Msgs. Subscriptions (`subscriptions()`)
  declare ongoing sources (timers, streams); the reconciler owns their lifecycle.
- **Replayable** — every Msg is logged to a WAL; a session reconstructs by folding
  the Msg stream through the same pure reducers (`--record-print`, `--record-load`).

## Repo map (`js/`)

| Dir | What lives there |
|---|---|
| `app/` | Boot (`tui.js`), config load + `initState` (`state.js`), the Component registry list (`components.js`), CLI/replay entry points |
| `parser/` | YAML → resolved config (`index.js`), schema validation (`schema.js`) |
| `panel/` | The Components (panel types): `navigator/`, `monitor/`, `terminal/`, `fabric/`, plus the registry/routing (`api.js`, `route.js`) |
| `dispatch/` | The dispatch loop, reducers (`update/`), runtime (effects, subscriptions, replay, finalize) |
| `render/` | Paint pipeline (`paint.js`), footer, geometry |
| `leaves/` | Pure helpers — text/markup/width, wm (arrange/pool), tree, input tokenizing. No upward imports |
| `io/` | Terminal (PTY), session-log (WAL), agent |
| `model/` | The model store |
| `test/` | `test-*.js` (unit) + `smoke/` (boot+drive+render scenarios) |

## Common tasks

**Run / iterate the app.** `bin/lazytui <config.yml>`. To dogfood an in-dev
lazytui inside another project without publishing, set `LAZYTUI_PATH` (every
`bin/lazytui` re-exec's against it):
```sh
export LAZYTUI_PATH=~/exchange/lazytui
~/exchange/pg-tui/run
```

**Extend as a consumer — two ways.** Most projects need *no JS*: built-in panel
types (`table`, `gauge`, `stats`, `composite`, `terminal`, …), actions→scripts,
`metrics:` producers, themes — all declarative YAML. For a *new panel type in
JS*, write a Component (same API as the built-ins) and declare it in config:
```yaml
components:
  - ./components/my-panel.js   # lazytui require()s + registers it at boot
```
See `docs/PLUGINS.md` (the Component contract) and `docs/PROJECT.md` (the
consumer/config boundary).

**Add a built-in panel type.** Write the Component under `js/panel/…`, add it to
`BUILTIN_COMPONENTS` in `js/app/components.js`, reference its `type:` in a config.
`docs/SPEC.md` has the minimal-Component quickstart.

**Compile an app to a single native binary.** `lazytui build tui.yml` → one
self-contained executable (via Bun's `--compile`; no Node/Bun needed to *run*
it). Or hand-write an entry with `require('lazytui').run({ config, components })`.
The release also ships prebuilt per-platform `lazytui` CLI binaries. Full recipe
+ caveats (terminals off, `--spec` source-only, ~90 MB): `docs/packaging.md`.

**Add a demo.** Read `DEMO.md` first — the "pick the shape" rule and the
"fix the prompt, not the artifact" loop are load-bearing. Ship the
`.agent-prompt.md` alongside whatever the agent produced.

## Conventions that bite

- **Gate every commit on the FULL green suite** (`node js/scripts/run-tests.js`,
  joined with `&&`). Test-stats don't full-render, so `render()` bugs surface
  only in the full run. CI runs the same on every push.
- **`esc()` every dynamic `[` in renderer markup.** The Rich-style markup pipeline
  swallows an unescaped `[` as a tag open and breaks width calc → misaligned
  borders. For colored content emitted into a buffer, use the semantic theme
  tokens (`[warning]`/`[error]`/`[accent]`).
- **No inner markup inside a `[reverse]` selected line** — any `[/]`/color escape
  resets the reverse mid-line. Selected rows are plain text.
- **Reducer discipline** — `update` is `(msg, slice) → (next, cmds)`; thread root
  facts through the Msg payload, never read producer-local state in a reducer, and
  push cascades into the reducer (not the handler). See `docs/PRINCIPLES.md` §12.
- **Paint↔hit-test agreement** — clickable chrome geometry must be *shared* by
  paint and hit-test. Paint publishes drawn glyph regions to a per-frame registry
  (`panel/chrome-regions`, `panel/tree-regions`) that the hit-tests read.
- **Docs are prose, tests are blind to it** — after moving a symbol or changing
  layout, grep the old name and fix code comments + living docs (`docs/msg-routes.md`
  is the Msg-route map; `docs/LAYOUT.md` the panel/config reference).
- **No framework name-drops** in docs/code/CHANGELOG (use generic "TEA", not
  specific library names).

## Release & remotes

- **Two remotes:** `origin` = github.com/Tao-Ma/lazytui (public: main + tags),
  `gitea` = internal (all branches/backups). Push to **both**.
- **Cutting a release** (user-declared, not self-initiated): move CHANGELOG
  `[Unreleased]` → the version, bump `package.json`, tag `vX.Y.Z`, push the tag
  → `release.yml` builds the assets and creates the Release. `RELEASING.md` has
  the checklist. Versioning stays on the **0.6.x** line (patch bumps) unless
  declared otherwise.
- **Latest: v0.6.23** (2026-08-20) — the `components:` external-registration hook
  + `lazytui build` compile-to-binary. See `CHANGELOG.md`.
- **What a release ships** (GitHub Release assets): a source tarball, the npm-pack
  `.tgz`, and **native `lazytui` CLI binaries** for `linux-x64`, `linux-arm64`,
  and `darwin-arm64` (cross-compiled in CI with Bun; the matrix lives in
  `release.yml`). node-pty terminals are off in those binaries by design.
- **npm:** **not published** — `npm install lazytui` 404s. The publish step
  auto-skips (no `NPM_TOKEN` secret; deliberate). Install the library via the
  GitHub Release `.tgz` URL, or download a native binary.

## Where the authoritative docs are

- `bin/lazytui --spec` — the consolidated Component authoring bundle (SPEC +
  PRINCIPLES + PLUGINS + PROJECT + HUB + LAYOUT) in one file.
- `docs/PRINCIPLES.md` — the invariants. Read before changing the framework.
- `docs/msg-routes.md` — the living Msg-route + purity map.
- `docs/LAYOUT.md` — panel types, config keys, chrome glyphs, navigation.
- `docs/packaging.md` — compile-to-binary. `CONTRIBUTING.md` — PR flow.
