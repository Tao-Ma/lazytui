#!/usr/bin/env bash
# Configure + make postgres from source. Installs to /opt/pg.
# Runs inside the pg container (via `docker compose exec`).

set -euo pipefail

cd /home/postgres/src

if [ ! -f GNUmakefile ]; then
  echo "==> configure --prefix=/opt/pg"
  ./configure --prefix=/opt/pg --silent
fi

echo "==> make -j$(nproc)"
make -s -j"$(nproc)"

echo "==> make install"
make -s install

echo
echo "Build complete:"
/opt/pg/bin/postgres --version
