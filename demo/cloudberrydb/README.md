# cloudberrydb demo

A lazytui project that wraps **upstream Apache Cloudberry's** docker
sandbox (`devops/sandbox/`).

## What this demo shows

A different demo shape than postgres: lazytui as the **YAML/CLI
surface** on top of an existing, upstream-maintained docker setup.
The demo itself ships no Dockerfile and no docker-compose.yml —
upstream owns the docker plumbing. Our job is just the action surface
(13 actions across sandbox / cluster / test groups).

This is the right pattern for any project that already has docker
infrastructure: don't reinvent it, wrap it.

## Requirements

- Linux host with Docker installed.
- ~10 GB free disk for upstream's rockylinux-9 image + source +
  cluster data dirs.
- First-run build is ~30 minutes (upstream's full source build).
- Framework deps installed once per repo clone — see
  **[../../DEMO.md](../../DEMO.md)** "First-time setup".

## One-time setup — clone upstream

This demo wraps upstream's `devops/sandbox/`, so you need a local
clone of `github.com/apache/cloudberry`. Two ways:

**From the TUI** — open it and run the `cbdb.sandbox:setup` action:

```sh
cd demo/cloudberrydb
./run                              # then navigate to sandbox:setup
# or headlessly:
./run --exec cbdb.sandbox:setup
```

**Or directly with git:**

```sh
cd demo/cloudberrydb
git clone --recurse-submodules https://github.com/apache/cloudberry.git upstream
```

Either path is fine — the `setup` action is just a wrapper around
the same `git clone` with an idempotency check (re-running on an
existing clone is a no-op). `upstream/` is in this demo dir's
`.gitignore`, so the clone is never committed.

Pin a specific tag if you want stability:

```sh
git -C upstream checkout <tag>
```

For a quick orientation including current state (cloned? container
running?), run the `cbdb:help` action.

## Run

```sh
cd demo/cloudberrydb
./run                              # interactive TUI
./run --list                       # enumerate actions
./run --exec sandbox:up            # headless: bring sandbox up
./run --exec cluster:status        # headless: gpstate -s
./run --exec test:installcheck-good
```

Typical first-time flow:

1. `./run --exec sandbox:up` (or use the TUI's Up action) — ~30 min
   cold, then the cluster is initialized and running.
2. `./run` → focus the `cluster` group → run `status`, `psql`, or any
   of the per-process log tabs.
3. `test:installcheck-good` for a fast smoke; `test:installcheck` for
   the full regression run.

## How this demo was built

The human-authored input is **[.agent-prompt.md](.agent-prompt.md)**.
Every other file in this directory (`tui.yml`, `scripts/`) was
produced by an AI coding agent reading that prompt plus the output
of:

```sh
node ../../js/tui.js --spec
```

See **[../../DEMO.md](../../DEMO.md)** for the convention.

## Live-run notes

The first loop run produced a from-scratch Debian Dockerfile + ad-hoc
compose that diverged from upstream conventions in five separate ways
(wrong base OS, missing submodule clone, wrong configure script,
wrong cluster data paths, wrong env-script name). It was discarded
and the demo restarted against upstream's actual sandbox. Worked
example of when "use upstream's infrastructure" beats "produce from
scratch" — see **[POSTMORTEM_v1.md](POSTMORTEM_v1.md)**.
