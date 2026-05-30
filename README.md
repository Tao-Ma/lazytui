# lazytui

> **everybody tui — a glue framework for the tools around your real work;
> AI writes it, you run it as TUI or CLI.**

`MIT License · Node.js · npm runtime deps: node-pty, @xterm/headless, js-yaml`

```
╭─(1)─Containers───────╮╭─(0)─Actions────────────────────────────────╮
│ * pg                 ││ > Build (configure + make)             tab │
╰────────────────1 of 1╯│   Test (make check)                    tab │
╭─(2)─Groups───────────╮│   initdb (one-time)                        │
│ 1 postgres 16    1 ok││   Start postgres server                    │
╰────────────────1 of 1╯│   psql (interactive)              [spawn]  │
                        │   Server log (snapshot)                tab │
                        ╰──────────────────────────────────1 of 7────╯
                        ╭─(o)─Info─[Build]───────────────────────────╮
                        │ Configure and compile postgres 16 from     │
                        │ source inside the pg container. Streams    │
                        │ output to the detail panel. Slow on first  │
                        │ run (~5 min); subsequent rebuilds are      │
                        │ incremental.                               │
                        ╰────────────────────────────────────────────╯
 up/dn select  h/l panel  Enter run  ] tab  : cmd  ? help  q quit
```

## Quickstart

```sh
git clone https://github.com/Tao-Ma/lazytui.git
cd lazytui

# One-time deps: node-pty + @xterm/headless + js-yaml.
npm install --omit=dev

# Try a worked demo. Requires Docker on the host.
cd demo/postgres && ./run
```

See [DEMO.md](DEMO.md) to add your own demo.

## The problem this solves

If your real work is a database kernel, a network stack, a compiler, or
any other piece of systems code, you already know the shape of the
problem. You spend more time than you would like writing the **glue** —
shell scripts that bring up the dev environment, CI hooks that lint and
package, OS-specific incantations that the team copies between Linux
distros and macOS versions, ad-hoc flags that slowly multiply as the
kernel grows another dependency.

The glue is dirty work, and it is essential work. It is also where
energy goes to die. Every OS upgrade, every new dep, every new flag
eventually breaks something. Debugging a shell script that worked last
week is a tax on the time you wanted to spend on the database.

lazytui is a different shape for that glue layer.

## The shape

Two things changed at roughly the same time:

1. **AI coding agents got good enough to write and test the glue.** A
   `deploy.sh` with a year of accumulated flag sediment can now be a
   short YAML declaration plus agent-authored script bodies covered by
   tests the agent also wrote.
2. **lazygit / lazydocker / k9s proved the TUI shape.** A two-column,
   keyboard-first, panel-based dashboard is the right interface for
   "operate on a fleet of named things with a fixed set of verbs."

lazytui sits in the same niche as **shell, Perl, go-task, Make** —
generic glue between you and your systems — but with three properties
those tools do not have together:

- **You describe intent in plain language. The AI produces the YAML,
  the script bodies, the plugins, the tests.** You review and run; you
  do not hand-author the glue. The YAML is an artifact you read and
  edit when you need to, not a file you start from a blank page.
- **Every action runs in two modes from one definition: TUI and CLI.**
  No flags to memorize during interactive use. The same action is
  `--exec group:action [args]` from CI or from another agent.
- **The framework is generic.** It has no built-in knowledge of Docker,
  Kubernetes, your database, your CI provider, or your OS. All of that
  lives in your YAML and plugins. The renderer cannot leak domain
  knowledge because there is nowhere for it to leak.

The result: glue stops being a swamp of personal shell scripts only
you can debug. It becomes a small, versioned, AI-maintained contract
you operate through a TUI and that CI invokes through a CLI.

## The loop

You never start by writing YAML. The loop is:

1. **You describe what you need** to an AI coding agent, in whatever
   words come naturally. *"Wrap our staging deploy and rollback
   scripts. I want logs in a side panel and a list of live pods. CI
   should be able to call deploy and rollback non-interactively."*
2. **You hand the agent the contract** with `bin/lazytui --spec`. That
   single command dumps every rule the agent needs — schema, plugin
   API, markup rules, hub protocol — into one file.
3. **The agent produces a project**: a YAML config, any script bodies,
   optional JS plugins, and tests. You review the diff like any other
   PR.
4. **You run it.** TUI for interactive ops, CLI (`--exec`) for CI and
   for other agents.

The YAML is small and readable on purpose — when you need to step in
and edit it by hand, you can. But the default mode is "the agent
maintains it; you maintain the intent."

## What a real project looks like

Excerpt from [`demo/postgres/tui.yml`](demo/postgres/tui.yml), which an
AI agent produced from [a one-page prompt](demo/postgres/.agent-prompt.md):

```yaml
groups:
  pg:
    label: postgres 16
    compose: docker-compose.yml
    containers:
      - pg
    actions:
      build:
        label: Build (configure + make)
        desc: Configure and compile postgres 16 from source inside the
              pg container...
        type: run
        tab: true
        script: docker compose exec -T pg bash /scripts/build.sh

      psql:
        label: psql (interactive)
        type: spawn
        script: docker compose exec -it pg /opt/pg/bin/psql -U postgres
```

Run it interactively (the TUI you see at the top of this README):

```sh
cd demo/postgres && ./run
```

Or headlessly, with the same definition, exiting with the action's rc:

```sh
./run --exec pg:build
./run --list                   # enumerate every action
```

When the project outgrows one file, the agent splits it into YAML or
JS plugins against [`js/panel/api.js`](js/panel/api.js). The
framework dogfoods that same API for its own built-in panels — there
is no privileged path the agent cannot reach.

## Worked demos

| Demo | Target | Shape | Status |
|---|---|---|---|
| **[postgres](demo/postgres/)** | PostgreSQL 16 from source | Single container, build → test → psql | **Verified end-to-end on Docker.** See [POSTMORTEM.md](demo/postgres/POSTMORTEM.md) for the loop discipline applied to a live discovery (DinD bind-mount). |
| **[cloudberrydb](demo/cloudberrydb/)** | Apache Cloudberry main | Wraps upstream's `devops/sandbox/` — lazytui adds the YAML/CLI surface on top of upstream's docker | **YAML parses; live build not yet verified** (~30 min cold). See [POSTMORTEM_v1.md](demo/cloudberrydb/POSTMORTEM_v1.md) for the upstream-pivot decision. |

The two demos prove the two **shapes** demos can take — produce a
docker stack from scratch, or wrap an upstream project's existing
docker infrastructure. Picking rule and conventions in
[DEMO.md](DEMO.md).

## How is this different from Make / shell / Taskfile?

| | Make / shell scripts | go-task / Taskfile | lazytui |
|---|---|---|---|
| Authoring | You write it | You write YAML | An AI writes both YAML and scripts from your intent |
| Surface | CLI only | CLI only | TUI + CLI from one definition |
| Discoverability | Read the script | `task --list` | Panel of named actions; `:` cmdline; `--list`; `--spec` for agents |
| Maintenance | You debug when it rots | You debug when it rots | Re-run the loop; agent reads `--spec` and produces a fresh version |
| Domain knowledge | In the scripts | In the Taskfile | In your YAML / plugins; the framework knows nothing |

It is fine to keep using Make for tasks you actually enjoy maintaining.
lazytui is for the *other* tasks — the glue layer that already costs
you more than it should.

## `--spec` and `--exec` — the load-bearing flags

Two flags carry the AI-augmented loop.

**`--spec` is how the agent learns the contract.** It prints the
consolidated authoring bundle — SPEC, PRINCIPLES, PLUGINS, PROJECT,
HUB, DECORATORS, LAYOUT — to stdout in one shot. Hand it to your
agent and every rule it needs to produce a valid project is in a
single file.

```sh
bin/lazytui --spec > /tmp/lazytui-spec.md
```

**`--exec` is how the agent (or CI) invokes what it produced.** Same
action definition; no render pipeline loaded; exits with the action's
return code. CI calls it. Another agent calls it. No second wrapper
for "the same thing but headless."

## What you get out of the box

| Surface | What it does |
|---|---|
| Two-column layout | 1–6 left panels, 1–3 right panels, detail panel with tabs. Fixed pattern, YAML-configurable content. |
| Action types | `run` (capture output), `spawn` (full-screen interactive), `background` (fire-and-forget). One uniform schema. |
| Built-in panel types | `groups`, `actions`, `files`, `history`, `detail`, plus docker container / stats panels. |
| Embedded terminals | PTY tabs inside the detail panel. Persistent across group switches. |
| Event hub | In-process pub/sub for plugins. Time-series, snapshot, matrix shapes. Cost scales with subscribers. |
| Decorator slots | Plugins add glyphs to rows / titles / tabs / footer without touching the renderer. |
| Cmdline (`:`) | `:quit`, `:refresh`, `:help`, plus plugin-registered verbs, with positional-arg plumbing. |
| 6 themes + design mode | `--design` flag opens an interactive layout editor. |
| `--spec` flag | Prints the plugin-authoring bundle for AI agents (every rule in one file). |

## Status

- **Renderer + parser**: Node.js. Runtime npm deps: `node-pty` and
  `@xterm/headless` for embedded PTY tabs, `js-yaml` for config parsing.
- **Tests**: JS smoke suites under `js/test/` (29 files), plus a
  live integration harness under `test/`. See [docs/TESTING.md](docs/TESTING.md).
- **Two worked demos** at the time of initial public release; both ship
  with the human-authored intent (`.agent-prompt.md`) checked in so the
  loop is reproducible by another agent.

## Read next

**Using lazytui:**

- [docs/SPEC.md](docs/SPEC.md) — plugin authoring quickstart; brief
  any agent with this.
- [DEMO.md](DEMO.md) — convention for adding your own demo, including
  the two demo shapes and the "fix the prompt, not the artifact" rule.
- [docs/PROJECT.md](docs/PROJECT.md) — what a user project looks like
  on disk and how path discovery works.

**Contributing to lazytui itself:**

- [docs/PRINCIPLES.md](docs/PRINCIPLES.md) — the invariants.
  "YAML defines, TUI renders." Read before changing either layer.
- [docs/PLUGINS.md](docs/PLUGINS.md) — full plugin contract.
- [docs/LAYOUT.md](docs/LAYOUT.md), [docs/HUB.md](docs/HUB.md),
  [docs/DECORATORS.md](docs/DECORATORS.md),
  [docs/CMDMODE.md](docs/CMDMODE.md),
  [docs/TERMINAL.md](docs/TERMINAL.md),
  [docs/STATS.md](docs/STATS.md) — subsystem deep dives.

**History (archived):** [docs/history/](docs/history/) keeps the
round-1 refactor retrospective, the dev9-era resume snapshot, and
the feature backlog. Not load-bearing; useful for context.

## Run

```sh
# Interactive
bin/lazytui path/to/config.yml

# CLI — single action, exits with the action's rc
bin/lazytui path/to/config.yml --exec group:action [args...]

# Enumerate every action
bin/lazytui path/to/config.yml --list [filter]

# Layout editor
bin/lazytui --design path/to/config.yml

# Print the plugin-authoring bundle (feed to an AI agent)
bin/lazytui --spec > spec.md
```
