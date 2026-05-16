#!/usr/bin/env bash
# gpstart -a inside cbdb-cdw. Idempotent — gpstart returns 0 if up.
set -euo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstart -a'
echo
docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstate -s' | head -40
