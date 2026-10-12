#!/usr/bin/env bash
# Runs in its own job, on a fresh checkout, so nothing the distill step wrote
# can reach it except the result files. Validates them, commits only the two
# guidelines files, and opens the guidelines PR or updates the open one.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

result="$RUNNER_TEMP/review-guidelines-result"
dir=".factory/skills/review-guidelines"
branch="droid/review-guidelines"
max_bytes=$((1024 * 1024))

if [ "$(cat "$result/status" 2>/dev/null || true)" != "update" ]; then
  echo "No guidelines update to publish."
  exit 0
fi

reject() {
  echo "::error::$1 Nothing was published."
  exit 1
}
for path in "$result"/* "$result"/.[!.]*; do
  [ -e "$path" ] || [ -L "$path" ] || continue
  name=$(basename "$path")
  case "$name" in
    status | open-pr | pr-body.md | SKILL.md | pending.md) ;;
    *) reject "The guidelines result has an unexpected file ($name)." ;;
  esac
  if [ -L "$path" ] || [ ! -f "$path" ]; then
    reject "The guidelines result has $name as something other than a regular file."
  fi
  if [ "$(wc -c < "$path")" -gt "$max_bytes" ]; then
    reject "The guidelines result has $name larger than 1 MB."
  fi
done
[ -s "$result/pr-body.md" ] || reject "The guidelines result has no PR description."

published=()
for file in pr-body.md SKILL.md pending.md; do
  if [ -f "$result/$file" ]; then published+=("$result/$file"); fi
done
if grep -qE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' -- "${published[@]}"; then
  reject "The learned guidelines contain a credential."
fi
if [ -n "${FACTORY_API_KEY:-}" ] && grep -qF -- "$FACTORY_API_KEY" "${published[@]}"; then
  reject "The learned guidelines contain a credential."
fi

GH_TOKEN=$(github_token)
if [ -z "$GH_TOKEN" ]; then
  echo "No GitHub token for this run, so the guidelines were not published."
  exit 0
fi
export GH_TOKEN

if [ -f "$result/open-pr" ]; then
  git_with_token fetch -q origin "$branch"
  git checkout -q -B "$branch" FETCH_HEAD
else
  git checkout -q -B "$branch"
fi
mkdir -p "$dir"
for file in SKILL.md pending.md; do
  if [ -f "$result/$file" ]; then
    cp "$result/$file" "$dir/$file"
    git add -- "$dir/$file"
  fi
done
if git diff --cached --quiet; then
  echo "The learned guidelines did not change."
  exit 0
fi

git -c core.hooksPath=/dev/null \
  -c user.name='factory-droid[bot]' \
  -c user.email='138933559+factory-droid[bot]@users.noreply.github.com' \
  commit -q -m "Update learned review guidelines"
if [ -f "$result/open-pr" ]; then
  git_with_token push -q origin "HEAD:refs/heads/$branch"
else
  # No open PR, so any existing branch is left over from a merged or closed one.
  git_with_token push -q --force origin "HEAD:refs/heads/$branch"
fi

pr=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -n "$pr" ]; then
  gh pr edit "$pr" --body-file "$result/pr-body.md"
else
  gh pr create --head "$branch" --title "Update learned review guidelines" --body-file "$result/pr-body.md"
fi
