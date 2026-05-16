#!/usr/bin/env bash
# Initialize the postgres data directory. Idempotent — does nothing if
# the data dir already has a PG_VERSION file.

set -euo pipefail

DATA=/var/lib/postgresql/data

if [ -f "$DATA/PG_VERSION" ]; then
  echo "data dir already initialized at $DATA (PG_VERSION=$(cat "$DATA/PG_VERSION"))"
  exit 0
fi

/opt/pg/bin/initdb -D "$DATA" -E UTF8
echo
echo "initdb complete at $DATA"
