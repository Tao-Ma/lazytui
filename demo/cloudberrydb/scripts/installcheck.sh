#!/usr/bin/env bash
# Run installcheck-world against the running cluster. On failure,
# dump regression.diffs. Same hook shape as the postgres demo's test.sh.

set -uo pipefail

CONTAINER=${CONTAINER:-cbdb-cdw}
SRC=/home/gpadmin/cloudberry

docker exec -u gpadmin "$CONTAINER" bash -lc "
  set -uo pipefail
  cd $SRC
  if make -s installcheck-world 2>&1; then
    echo
    echo 'ALL TESTS PASSED'
    exit 0
  fi
  rc=\$?
  echo
  echo '=== installcheck-world FAILED — regression.diffs follows ==='
  find src/test -name regression.diffs -print -exec cat {} \;
  exit \$rc
"
