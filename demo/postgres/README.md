# postgres demo

A lazytui project that wraps the PostgreSQL 16 build / test / run
loop in Docker.

## What this demo shows

The single-container case — fast cycle, classic shape. Build postgres
from source, run `make check`, drop into `psql`, tail logs, watch
CPU/MEM. Most visitors' mental model of "a TUI for ops" maps onto
this directly.

## Requirements

- Linux host with Docker installed.
- ~2 GB free disk for the builder image + source + objects.
- First-run build is ~5 minutes; subsequent builds are cached.
- Framework deps installed once per repo clone — see
  **[../../DEMO.md](../../DEMO.md)** "First-time setup".

## Run

```sh
cd demo/postgres
./run                              # interactive TUI
./run --list                       # enumerate actions
./run --exec build:make            # headless: run an action and exit
./run --exec test:check            # headless: run regression suite
```

## How this demo was built

The human-authored input is **[.agent-prompt.md](.agent-prompt.md)**
— a single page describing intent, constraints, and out-of-scope
items. Every other file in this directory was produced by an AI
coding agent reading that prompt plus the output of:

```sh
node ../../js/app/tui.js --spec
```

See **[../../DEMO.md](../../DEMO.md)** for the convention.

## Live-run notes

The first end-to-end exercise of the loop turned up a docker-in-docker
bind-mount issue that required fixing both the artifact (Dockerfile
COPY instead of compose bind mount) and the prompt (a new bullet so
the next regeneration doesn't repeat the mistake). Worked example of
the "fix the prompt, not the artifact" discipline — see
**[POSTMORTEM.md](POSTMORTEM.md)**.
