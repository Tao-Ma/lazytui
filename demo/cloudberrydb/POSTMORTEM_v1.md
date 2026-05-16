# Postmortem — cloudberrydb v1 (upstream-pivot)

Worked example of a different loop-discipline lesson than the
postgres POSTMORTEM. Here the discovery was not a bug in the produced
artifact — it was that **the wrong source of truth was consulted at
production time**. The producing agent worked from its own
internalized Greenplum-era assumptions about how cloudberrydb is
built, instead of reading upstream's actual repo first.

## What happened

**Producing pass 1** (commit `89f7368`, since dropped):

- Author: this session, acting as the producing agent against
  `.agent-prompt.md`.
- Output: 19 files / 648 LOC including a Debian-based Dockerfile,
  an ad-hoc docker-compose.yml, custom `make create-demo-cluster`
  scripts, and a tui.yml.
- `./run --list` parsed cleanly. Build/run was deferred (~30 min
  cold build felt too slow to test in the producing session).

**Review caught the issue before live test:**

The agent had never actually read upstream's repo. Asked to verify
post-hoc, fetching `github.com/apache/cloudberry/devops/sandbox/`
surfaced five structural mismatches:

| Assumption (artifact) | Reality (upstream) |
|---|---|
| Source URL: `cloudberrydb/cloudberrydb` | `apache/cloudberry` (project moved to ASF) |
| Base OS: Debian bookworm, apt | Rocky Linux 9.6, dnf |
| `git clone --depth 1` | `git clone --recurse-submodules` (would have failed at configure) |
| Configure: hand-written flags | `./devops/build/automation/cloudberry/scripts/configure-cloudberry.sh` (upstream wrapper) |
| Cluster data path: `gpdemo/datadirs/...` | `/data0/database/coordinator/gpseg-1` (gpinitsystem layout, not gpdemo) |
| Env script name: guessed `cloudberry-env.sh` | Not used at all — `init_system.sh` runs at container CMD |

In sum: the producing agent had reconstructed cloudberrydb's
build/run flow from prior knowledge of Greenplum, while upstream had
diverged enough to make that reconstruction wrong in nearly every
specific detail.

## The decision

Drop the v1 commit. Rewrite the demo as a **wrapper around upstream's
existing sandbox** (`apache/cloudberry/devops/sandbox/`) rather than
a reinvention of cloudberry's docker plumbing.

Concretely:

- No Dockerfile or docker-compose.yml in our demo.
- Visitor clones upstream into `./upstream/` (README documents the
  exact command, including `--recurse-submodules`).
- Our `sandbox:up` action invokes `upstream/devops/sandbox/run.sh -c main`.
- Our `cluster:*` and `test:*` actions are thin `docker exec`
  wrappers against the container (`cbdb-cdw`) that upstream's
  `run.sh` produces.

The demo's value moves from "reproduce cloudberry's docker setup" to
"add an interactive lazytui surface on top of upstream's docker
setup." That's the more honest design point — and probably the
right pattern for any future demo whose target project already has
upstream docker infrastructure.

## Why "drop" rather than "patch"

The artifact had five structural problems, not one bug. Patching
each would have produced a debian-and-apt-based demo that diverges
from upstream forever (different image, different deps, different
paths) — a maintenance liability with no offsetting value. Starting
from upstream's actual sandbox eliminates that entire class of drift.

In git terms: `git reset --hard HEAD~1` + force-push (with-lease)
to drop `89f7368`. Force-push to main is normally warned against;
in this case the repo is single-author personal and the only commit
in flight was the one being dropped.

## Lessons for the loop

**1. The agent must read the target project's actual repo, not just
the prompt.** For the postgres demo this was trivial because postgres
has no canonical docker setup — the agent had to produce one. For
cloudberrydb, upstream's docker setup *is* the contract; producing
without consulting it is producing against fiction.

**2. The prompt-update from this lesson is generic enough to belong
in DEMO.md, not the cloudberrydb prompt alone:** *"Before producing
artifacts, check whether the target project already has upstream
docker infrastructure under `devops/`, `docker/`, `ci/`, or similar.
If yes, wrap it. If no, produce from scratch."* (Not yet propagated
to DEMO.md — pending; landing this postmortem first.)

**3. "Fix the prompt, not the artifact" cuts here too.** The new
v1 prompt explicitly states "wrap upstream, don't reinvent." If the
next regeneration produces another from-scratch Dockerfile, that's
a prompt-reading failure, not an instruction failure.

## Contrast with the postgres POSTMORTEM

| Demo | Discovery layer | Fix shape |
|---|---|---|
| **postgres** | Live run (build action failed) | Two-layer: artifact (bake scripts in image) + prompt (DinD bullet) |
| **cloudberrydb v1** | Production review (before live run) | Drop + restart: artifact discarded, prompt rewritten to mandate upstream-wrapping |

Different failure modes for the loop, both consistent with the same
underlying discipline: the prompt is the durable record; the artifact
is regenerable; if the artifact is more wrong than right, regenerate.

## Note on live testing

This v2 rewrite has not been live-tested either — `./run --list`
parses cleanly (13 actions across sandbox / cluster / test groups),
but the first `sandbox:up` will be the real verification. Any
discoveries from that run land here as a follow-up section,
mirroring the postgres POSTMORTEM's "Other discoveries" pattern.
