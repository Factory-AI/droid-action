#!/usr/bin/env bash
# Droid code review for Bitbucket pull requests (Cloud and Data Center).
#
# CI-agnostic entrypoint: Bitbucket Pipelines, Jenkins, Bamboo, or any CI
# that can run bash. Everything is driven by environment variables; see
# docs/bitbucket-setup.md for the full list.
#
#   FACTORY_API_KEY             Factory API key (required)
#   DROID_BITBUCKET_TOKEN       Bearer token (Cloud access token / DC HTTP access token), or
#   DROID_BITBUCKET_USERNAME +  Basic auth (Cloud API token + Atlassian email,
#   DROID_BITBUCKET_API_TOKEN   or app password + Bitbucket username)
#
# Pull request context comes from Pipelines variables (Cloud), or from
# BITBUCKET_SERVER_URL / BITBUCKET_PROJECT_KEY / BITBUCKET_REPO_SLUG /
# BITBUCKET_PR_ID, DROID_PR_URL, or Jenkins CHANGE_URL (Data Center).
#
# The two `droid exec` passes only read files and write JSON. They run
# without the Bitbucket credentials in their environment and without any
# tool that can post to the pull request; a separate step posts the
# validated findings through the REST API. They do keep `Execute` for
# investigating the code, so treat this job like any CI job that runs
# untrusted code.
set -uo pipefail

DROID_ACTION_DIR="${DROID_ACTION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WORK_DIR="${DROID_WORK_DIR:-${BITBUCKET_CLONE_DIR:-${WORKSPACE:-$PWD}}}"
# Per-run scratch directory: concurrent jobs on one Jenkins/Bamboo agent
# must not share prompts, state, or results. It stays outside the checkout
# so a pull request cannot plant a symlink at one of these paths.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/droid-review.XXXXXX")" || {
  echo "ERROR: could not create a temporary directory" >&2
  exit 1
}
export DROID_PROMPT_FILE="${DROID_PROMPT_FILE:-$RUN_DIR/prompts/droid-prompt.txt}"
PROMPTS_DIR="$(dirname "$DROID_PROMPT_FILE")"
export DROID_STATE_FILE="${DROID_STATE_FILE:-$PROMPTS_DIR/.droid-state.json}"
export DROID_PASS1_LOG="$PROMPTS_DIR/pass1-output.jsonl"
export DROID_PASS2_LOG="$PROMPTS_DIR/pass2-output.jsonl"
ERROR_FILE="${DROID_ERROR_FILE:-$RUN_DIR/droid-error.txt}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

# Overridden paths may be reused across runs: never pick up a previous
# run's state, results, or logs.
mkdir -p "$PROMPTS_DIR"
rm -f "$ERROR_FILE" "$DROID_STATE_FILE" "$DROID_PASS1_LOG" "$DROID_PASS2_LOG" \
  "$PROMPTS_DIR"/review_*.json "$PROMPTS_DIR"/resolved-env.sh

fail() {
  echo "$1" >"$ERROR_FILE"
  echo "ERROR: $1" >&2
  exit 1
}

finish() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ] && [ ! -s "$ERROR_FILE" ]; then
    echo "Droid review exited with status $rc; see the CI log." >"$ERROR_FILE"
  fi
  if [ -s "$ERROR_FILE" ]; then
    export DROID_SUCCESS=false
  else
    export DROID_SUCCESS=true
  fi
  DROID_ERROR_DETAILS="$(cat "$ERROR_FILE" 2>/dev/null || true)"
  export DROID_ERROR_DETAILS
  mkdir -p "$WORK_DIR/.droid-debug/prompts"
  cp -r "$PROMPTS_DIR/." "$WORK_DIR/.droid-debug/prompts/" 2>/dev/null
  cp "$ERROR_FILE" "$WORK_DIR/.droid-debug/" 2>/dev/null
  if [ -f "$DROID_STATE_FILE" ] && command -v bun >/dev/null 2>&1; then
    (cd "$WORK_DIR" && bun run "$DROID_ACTION_DIR/src/entrypoints/bitbucket-update-comment-link.ts")
  fi
  rm -rf "$RUN_DIR"
  exit "$rc"
}
trap finish EXIT

# ---- Setup ----------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required on the CI agent"
command -v curl >/dev/null 2>&1 || fail "curl is required on the CI agent"
if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found; installing bun 1.2.11"
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.11" >/dev/null ||
    fail "bun is required and could not be installed (the installer needs unzip)"
fi
# Reinstall when the dependencies changed since the last install, not only
# when node_modules is missing (a persistent agent keeps an old checkout).
DEPS_STAMP="$DROID_ACTION_DIR/node_modules/.droid-deps-hash"
deps_hash="$(cat "$DROID_ACTION_DIR/package.json" "$DROID_ACTION_DIR/bun.lock" 2>/dev/null | cksum)"
if [ ! -d "$DROID_ACTION_DIR/node_modules" ] || [ "$(cat "$DEPS_STAMP" 2>/dev/null)" != "$deps_hash" ]; then
  (cd "$DROID_ACTION_DIR" && bun install --frozen-lockfile) ||
    fail "bun install failed in $DROID_ACTION_DIR"
  echo "$deps_hash" >"$DEPS_STAMP" 2>/dev/null || true
fi
if ! command -v droid >/dev/null 2>&1; then
  curl --retry 5 --retry-delay 2 --retry-all-errors -fsSL https://app.factory.ai/cli | sh ||
    fail "Droid CLI install failed (needs access to app.factory.ai)"
fi
droid --version

mkdir -p "$HOME/.factory/droids"
if [ -d "$DROID_ACTION_DIR/.factory/droids" ]; then
  cp -r "$DROID_ACTION_DIR/.factory/droids/." "$HOME/.factory/droids/"
fi

if [ -n "${ORG_GUIDELINES_SOURCE:-}" ]; then
  case "$ORG_GUIDELINES_SOURCE" in
    http://* | https://* | *.git | ssh://* | git@* | file://* | /*)
      bash "$DROID_ACTION_DIR/gitlab/install-org-guidelines.sh"
      ;;
    *)
      echo "WARNING: ORG_GUIDELINES_SOURCE must be a file path, an http(s) URL, or a git clone URL;" \
        "skipping org review guidelines." >&2
      ;;
  esac
fi

cd "$WORK_DIR" || fail "cannot cd into $WORK_DIR"

# ---- Prepare --------------------------------------------------------------
bun run "$DROID_ACTION_DIR/src/entrypoints/bitbucket-prepare.ts" ||
  fail "bitbucket-prepare failed; see the CI log for the cause"

if ! grep -q '"shouldRunReview": true' "$DROID_STATE_FILE"; then
  echo "Review skipped; see the prepare output above."
  exit 0
fi

RESOLVED_ENV_SHIM="${DROID_RESOLVED_ENV_FILE:-$PROMPTS_DIR/resolved-env.sh}"
# shellcheck disable=SC1090
[ -f "$RESOLVED_ENV_SHIM" ] && . "$RESOLVED_ENV_SHIM"

run_pass() {
  local tools="$1" log="$2" tag="$3"
  local -a args=(exec -f "$DROID_PROMPT_FILE" --enabled-tools "$tools"
    --output-format stream-json --skip-permissions-unsafe --tag "$tag")
  [ -n "${RESOLVED_MODEL:-}" ] && args+=(--model "$RESOLVED_MODEL")
  [ -n "${RESOLVED_REASONING_EFFORT:-}" ] && args+=(--reasoning-effort "$RESOLVED_REASONING_EFFORT")
  env -u DROID_BITBUCKET_TOKEN -u DROID_BITBUCKET_USERNAME -u DROID_BITBUCKET_API_TOKEN \
    -u BITBUCKET_STEP_OIDC_TOKEN droid "${args[@]}" 2>&1 | tee "$log"
}

# ---- Pass 1: candidates ---------------------------------------------------
run_pass "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Task,Skill,FetchUrl" \
  "$DROID_PASS1_LOG" "${DROID_SESSION_TAG_CANDIDATES:-code-review}" ||
  fail "droid exec pass 1 (candidates) failed"

bun run "$DROID_ACTION_DIR/src/entrypoints/bitbucket-prepare-validator.ts" ||
  fail "bitbucket-prepare-validator failed"

# ---- Pass 2: validator ----------------------------------------------------
run_pass "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Skill" \
  "$DROID_PASS2_LOG" "${DROID_SESSION_TAG_VALIDATOR:-code-review}" ||
  fail "droid exec pass 2 (validator) failed"

# ---- Post the approved findings ------------------------------------------
bun run "$DROID_ACTION_DIR/src/entrypoints/bitbucket-post-review.ts" ||
  fail "bitbucket-post-review failed to post the review"
