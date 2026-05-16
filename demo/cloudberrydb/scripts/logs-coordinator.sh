#!/usr/bin/env bash
# Tail the coordinator's most recent log inside cbdb-cdw.
set -euo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
docker exec -u gpadmin "$CONTAINER" bash -lc '
  set -e
  LOG_DIR=/data0/database/coordinator/gpseg-1/log
  LATEST=$(ls -t "$LOG_DIR"/*.csv 2>/dev/null | head -1 || true)
  if [ -z "$LATEST" ]; then
    echo "no coordinator log found under $LOG_DIR"
    exit 1
  fi
  echo "==> $LATEST"
  tail -n 80 "$LATEST"
'
