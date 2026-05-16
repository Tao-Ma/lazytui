#!/usr/bin/env bash
# Workflow guide for the cloudberrydb demo. Static text + a brief
# probe of current state at the bottom so a returning visitor sees
# where they are.

set -uo pipefail

cat <<'EOF'
=== cloudberrydb demo — workflow ===

This demo wraps apache/cloudberry's upstream docker sandbox. lazytui
provides the YAML/CLI verbs; upstream owns the Dockerfile + compose +
init script.

ONE-TIME SETUP (per repo clone):
  cbdb.sandbox:setup        Clone apache/cloudberry into ./upstream/.
                            ~3-5 min, requires network to github.com.
                            Idempotent — safe to re-run.

PER SESSION:
  cbdb.sandbox:up           Build image (if not cached) + run container
                            + auto-init cluster via upstream's
                            init_system.sh. ~30-45 min cold,
                            ~1-2 min if image is cached.

  cbdb.cluster:status       Verify cluster up (gpstate -s).
  cbdb.cluster:psql         Interactive session against the coordinator.

TEST:
  cbdb.test:installcheck-good   Fast subset (~2-5 min).
  cbdb.test:installcheck        Full regression (~10-30 min).

DAILY OPS (cluster processes, container stays up):
  cbdb.cluster:stop         gpstop -af.
  cbdb.cluster:start        gpstart -a.
  cbdb.cluster:restart      gpstop -afr.
  cbdb.cluster:logs-*       Per-process log tails (CSV).

TEARDOWN:
  cbdb.sandbox:down         Remove the cbdb-cdw container. Destructive
                            (no host volume — cluster state is lost).
                            Image stays cached for next up.

CONCEPT — sandbox vs cluster:
  sandbox = docker container lifecycle (image, container existence)
  cluster = cloudberry process lifecycle inside the running container

  Stop the cluster: cheap. Tear down the sandbox: expensive
  (loses initialized data dirs).

DIRS:
  upstream/                 apache/cloudberry checkout (gitignored).
  scripts/                  Action wrapper shells.
  tui.yml                   This surface (lazytui config).

DOCS:
  README.md                 This demo's overview.
  POSTMORTEM_v1.md          Why this demo wraps upstream rather than
                            producing its own Dockerfile.
  ../../DEMO.md             lazytui's demo convention.
  ../../../README.md        lazytui itself.

EOF

# State probe — what is and isn't ready.
echo "=== current state ==="

if [ -d upstream/.git ]; then
  echo "  upstream/ cloned    — HEAD $(git -C upstream log -1 --pretty=format:'%h %s' 2>/dev/null | head -c 70)"
else
  echo "  upstream/ MISSING   — run cbdb.sandbox:setup first"
fi

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx cbdb-cdw; then
  echo "  cbdb-cdw running   — try cbdb.cluster:status"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx cbdb-cdw; then
  echo "  cbdb-cdw STOPPED   — docker start cbdb-cdw, or sandbox:down + sandbox:up"
else
  echo "  cbdb-cdw absent    — run cbdb.sandbox:up after setup"
fi
