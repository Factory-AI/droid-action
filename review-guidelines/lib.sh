#!/usr/bin/env bash
# Shared by the mining and publishing scripts. Requires ACTION_ROOT (the
# droid-action checkout) and Bun on PATH.
#
# Bun runs with --config=/dev/null --env-file=/dev/null so it does not load
# bunfig.toml (preload scripts) or .env files from the repository checkout.

# Print a GitHub token for this repository, or nothing when the exchange
# skipped this run (this version of the workflow is not the one on the
# default branch). The token never goes to a step output or $GITHUB_ENV, so
# no later step can read it.
github_token() {
  local tmp
  tmp=$(mktemp -d)
  # @actions/core refuses to write a step output to a file that does not exist.
  : > "$tmp/output"
  if ! GITHUB_OUTPUT="$tmp/output" GITHUB_TOKEN_FILE="$tmp/token" \
    bun --config=/dev/null --env-file=/dev/null \
      run "$ACTION_ROOT/src/entrypoints/get-token.ts" >&2; then
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

# Revoke the token github_token issued, so it stops working when this step
# ends rather than an hour after issue. A provided github_token belongs to the
# caller and is left alone. Never fails the step.
revoke_github_token() {
  if [ -z "${GH_TOKEN:-}" ] || [ -n "${OVERRIDE_GITHUB_TOKEN:-}" ]; then
    return 0
  fi
  GITHUB_TOKEN="$GH_TOKEN" bun --config=/dev/null --env-file=/dev/null \
    run "$ACTION_ROOT/src/entrypoints/revoke-github-token.ts" >&2 || true
}

# Succeed when any of the given files holds a credential: a GitHub token (also
# in the base64 form of git's http.extraheader), a JWT, a private key, or the
# value of $FACTORY_API_KEY.
contains_credential() {
  if grep -qE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.|eC1hY2Nlc3MtdG9rZW46|-----BEGIN [A-Z ]*PRIVATE KEY-----' -- "$@"; then
    return 0
  fi
  if [ -n "${FACTORY_API_KEY:-}" ] && grep -qF -- "$FACTORY_API_KEY" "$@"; then
    return 0
  fi
  return 1
}
