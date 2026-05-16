#!/usr/bin/env bash
# Run the postgres regression suite. On failure, surface regression.diffs
# so the user does not have to dig for it. This is the one place the
# prompt explicitly flagged as worth a small wrapper script.

set -uo pipefail

cd /home/postgres/src

if make -s check 2>&1; then
  echo
  echo "ALL TESTS PASSED"
  exit 0
fi
rc=$?

echo
echo "=== make check FAILED (rc=$rc) — regression.diffs follows ==="
find src/test/regress -name regression.diffs -print -exec cat {} \;

exit "$rc"
