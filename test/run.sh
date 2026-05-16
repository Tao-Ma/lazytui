#!/bin/sh
# Helper for the synthetic TUI test stack. cd's into this dir so all
# relative paths in stack.yml / test.yml resolve regardless of where
# the caller invoked us from.
set -eu

cd "$(dirname "$0")"

cmd=${1:-help}

case "$cmd" in
  up)
    profile=${2:-base}
    if [ "$profile" = "all" ] || [ "$profile" = "chaos" ]; then
      docker compose -f stack.yml --profile chaos up -d
    else
      docker compose -f stack.yml up -d
    fi
    docker compose -f stack.yml ps
    ;;
  down)
    docker compose -f stack.yml --profile chaos down
    ;;
  ps)
    docker compose -f stack.yml ps
    ;;
  tui)
    shift
    exec node ../js/tui.js "$@" test.yml
    ;;
  *)
    cat <<EOF
Usage: $0 <command>

  up [base|all]   bring the stack up (default: base only; 'all' adds chaos)
  down            tear everything down
  ps              show stack status
  tui [flags...]  launch the TUI pointed at test.yml
                  flags forward to node tui.js (e.g. --design)

Once up, fire docker events from another shell to exercise event paths:
  docker kill   tui-test-running
  docker pause  tui-test-running   &&  docker unpause tui-test-running
  docker stop   tui-test-flood
  docker start  tui-test-exited
EOF
    ;;
esac
