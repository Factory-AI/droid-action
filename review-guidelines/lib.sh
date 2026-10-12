#!/usr/bin/env bash
# Shared by the mining and publishing scripts. Requires ACTION_ROOT (the
# droid-action checkout) and Bun on PATH.

# Print a GitHub token for this repository, or nothing when the exchange
# skipped this run (this version of the workflow is not the one on the
# default branch). The token never goes to a step output or $GITHUB_ENV, so
# no later step can read it.
github_token() {
  local tmp
  tmp=$(mktemp -d)
  if ! GITHUB_OUTPUT="$tmp/output" GITHUB_TOKEN_FILE="$tmp/token" \
    bun run "$ACTION_ROOT/src/entrypoints/get-token.ts" >&2; then
    rm -rf "$tmp"
    return 1
  fi
  if [ -s "$tmp/token" ]; then cat "$tmp/token"; fi
  rm -rf "$tmp"
}

# Run git authenticated with $GH_TOKEN for this one command, leaving the
# clone's configuration untouched.
git_with_token() {
  git -c credential.helper= \
    -c credential.helper='!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f' \
    "$@"
}
