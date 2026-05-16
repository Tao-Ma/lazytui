#!/usr/bin/env bash
# Thin wrapper around upstream's devops/sandbox/run.sh.
# Adds a preflight check so a missing upstream/ produces a clear,
# actionable error instead of a cryptic cd failure.

set -euo pipefail

if [ ! -d upstream/devops/sandbox ]; then
  cat <<'EOF' >&2

ERROR: upstream/ not found.

This demo wraps apache/cloudberry's docker sandbox. Clone upstream first:

  cd demo/cloudberrydb
  git clone --recurse-submodules https://github.com/apache/cloudberry.git upstream

See demo/cloudberrydb/README.md for details.

EOF
  exit 1
fi

cd upstream/devops/sandbox
exec ./run.sh "$@"
