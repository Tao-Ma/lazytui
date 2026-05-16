#!/usr/bin/env bash
# Stop the postgres server via pg_ctl. Fast mode (sends SIGINT, no
# in-flight transaction grace).

set -euo pipefail

DATA=/var/lib/postgresql/data

if ! /opt/pg/bin/pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  echo "postgres not running"
  exit 0
fi

/opt/pg/bin/pg_ctl -D "$DATA" -m fast -w stop
echo "postgres stopped"
