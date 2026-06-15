#!/bin/sh

# git-diff-range.sh - Show diff for each commit between start and end
# Usage: ./git-diff-range.sh <start_commit> <end_commit>

usage() {
  echo "Usage: $0 <start_commit> <end_commit> [search_string]"
  echo ""
  echo "Example:"
  echo "  $0 abc1234 def5678"
  echo "  $0 HEAD~5 HEAD bubble"
  exit 1
}

[ $# -lt 2 ] && usage

START=$1
END=$2
SEARCH=$3

# verify commits exist
git rev-parse --verify "$START" >/dev/null 2>&1 || {
  echo "Error: invalid commit '$START'"
  exit 1
}
git rev-parse --verify "$END" >/dev/null 2>&1 || {
  echo "Error: invalid commit '$END'"
  exit 1
}

# get commit list from start to end (oldest to newest)
COMMITS=$(git log --reverse --pretty=format:"%H" "$START"^.."$END")

if [ -z "$COMMITS" ]; then
  echo "No commits found between $START and $END"
  exit 1
fi

TOTAL=$(echo "$COMMITS" | wc -l | tr -d ' ')
INDEX=1

for COMMIT in $COMMITS; do
  SUBJECT=$(git log -1 --pretty=format:"%s" "$COMMIT")
  DATE=$(git log -1 --pretty=format:"%cd" --date=short "$COMMIT")
  AUTHOR=$(git log -1 --pretty=format:"%an" "$COMMIT")
  SHORT=$(git rev-parse --short "$COMMIT")

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[$INDEX/$TOTAL] $SHORT  $DATE  $AUTHOR"
  echo "$SUBJECT"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  DIFF=$(git diff "$COMMIT"^ "$COMMIT")

  # filter by search string if provided
  if [ -n "$SEARCH" ]; then
    echo "$DIFF" | grep -i "$SEARCH" >/dev/null 2>&1 || {
      INDEX=$((INDEX + 1))
      continue
    }
    echo "$DIFF" | grep -i --color=always "$SEARCH"
  else
    echo "$DIFF"
  fi

  INDEX=$((INDEX + 1))

  # pause between commits if more than 1
  if [ "$INDEX" -le "$TOTAL" ]; then
    printf "\nPress Enter for next commit (q to quit)... "
    read INPUT
    [ "$INPUT" = "q" ] && exit 0
  fi
done

echo "\nDone. Showed $TOTAL commits."
