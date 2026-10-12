#!/usr/bin/env bash
# Hand the publish job only the files it may publish. Everything in this job
# after the distill step is untrusted (that step could have edited any file,
# including this script), so the publish job validates what arrives.
set -euo pipefail

work="$RUNNER_TEMP/review-guidelines"
dir=".factory/skills/review-guidelines"
result="$RUNNER_TEMP/review-guidelines-result"

rm -rf "$result"
mkdir -p "$result"
if [ ! -s "$work/pr-body.md" ]; then
  echo "none" > "$result/status"
  echo "No guidelines update to publish."
  exit 0
fi

cp "$work/pr-body.md" "$result/pr-body.md"
for file in SKILL.md pending.md; do
  if [ -f "$dir/$file" ]; then cp "$dir/$file" "$result/$file"; fi
done
if [ -f "$work/open-pr" ]; then touch "$result/open-pr"; fi
echo "update" > "$result/status"
