#!/usr/bin/env bash
# gpstop -afr (full restart).
set -euo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstop -afr'
echo
docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstate -s' | head -40
