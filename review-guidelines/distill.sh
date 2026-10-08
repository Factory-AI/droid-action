#!/usr/bin/env bash
# Turn the mined comments into guidelines. The comments are untrusted text, so
# Droid runs with file tools only and without the OIDC request credentials
# that could mint a GitHub token.
set -euo pipefail

work="$RUNNER_TEMP/review-guidelines"

if [ ! -s "$work/out/acted_on.jsonl" ]; then
  echo "Mining found no new review comments that authors acted on."
  exit 0
fi

env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL -u GH_TOKEN \
  droid exec --auto low --only-tools Read,Grep,Glob,LS,Create,Edit "/learn-review-guidelines --distill $work"
