#!/usr/bin/env bash
# Cluster status — gpstate -s inside cbdb-cdw.
set -euo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "container $CONTAINER not running"
  echo "run sandbox:up first"
  exit 1
fi

docker exec -u gpadmin "$CONTAINER" bash -lc 'gpstate -s'
