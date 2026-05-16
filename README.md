# lazytui

**A glue framework for the tools around your real work.**

If your real work is a database kernel, a network stack, a compiler, or any
other piece of systems code, you already know the shape of the problem this
project is trying to solve. You spend more time than you would like writing
the **glue** — shell scripts that bring up the local dev environment, CI
hooks that lint and package and deploy, OS-specific incantations that the
team copies between Linux distros and macOS versions, ad-hoc flags that
slowly multiply on every script as the kernel grows another dependency.

The glue is dirty work, and it is essential work. It is also where energy
goes to die. Every OS upgrade, every new dependency, every new flag
eventually breaks something. Debugging a shell script that worked last week
is a tax on the time you wanted to spend on the database itself.

lazytui is a different shape for that glue layer.

## The shape

Two things changed at roughly the same time:

1. **AI coding agents got good enough to write and test the glue.** What
   used to be a hand-rolled `deploy.sh` with a year of accumulated flag
   sediment can now be a short YAML declaration plus an agent-authored
   script body covered by tests the agent also wrote.
2. **lazygit / lazydocker / k9s proved the TUI shape.** A two-column,
   keyboard-first, panel-based dashboard is the right interface for
   "operate on a fleet of named things with a fixed set of verbs." It is
   a much better fit for day-to-day ops than memorizing `--flag` strings.

lazytui takes those two observations and produces a tool in the same niche
as **shell, Perl, go-task, Make** — generic glue between you and your
systems — but with three properties those tools do not have together:

- **You describe intent in plain language. The AI produces the YAML, the
  script bodies, the plugins, and the tests.** You review and run; you
  do not hand-author the glue. The YAML is an artifact you read and
  edit when you need to, not a file you start from a blank page.
- **Every action runs in two modes from one definition: TUI and CLI.**
  No flags to memorize during interactive use (the TUI shows them as
  panel rows). The same action is `--exec group:action [args]` from a CI
  pipeline or from another agent.
- **The framework is generic.** It has no built-in knowledge of Docker,
  Kubernetes, your database, your CI provider, or your OS. All of that
  lives in your YAML and plugins. The renderer cannot leak domain
  knowledge because there is nowhere for it to leak.

The result: the glue layer stops being a swamp of personal shell scripts
that only you can debug. It becomes a small, versioned, AI-maintained
contract that you operate through a TUI and that CI invokes through a CLI.

## The loop

You never start by writing YAML. The loop is:

1. **You describe what you need** to an AI coding agent, in whatever
   words come naturally. *"Wrap our staging deploy and rollback scripts.
   I want to see the last 50 lines of logs in a side panel and a list of
   the live pods. CI should be able to call deploy and rollback
   non-interactively."*
2. **You hand the agent the contract** with `node js/tui.js --spec`.
   That single command dumps every rule the agent needs — schema,
   plugin API, markup rules, hub protocol — into one file.
3. **The agent produces a project**: a YAML config, any script bodies
   it needs, optional JS plugins, and tests. You review the diff like
   any other PR.
4. **You run it.** TUI for interactive ops, CLI (`--exec`) for CI and
   for other agents.

The YAML is small and readable on purpose — when you do need to step
in and edit it by hand, you can. But the default mode is "the agent
maintains it; you maintain the intent."

## What an AI-produced project looks like

Concretely, the artifact the agent produces for the example above might
look like this — short enough to skim, structured enough to extend:

```yaml
# staging.yml — produced by the agent, reviewed by you
project_dir: .

groups:
  staging:
    label: Staging
    actions:
      deploy:
        label: Deploy
        type: spawn
        confirm: "Deploy to staging?"
        script: ./scripts/deploy.sh staging

      rollback:
        label: Rollback
        type: spawn
        confirm: "Rollback staging to previous revision?"
        script: ./scripts/rollback.sh staging

      logs:
        label: Tail logs
        type: run
        tab: true
        script: kubectl logs -n staging --tail=50 deploy/api
```

Interactive — no flags to memorize, the actions are panel rows:

```sh
node js/tui.js staging.yml
```

Same actions, callable from CI or another agent — no render pipeline
loaded, exits with the action's return code:

```sh
node js/tui.js staging.yml --exec staging:deploy
node js/tui.js staging.yml --list                  # enumerate actions
```

When the project outgrows one file, the agent splits it into YAML or
JS plugins against the documented `plugins/api.js` surface. The
framework dogfoods the same API for its own built-in panels, so there
is no privileged path the agent cannot reach.

## Worked demos

Real examples of the loop, checked in under [`demo/`](demo/). Each
demo's human-authored input is a single page (`.agent-prompt.md`);
everything else in the directory was produced by an AI agent from
that page plus `--spec`.

| Demo | Target | Shape |
|---|---|---|
| **[postgres](demo/postgres/)** | PostgreSQL 16 from source | Single container, build → test → psql |
| **[cloudberrydb](demo/cloudberrydb/)** | CloudberryDB main | Multi-segment MPP cluster, build → init → installcheck → psql |

Convention for adding your own demo is in **[DEMO.md](DEMO.md)**.

## What you get out of the box

| Surface | What it does |
|---|---|
| **Two-column layout** | 1–6 left panels, 1–3 right panels, detail panel with tabs. Fixed pattern, YAML-configurable content. |
| **Action types** | `run` (capture output), `spawn` (full-screen interactive), `background` (fire-and-forget). One uniform schema, behavior differentiated by `type`. |
| **Built-in panel types** | `groups`, `actions`, `file-manager`, `history`, `detail`, plus docker container/stats panels. |
| **Embedded terminals** | PTY tabs inside the detail panel. Persistent across group switches. |
| **Event hub** | In-process pub/sub for plugins. Time-series, snapshot, and matrix shapes. Retention scales with subscribers — free if nobody listens. |
| **Decorator slots** | Plugins add glyphs to rows / titles / tabs / footer without touching the renderer. |
| **Cmdline mode** | `:` commands with arg plumbing — `:quit`, `:refresh`, `:help`, plus plugin-registered verbs. |
| **6 themes + design mode** | `--design` flag opens an interactive layout editor. |
| **`--spec` flag** | Prints the consolidated plugin-authoring bundle (every doc an LLM needs to write a plugin correctly) to stdout. Pipe it into an agent as context. |

## Why `--spec` and `--exec` are the load-bearing features

Two flags carry the whole AI-augmented loop.

**`--spec` is how the agent learns the contract.** It prints the
consolidated authoring bundle — SPEC, PRINCIPLES, PLUGINS, PROJECT,
HUB, DECORATORS, LAYOUT — to stdout in one shot. Hand it to your
agent and the agent has every rule it needs to produce a valid
project (schema, plugin API, markup rules, hub protocol, decorator
slots) in a single file. That is what makes "the agent writes the
glue" practical instead of aspirational.

```sh
node js/tui.js --spec > /tmp/lazytui-spec.md
```

**`--exec` is how the agent (or CI) invokes what it produced.** Same
action definition; no render pipeline loaded; exits with the action's
return code. CI calls it. Another agent calls it. You do not need a
second wrapper for "the same thing but headless."

Together they close the loop: the agent reads `--spec`, writes a
project, and then either you operate it interactively (TUI) or
something else operates it programmatically (`--exec`). One contract,
two call sites, no parallel maintenance.

## Status

- **Renderer**: Node.js, zero npm runtime deps except `@xterm/headless`
  and `node-pty` for the embedded PTY tabs.
- **Parser**: Python, validates and resolves the YAML config. Covered by
  pytest under `tests/`.
- **Tests**: 17 JS smoke suites, 6 pytest files, plus a live integration
  harness under `test/`. See [TESTING.md](TESTING.md).

## Read next

- **[SPEC.md](SPEC.md)** — plugin authoring quickstart. Start here if you
  are writing a plugin or briefing an AI agent.
- **[PRINCIPLES.md](PRINCIPLES.md)** — the invariants. "YAML defines,
  TUI renders." Read this before changing either layer.
- **[PROJECT.md](PROJECT.md)** — what a user project looks like on disk
  and how path discovery works.
- **[PLUGINS.md](PLUGINS.md)** — full plugin contract.
- **[LAYOUT.md](LAYOUT.md)** — panel types, navigation, view modes,
  themes.
- **[HUB.md](HUB.md)**, **[DECORATORS.md](DECORATORS.md)**,
  **[CMDMODE.md](CMDMODE.md)**, **[TERMINAL.md](TERMINAL.md)**,
  **[STATS.md](STATS.md)** — subsystem deep dives.

## Run

```sh
# Interactive
node js/tui.js path/to/config.yml

# CLI — single action, exits with action rc
node js/tui.js path/to/config.yml --exec group:action [args...]

# Enumerate
node js/tui.js path/to/config.yml --list [filter]

# Layout editor
node js/tui.js --design path/to/config.yml

# Print the plugin-authoring bundle (feed to an AI agent)
node js/tui.js --spec > spec.md
```
