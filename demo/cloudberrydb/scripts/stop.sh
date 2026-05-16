#!/usr/bin/env bash
# gpstop -af inside cbdb-cdw.
set -euo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstop -af'
echo "cluster stopped"
