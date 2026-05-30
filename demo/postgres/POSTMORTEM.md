# Postmortem — first live run of the postgres demo

A worked example of the loop discipline DEMO.md preaches: *when a
problem surfaces from the live artifact, fix it in both the artifact
**and** the prompt that produced it*.

## Timeline

1. Loop ran. Agent (Claude Opus 4.7) consumed `.agent-prompt.md` +
   `node js/app/tui.js --spec`, produced `tui.yml`, `Dockerfile`,
   `docker-compose.yml`, and five shell scripts under `scripts/`.
2. `./run --list` parsed cleanly: 12 actions (7 YAML + 5 from the
   docker plugin's compose-synthesis, with `build` overridden).
3. User ran `docker compose up -d` (auto-generated `Start` action),
   then triggered the `build` action.
4. **Failure**: `bash: /scripts/build.sh: No such file or directory`,
   exit 127.

## Diagnosis

`docker inspect pg` showed the bind mount target was the correct host
path:

```
"Source": "/root/local/lazytui/demo/postgres/scripts",
"Destination": "/scripts",
```

But `docker compose exec pg ls /scripts/` showed an empty directory.
The host had the scripts; the container's mount view did not.

Root cause: **docker-in-docker.** The dev9-env container that ran
`docker compose` was forwarding to the *host's* docker daemon (via
the mounted `/var/run/docker.sock`). Compose's volume paths are
resolved by the daemon, not the calling client. The daemon
interpreted `./scripts` against its own filesystem — where dev9-env's
`/root/local/...` view does not exist. Daemon helpfully auto-created
an empty directory at the bogus path and mounted that.

Inside the container, `/scripts/` was therefore permanently empty
regardless of what the host had.

## The two-layer fix

**Layer 1 — artifact**

`Dockerfile`: `COPY --chown=postgres:postgres scripts /scripts`.
`docker-compose.yml`: drop the `./scripts:/scripts:ro` mount.

The scripts now ship as a layer in the image. No bind mount means no
daemon-vs-client filesystem mismatch. Works on metal AND under DinD.
Trade-off: editing a script requires `docker compose build` to roll
a new image layer — acceptable because the COPY layer is tiny and
cached aggressively.

**Layer 2 — prompt**

`.agent-prompt.md`, new bullet under *Notes for the agent*:

> **Bake action scripts into the image, do not bind-mount them.** Bind
> mounts of host paths break under docker-in-docker setups: the host
> docker daemon and the calling container see different filesystems
> at the same path, so the bind mount target is empty inside the
> container. `COPY scripts /scripts` in the Dockerfile works in both
> DinD and on metal. (Discovered the hard way on the first loop run.)

This is the load-bearing half. The artifact fix only addresses *this*
demo; the prompt fix means the next agent run — including the
cloudberrydb run — picks up the rule automatically rather than
rediscovering it.

## Why this is the canonical example

DEMO.md states the rule:

> When something is wrong, the fix goes upstream in the prompt.
> Editing the produced artifacts directly makes the next regeneration
> drift, which defeats the loop.

The DinD case shows what this looks like when discovery happens
*after* artifacts have already been produced and tested. The rule
doesn't say "only edit the prompt" — it says "edit the prompt
*also*." The artifact fix is necessary to unblock the demo right
now; the prompt fix is necessary to keep the loop coherent over time.

A future visitor wondering "should I edit the artifact or the prompt?"
should answer "yes, both, in that order — artifact to unblock, prompt
to prevent drift."

## Other discoveries from the same run

A second smaller issue surfaced during `psql`: pgstart's idempotency
check trusted `pg_ctl status`, which only verifies the PID in
`postmaster.pid` exists in `/proc`. After a container recreate the
data volume persists, so the stale pid file may point at a recycled
PID that is now some unrelated process. False positive — pgstart
reports "already running," but the server isn't.

Fix (artifact only — too narrow for the prompt): add a `pg_isready`
cross-check after `pg_ctl status` in `scripts/pgstart.sh`. If pg_ctl
says running but pg_isready says no, clear the stale pid and start
fresh.

This one didn't earn a prompt bullet because the lesson is
postgres-specific (postmaster.pid lives in the data dir; data dir is
persisted; container recreate leaves a stale pid). A more general
prompt rule would be over-fitting.

## Implication for the cloudberrydb run

The DinD bullet in `.agent-prompt.md` propagates to the cloudberrydb
demo by copy-paste convention — the same rule will appear in
`demo/cloudberrydb/.agent-prompt.md` under its own *Notes for the
agent* section, and the producing agent will read it before laying
down any compose volumes.

If the cloudberrydb run uncovers a *new* class of issue, the same
two-layer fix pattern applies. This postmortem stays as a worked
example; the new lesson gets its own bullet and (if non-trivial) its
own postmortem.
