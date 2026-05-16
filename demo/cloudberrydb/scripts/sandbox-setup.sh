#!/usr/bin/env bash
# One-time clone of apache/cloudberry into ./upstream/. Idempotent —
# does nothing if upstream/ is already a git repo. Run before
# sandbox:up.

set -euo pipefail

if [ -d upstream/.git ]; then
  echo "upstream/ already cloned at $(pwd)/upstream"
  echo "  HEAD: $(git -C upstream log -1 --oneline)"
  echo "  Size: $(du -sh upstream | cut -f1)"
  echo
  echo "To re-clone from scratch: rm -rf upstream && rerun this action."
  exit 0
fi

if [ -e upstream ]; then
  echo "ERROR: upstream/ exists but is not a git repo." >&2
  echo "Remove it manually and rerun: rm -rf upstream" >&2
  exit 1
fi

echo "Cloning apache/cloudberry → ./upstream/"
echo "  Source: https://github.com/apache/cloudberry.git"
echo "  Includes submodules (--recurse-submodules)"
echo "  Expected size: ~1.3 GB"
echo "  Expected time: 3-5 min on a reasonable connection"
echo

git clone --recurse-submodules \
    https://github.com/apache/cloudberry.git upstream

echo
echo "Done."
echo "  HEAD: $(git -C upstream log -1 --oneline)"
echo "  Size: $(du -sh upstream | cut -f1)"
echo
echo "Next step: cbdb.sandbox:up"
