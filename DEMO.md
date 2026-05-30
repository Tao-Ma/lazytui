# Demos — convention

A demo is a self-contained, working lazytui project that lives inside
this repo as a worked example of the README's loop:

> "describe intent in plain language → AI agent produces the project →
> you run it (TUI or CLI)."

Each demo proves a different *shape*. The postgres demo produces the
whole docker stack from scratch because postgres has no canonical
upstream docker setup. The cloudberrydb demo *wraps* upstream's own
sandbox because apache/cloudberry already ships one under `devops/`.
Together they cover the two shapes most adopters will hit. See "Two
demo shapes" below for the picking rule.

## First-time setup

Once per clone of the lazytui repo:

```sh
# Node deps (node-pty + @xterm/headless for embedded terminals,
# js-yaml for config parsing)
npm install --omit=dev
```

## Directory shape

```
demo/<project>/
├── .agent-prompt.md      ← human-authored: intent given to the agent
├── README.md             ← human-authored: what this demo shows
├── run                   ← exec ../../bin/lazytui tui.yml
├── tui.yml               ← agent-produced: the entry-point YAML
├── scripts/              ← agent-produced: shell bodies the actions call
├── Dockerfile            ← agent-produced (Shape A only — see below)
├── docker-compose.yml    ← agent-produced (Shape A only — see below)
└── plugins/              ← optional, agent-produced: custom JS plugins
```

Only the first three files are human-authored. Everything else is
produced by an AI agent reading `.agent-prompt.md` plus the output of
`node js/app/tui.js --spec`. This split is the whole point — visitors can
see which files carry intent (one page, human) and which files are
machinery (everything else, agent).

The `Dockerfile` and `docker-compose.yml` are *only* present for
Shape A demos (produce-from-scratch). Shape B demos (wrap-upstream)
have neither — upstream's docker plumbing is reused as-is. See "Two
demo shapes" below.

## Author contract — what a human writes

A demo author writes exactly three files:

1. **`.agent-prompt.md`** — the brief. Plain-language intent, hard
   constraints, out-of-scope list, and any layout preferences. See
   `demo/postgres/.agent-prompt.md` for the canonical shape.
2. **`README.md`** — one page covering what this demo shows, what it
   requires (Docker, disk, etc.), and `cd demo/<project> && ./run`.
3. **`run`** — a tiny wrapper that calls `bin/lazytui` with this
   demo's `tui.yml`. Three lines. See the existing demos.

Everything else is produced by handing `.agent-prompt.md` and
`node js/app/tui.js --spec` to an AI coding agent and reviewing the diff.

## Why `.agent-prompt.md` is checked in

Three reasons:

1. **The demo documents the loop, not just the destination.** Without
   the prompt, a visitor sees the YAML and assumes a human wrote it
   line-by-line. With it, they see "human wrote one page; agent
   produced the rest." That is the lazytui pitch made concrete on
   disk.
2. **The demo becomes reproducible by another agent.** Hand
   `.agent-prompt.md` + `--spec` to a different model six months
   later; if the regenerated demo is functionally equivalent, the
   contract is sound. If it isn't, the gap reveals a contract weakness.
3. **It's the right place to record assumptions and out-of-scope
   items.** "Use postgres 16, not 17," "no replication in v1," and
   similar decisions belong in the prompt — they're decisions the
   human made for the agent, not deductions the agent invented.

The leading dot in `.agent-prompt.md` signals "metadata about the
demo, not part of the demo's runtime." A visitor who wants to *use*
the demo can ignore it; a visitor who wants to *understand the loop*
will notice the dot and read it.

## Two demo shapes

Demos come in two shapes. Pick the shape *before* writing
`.agent-prompt.md` — it determines what the producing agent writes.

### Shape A — produce from scratch (postgres demo)

The target project has no canonical docker setup. The agent writes
the whole stack: `Dockerfile`, `docker-compose.yml`, `scripts/`,
`tui.yml`.

**Use Shape A when:**

- The target builds from source with standard tooling and the
  canonical way to run it in docker hasn't been formalized.
  Examples: postgres, sqlite, most language runtimes, most libraries.
- You want full control over the action surface and don't mind
  maintaining a Dockerfile that tracks the target's build conventions.

The prompt focuses on: what to build, what to test, what to run,
with hard constraints (versions, configure flags, port assignments).

### Shape B — wrap upstream (cloudberrydb demo)

The target project already ships its own docker infrastructure
(e.g. `devops/sandbox/`, `docker/`, `containers/`). The agent
writes *only* the lazytui surface: `tui.yml` plus thin `scripts/`
wrappers that delegate to upstream's entry points. **No Dockerfile,
no docker-compose.yml in the demo itself.**

**Use Shape B when:**

- The target has an upstream-maintained docker setup. Examples:
  apache/cloudberry (`devops/sandbox/`), any project with a
  `devops/`, `docker/`, `sandbox/`, or `ci/` dir that contains a
  working Dockerfile + compose.
- Visitor cloning upstream once is acceptable (the demo's `README.md`
  documents the clone, and a `setup` action in `tui.yml` automates
  it — see `demo/cloudberrydb/scripts/sandbox-setup.sh`).

The prompt focuses on: which upstream verbs to wrap, what
introspection the lazytui surface should add on top (status, logs,
test, etc.).

### Picking the shape — one minute of checking

**Before writing your prompt, check the target project's repo for a
working docker setup under: `devops/`, `docker/`, `containers/`,
`sandbox/`, `ci/`.** If one exists, your demo is Shape B. If not,
it's Shape A.

This check is one minute of work and saves the producing pass from
reinventing infrastructure that already exists. The cloudberrydb v1
attempt skipped this check, produced a Debian-based Dockerfile that
diverged from upstream in five structural ways, and was thrown away;
the v2 rewrite is Shape B against upstream's actual `devops/sandbox/`.
See `demo/cloudberrydb/POSTMORTEM_v1.md` for the worked example.

## Adding a new demo

1. **Pick the shape** (see above) — check upstream for an existing
   docker setup.
2. `mkdir demo/<project>`
3. Write `.agent-prompt.md` — intent + constraints + out-of-scope.
   State the shape decision explicitly: *"Shape A: produce the
   docker stack from scratch"* or *"Shape B: wrap upstream's
   `devops/...`. Do not write a Dockerfile or docker-compose.yml."*
4. Write `README.md` — one page. For Shape B, document the upstream
   clone command (or include a `setup` action that does it).
5. Drop in a `run` script (copy from an existing demo, edit the
   `tui.yml` reference).
6. Hand `.agent-prompt.md` + `node js/app/tui.js --spec` to an AI agent
   and let it produce `tui.yml`, `scripts/`, and (Shape A only)
   `Dockerfile` + `docker-compose.yml`.
7. Review the diff. Run `./run`. Iterate on the prompt if the agent
   misread the intent — fix it in `.agent-prompt.md`, not in the
   produced artifacts.

The last bullet is load-bearing: when something is wrong, the fix
goes upstream in the prompt. Editing the produced artifacts directly
makes the next regeneration drift, which defeats the loop.

## Boundary with `test/`

`test/` is an integration fixture for framework contributors — a
busybox chaos stack the framework's own panels render against. Demos
are for framework adopters — real projects that show what the
framework can do. Don't conflate them; the audiences and lifetimes
are different.
