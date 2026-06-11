# Demos

Worked examples of the lazytui loop:

> describe intent → agent produces the project → run it (TUI or CLI)

Each demo is a real, working lazytui project for an open-source target.
The human-authored part of every demo is one page; the rest was
produced by an AI agent from that page plus `bin/lazytui --spec`.

See **[../DEMO.md](../DEMO.md)** for the convention (directory shape,
author contract, why `.agent-prompt.md` is checked in).

## Available demos

| Demo | Target | Shape | Status |
|---|---|---|---|
| **[postgres](postgres/)** | PostgreSQL 16 from source | Single container, build → test → psql | Agent-produced artifacts shipped; verified end-to-end on Docker |
| **[cloudberrydb](cloudberrydb/)** | Apache Cloudberry main | Wraps upstream's `devops/sandbox/` — lazytui adds the YAML/CLI verbs on top of upstream's docker. Visitor clones `apache/cloudberry` into `./upstream/` first | Agent-produced artifacts shipped; YAML parses, live build deferred (~30 min cold). See [POSTMORTEM_v1.md](cloudberrydb/POSTMORTEM_v1.md) for the upstream-pivot decision |

## Feature showcases

Hand-authored config examples (not loop demos — no OSS target, no
`.agent-prompt.md`). They demonstrate one lazytui capability in the
smallest useful config.

| Showcase | Demonstrates | Run |
|---|---|---|
| **[dual-browser](dual-browser/)** | Multi-instance Components (v0.6.4) — two independent `files` panes (Source/js + Docs/docs) opening into one shared preview; a two-pane file manager à la Midnight Commander / ranger. Repoint the roots for your own project. | `cd demo/dual-browser && ./run` |

## Running a demo

```sh
cd demo/postgres        # or demo/cloudberrydb
./run                   # opens the TUI
./run --list            # enumerate actions
./run --exec build:make # run an action headlessly
```

Each demo's `README.md` covers requirements (Docker, disk, time) and
the specific action surface it exposes.

## What each demo proves

- **postgres** — the **produce-from-scratch** shape (Shape A in
  DEMO.md). Postgres has no canonical upstream docker setup; the demo
  writes the whole stack (Dockerfile, compose, scripts, YAML). Most
  visitors' mental model of "a TUI for ops" maps onto this directly.
- **cloudberrydb** — the **wrap-upstream** shape (Shape B). Apache
  Cloudberry already ships a docker sandbox under `devops/`; the demo
  ships only the lazytui surface (no Dockerfile, no compose) and
  delegates docker plumbing to upstream. The right pattern for any
  target project that already has docker infrastructure.

Together they exercise: every action `type` (`run`, `spawn`,
`background`), the built-in containers and stats panels, embedded
terminals, detail tabs, and the cmdline (`:`) verb plumbing. They
also surface the two different POSTMORTEM shapes (live discovery vs
production-review discovery) the loop discipline produces — see
each demo's `POSTMORTEM*.md`.
