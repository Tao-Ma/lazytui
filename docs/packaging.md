# Packaging a lazytui app as a native binary

lazytui is a library: a project builds its app from a YAML config plus, if it
needs a new panel type, its own Components ([PROJECT.md](PROJECT.md),
[PLUGINS.md](PLUGINS.md)). You can compile that whole app — **the framework, the
config, and the Components** — into **one self-contained native executable** with
[Bun](https://bun.sh)'s `--compile`. The result needs **no Node, no Bun, and no
`npm install`** to run: ship one file.

> Bun is a **build-time** tool here. It is not required to *run* the binary, and
> it is not a runtime dependency of lazytui.

## The one command

```sh
lazytui build tui.yml            # → ./tui   (a native binary)
lazytui build tui.yml --out myapp
lazytui build tui.yml --target bun-linux-arm64   # cross-compile
```

`lazytui build` parses the config, generates a small entry that statically
requires lazytui's `run`, each Component in the config's `components:` list, and
the config itself (as embedded JSON), then runs `bun build --compile`. Because
the requires are **static**, the bundler follows them and all three embed into
the binary. `bun` must be on `PATH` at build time (the command says so, clearly,
if it isn't).

Cross-compile targets are Bun's: `bun-linux-x64`, `bun-linux-arm64`,
`bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.

## Or hand-write the entry (the `run()` API)

`lazytui build` is a convenience over a public library entry. If you want full
control, write the entry yourself and compile it:

```js
// app.js
require('lazytui').run({
  config: require('./tui.config.json'),      // pre-parsed config (embedded)
  components: [ require('./components/my-panel') ],  // static → embedded
});
```

```sh
bun build app.js --compile --outfile myapp
```

`run({ config, components })` boots the interactive TUI from an **in-memory
config object** (no file read) and registers the given Components after the
built-ins. Get the resolved config object with lazytui's parser at build time
(`require('lazytui/js/parser').parse('tui.yml')`) and embed it as JSON.

The **`components` arg is authoritative** in this path: `run()` ignores the
config's own `components:` list (those are build-machine paths that don't exist
at runtime — leaving them in would crash a compiled binary on a dynamic
`require`). Pass every Component through the arg, statically required so it
embeds. `run({ projectDir })` overrides the runtime-cwd anchor if you need it.

**Rule that bites you if you skip it:** require lazytui and your Components with
**relative** (or package) specifiers, never absolute paths — Bun treats an
absolute-path require as *external* and won't bundle it. `lazytui build` handles
this for you.

## What runs, and what doesn't (caveats)

- **Path anchoring.** A compiled binary anchors `project_dir` — which drives
  action `script:` cwd and the files-panel base — to the **user's runtime cwd**
  (not the build machine's path baked into the config). Override with
  `run({ projectDir })`.
- **Terminals are off.** `type: terminal` panes need the native `node-pty`
  addon, which `--compile` can't embed. The framework already degrades
  gracefully (the pane shows an "unavailable" note); everything else works.
- **`--spec` is source-only.** The Component authoring spec reads `docs/` from
  disk; those aren't bundled. In a binary `--spec` prints a clear message —
  its audience (Component authors) has the source checkout.
- **The ReDoS-guard worker is not embedded.** User-typed filter/search patterns
  run without the bounded-match worker's cutoff (the worker file is loaded by
  runtime path, which a binary can't resolve). A pathological pattern can hang
  the app — the same exposure as a TUI without the guard. It is self-inflicted
  and local (the user types it into their own app).
- **Session replay of the embedded Components is in-process only.** A binary can
  record a session (`LAZYTUI_REPLAY_LOG`, `:record-save`), and reconstruct it
  live in the same process (`:record-load`). But a **separate** replay process
  (`lazytui --record-print` from a source checkout) cannot rebuild the binary's
  own Component panels — their modules live inside the binary, not on disk, and
  are not written to the WAL. Those panes render blank on a cross-process replay;
  the built-in panels and all Msgs replay normally. (A file-config app has full
  replay parity — its Component modules are on disk for the replay process to
  load.)
- **Size.** Each binary is ~90 MB — it embeds the Bun runtime. That is the trade
  for a zero-dependency executable.

## Distribution

`lazytui build --target ...` for each platform, then attach the binaries to your
release. This mirrors how a native CLI ships: users download the one file for
their platform and run it.

### Prebuilt `lazytui` CLI binaries

lazytui's own GitHub Release also ships a **generic `lazytui` CLI binary** for
the supported platforms — 64-bit Linux (`linux-x64`, `linux-arm64`) and Apple
Silicon macOS (`darwin-arm64`) — as `lazytui-<version>-<platform>`, cross-compiled
in CI. (`lazytui build --target` can still produce any Bun target for your own
app.) Download one and run any config with no Node/Bun:

```sh
./lazytui-<version>-linux-x64 tui.yml
```

These read the config from disk at runtime, so they serve **YAML-only** projects
(built-in panel types, actions, metrics, themes). A project with its own **JS
Components** must embed them — use `lazytui build` above, which bakes the config
and the Components into a self-contained binary.
