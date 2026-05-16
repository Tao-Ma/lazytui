# Demos

Worked examples of the lazytui loop:

> describe intent → agent produces the project → run it (TUI or CLI)

Each demo is a real, working lazytui project for an open-source target.
The human-authored part of every demo is one page; the rest was
produced by an AI agent from that page plus `node js/tui.js --spec`.

See **[../DEMO.md](../DEMO.md)** for the convention (directory shape,
author contract, why `.agent-prompt.md` is checked in).

## Available demos

| Demo | Target | Shape | Status |
|---|---|---|---|
| **[postgres](postgres/)** | PostgreSQL 16 from source | Single container, build → test → psql | Agent-produced artifacts shipped; verified end-to-end on Docker |
| **[cloudberrydb](cloudberrydb/)** | Apache Cloudberry main | Wraps upstream's `devops/sandbox/` — lazytui adds the YAML/CLI verbs on top of upstream's docker. Visitor clones `apache/cloudberry` into `./upstream/` first | Agent-produced artifacts shipped; YAML parses, live build deferred (~30 min cold). See [POSTMORTEM_v1.md](cloudberrydb/POSTMORTEM_v1.md) for the upstream-pivot decision |

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

- **postgres** — that the framework handles the canonical "one
  container, fast cycle, classic build/test/run" case. Most visitors'
  mental model of "a TUI for ops" maps onto this directly.
- **cloudberrydb** — that the *same* framework, with no internal
  changes, handles a multi-process MPP cluster with cluster-aware
  lifecycle actions (init, gpstate, per-segment logs) and a long
  cached build. If the postgres demo is the easy case, this is the
  one that shows the framework still earns its keep at scale.

Together they exercise: every action `type` (`run`, `spawn`,
`background`), the built-in containers and stats panels, embedded
terminals, detail tabs, and the cmdline (`:`) verb plumbing.
