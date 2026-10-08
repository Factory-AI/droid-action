#!/usr/bin/env bash
# Commit only the two guidelines files, refuse output that carries a
# credential (the distill step read untrusted text), and open the guidelines
# PR or update the open one.
set -euo pipefail

work="$RUNNER_TEMP/review-guidelines"
dir=".factory/skills/review-guidelines"
branch="droid/review-guidelines"

if [ ! -s "$work/pr-body.md" ]; then
  echo "No guidelines update to publish."
  exit 0
fi

for file in SKILL.md pending.md; do
  if [ -f "$dir/$file" ]; then git add -- "$dir/$file"; fi
done
if git diff --cached --quiet; then
  echo "The learned guidelines did not change."
  exit 0
fi

output="$work/publish-check.txt"
{ git diff --cached; cat "$work/pr-body.md"; } > "$output"
if grep -qE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' "$output" \
  || { [ -n "${FACTORY_API_KEY:-}" ] && grep -qF -- "$FACTORY_API_KEY" "$output"; }; then
  echo "::error::The learned guidelines contain a credential, so they were not published."
  exit 1
fi

git checkout -q -B "$branch"
git commit -q -m "Update learned review guidelines"
if [ -f "$work/open-pr" ]; then
  git push -q origin "HEAD:refs/heads/$branch"
else
  # No open PR, so any existing branch is left over from a merged or closed one.
  git push -q --force origin "HEAD:refs/heads/$branch"
fi

pr=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')
if [ -n "$pr" ]; then
  gh pr edit "$pr" --body-file "$work/pr-body.md"
else
  gh pr create --head "$branch" --title "Update learned review guidelines" --body-file "$work/pr-body.md"
fi
