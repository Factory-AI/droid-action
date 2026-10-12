#!/usr/bin/env bash
# Collect the review comments authors acted on since the last run. Builds on
# an open guidelines PR so a refresh keeps the edits made there, and resumes
# from the `Mined through` and `Unread backlog` lines of the current file.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

work="$RUNNER_TEMP/review-guidelines"
guidelines=".factory/skills/review-guidelines/SKILL.md"
branch="droid/review-guidelines"

GH_TOKEN=$(github_token)
if [ -z "$GH_TOKEN" ]; then
  echo "No GitHub token for this run, so there is nothing to mine."
  exit 0
fi
export GH_TOKEN

if [ -n "$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')" ]; then
  git_with_token fetch -q origin "$branch"
  git checkout -q -B "$branch" FETCH_HEAD
  touch "$work/open-pr"
fi

args=(--repo "$GITHUB_REPOSITORY" --out "$work/out")
if [ -f "$guidelines" ]; then
  mined=$(sed -n 's/.*Mined through: \([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\).*/\1/p' "$guidelines" | head -n 1)
  if [ -n "$mined" ]; then
    args+=(--since "$(date -u -d "$mined + 1 day" +%F)")
  fi
  for range in $(sed -n 's/.*Unread backlog: \([0-9-]\{10\}\.\.[0-9-]\{10\}\).*/\1/p' "$guidelines"); do
    args+=(--backlog "$range")
  done
fi
if [ "${INCLUDE_BOT_COMMENTS:-true}" = "false" ]; then
  args+=(--humans-only)
fi

python3 "$work/mine.py" "${args[@]}"
