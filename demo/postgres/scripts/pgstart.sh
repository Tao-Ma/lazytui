#!/usr/bin/env bash
# Start the postgres server via pg_ctl. Log → /tmp/pg.log.

set -euo pipefail

DATA=/var/lib/postgresql/data
LOG=/tmp/pg.log

if /opt/pg/bin/pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  # pg_ctl status only confirms the PID in postmaster.pid exists. After
  # a container recreate the data volume persists, but its postmaster.pid
  # may point at a PID that's now some unrelated process in the new
  # container — false positive. Cross-check with a real connection probe.
  if /opt/pg/bin/pg_isready -h localhost -q; then
    echo "postgres already running and accepting connections:"
    /opt/pg/bin/pg_ctl -D "$DATA" status
    exit 0
  fi
  echo "stale postmaster.pid (PID present, server unreachable) — clearing"
  rm -f "$DATA/postmaster.pid"
fi

/opt/pg/bin/pg_ctl -D "$DATA" -l "$LOG" -w start
echo
echo "postgres started; log at $LOG (in container)"
