#!/usr/bin/env bash
# Fast subset — the core regression suite only.
# On failure, dump regression.diffs.

set -uo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
SRC=/home/gpadmin/cloudberry

docker exec -u gpadmin "$CONTAINER" bash -lc "
  set -uo pipefail
  cd $SRC/src/test/regress
  if make -s installcheck-good 2>&1; then
    echo
    echo 'ALL TESTS PASSED (installcheck-good subset)'
    exit 0
  fi
  rc=\$?
  echo
  echo '=== installcheck-good FAILED — regression.diffs follows ==='
  [ -f regression.diffs ] && cat regression.diffs
  exit \$rc
"
