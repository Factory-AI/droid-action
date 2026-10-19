#!/usr/bin/env bash
# Droid code review for Azure Repos pull requests (Azure Pipelines).
#
# Called by azure-devops/droid-review.yml after it clones droid-action.
# Runs the same two-pass flow as the GitLab component:
#   prepare -> droid exec (candidates) -> prepare-validator ->
#   droid exec (validator) -> post-review, then always updates the sticky
#   tracking thread with the outcome.
#
# Both `droid exec` passes run with every Azure DevOps credential removed
# from their environment and without any PR-writing tool, so a
# prompt-injected diff cannot write to the PR. They keep `Execute`, so
# treat this job like any other job that runs untrusted code.
#
# Agent requirements: Linux or macOS (x64/arm64) with bash, git, curl;
# unzip too when bun is not preinstalled.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DROID_ACTION_DIR="${DROID_ACTION_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TMP_ROOT="${AGENT_TEMPDIRECTORY:-${TMPDIR:-/tmp}}"
BUN_VERSION="${DROID_BUN_VERSION:-1.2.11}"

export DROID_PROMPT_FILE="${DROID_PROMPT_FILE:-$TMP_ROOT/droid-prompts/droid-prompt.txt}"
PROMPTS_DIR="$(dirname "$DROID_PROMPT_FILE")"
export DROID_STATE_FILE="${DROID_STATE_FILE:-$PROMPTS_DIR/.droid-state.json}"
export DROID_PASS1_LOG="${DROID_PASS1_LOG:-$PROMPTS_DIR/pass1-output.jsonl}"
export DROID_PASS2_LOG="${DROID_PASS2_LOG:-$PROMPTS_DIR/pass2-output.jsonl}"
DEBUG_DIR="${DROID_DEBUG_DIR:-$TMP_ROOT/droid-debug}"
ERROR_FILE="$PROMPTS_DIR/droid-error.txt"

mkdir -p "$PROMPTS_DIR" "$DEBUG_DIR"
rm -f "$ERROR_FILE" "$DROID_STATE_FILE"

is_unexpanded() {
  [[ "$1" =~ ^\$\([^\)]*\)$ ]]
}

log_error() {
  # ##vso logging command: shows the message on the build summary page.
  echo "##vso[task.logissue type=error]$1"
}

fail() {
  echo "$1" >"$ERROR_FILE"
  log_error "$1"
  exit 1
}

finish() {
  local code=$?
  trap - EXIT
  if [ -f "$DROID_STATE_FILE" ] && command -v bun >/dev/null 2>&1; then
    if [ "$code" -ne 0 ] || [ -s "$ERROR_FILE" ]; then
      export DROID_SUCCESS=false
    else
      export DROID_SUCCESS=true
    fi
    DROID_ERROR_DETAILS="$(cat "$ERROR_FILE" 2>/dev/null || true)"
    export DROID_ERROR_DETAILS
    bun run "$DROID_ACTION_DIR/src/entrypoints/azure-devops-update-comment-link.ts" ||
      echo "warning: could not update the tracking thread" >&2
  fi
  cp -r "$PROMPTS_DIR/." "$DEBUG_DIR/" 2>/dev/null || true
  exit "$code"
}
trap finish EXIT

# The review passes never need these; strip them from the model's env.
run_without_tokens() {
  env -u SYSTEM_ACCESSTOKEN -u AZURE_DEVOPS_PAT -u AZURE_DEVOPS_EXT_PAT "$@"
}

# ---- Tooling ---------------------------------------------------------------
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun $BUN_VERSION"
  curl --retry 5 --retry-delay 2 -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION" ||
    fail "Failed to install bun (needs curl, unzip, and access to bun.sh and github.com)"
fi

if [ "${DROID_SKIP_DEPENDENCY_INSTALL:-}" != "true" ]; then
  (cd "$DROID_ACTION_DIR" && bun install --frozen-lockfile) ||
    fail "bun install failed in $DROID_ACTION_DIR"
fi

# ---- Preflight -------------------------------------------------------------
# Both checks run before prepare so a build that cannot review never posts a
# tracking thread on the PR.
case "${SYSTEM_PULLREQUEST_ISFORK:-}" in
  [Tt]rue)
    echo "Skipping Droid review: pull request comes from a fork (Azure Pipelines withholds secrets from fork builds)."
    exit 0
    ;;
esac

if [ "${BUILD_REASON:-}" = "PullRequest" ] &&
  { [ -z "${FACTORY_API_KEY:-}" ] || is_unexpanded "$FACTORY_API_KEY"; }; then
  fail "FACTORY_API_KEY is not set. Add it as a secret variable (e.g. in the droid-review variable group), authorize the pipeline to use the group, and map it in the step's env: FACTORY_API_KEY: \$(FACTORY_API_KEY). Nothing was posted to the pull request."
fi

# The shared installer treats any other bare value as a GitLab project path
# and clones it from gitlab.com, which never makes sense on Azure DevOps.
if [ -n "${ORG_GUIDELINES_SOURCE:-}" ] && ! is_unexpanded "$ORG_GUIDELINES_SOURCE"; then
  case "$ORG_GUIDELINES_SOURCE" in
    http://* | https://* | ssh://* | git@* | file://* | *.git) ;;
    *)
      if [ ! -f "$ORG_GUIDELINES_SOURCE" ]; then
        echo "##vso[task.logissue type=warning]ORG_GUIDELINES_SOURCE '$ORG_GUIDELINES_SOURCE' is not a file on the agent, an http(s) URL, or a git clone URL; skipping org review guidelines."
        unset ORG_GUIDELINES_SOURCE
      fi
      ;;
  esac
elif [ -n "${ORG_GUIDELINES_SOURCE:-}" ]; then
  unset ORG_GUIDELINES_SOURCE
fi

# ---- Prepare ---------------------------------------------------------------
if ! bun run "$DROID_ACTION_DIR/src/entrypoints/azure-devops-prepare.ts"; then
  fail "azure-devops-prepare failed; see the step log for the Azure DevOps API error"
fi

if ! grep -q '"shouldRunReview": true' "$DROID_STATE_FILE"; then
  echo "shouldRunReview=false; skipping droid exec."
  exit 0
fi

# Fallback for builds whose Build.Reason was not visible to the preflight.
if [ -z "${FACTORY_API_KEY:-}" ] || is_unexpanded "$FACTORY_API_KEY"; then
  fail "FACTORY_API_KEY is not set. Add it as a secret variable (e.g. in the droid-review variable group), authorize the pipeline to use the group, and map it in the step's env: FACTORY_API_KEY: \$(FACTORY_API_KEY)."
fi

if ! command -v droid >/dev/null 2>&1; then
  curl --retry 5 --retry-delay 2 --retry-all-errors -fsSL https://app.factory.ai/cli | sh ||
    fail "Failed to install the droid CLI (needs access to app.factory.ai and downloads.factory.ai)"
fi
droid --version

mkdir -p "$HOME/.factory/droids"
if [ -d "$DROID_ACTION_DIR/.factory/droids" ]; then
  cp -r "$DROID_ACTION_DIR/.factory/droids/." "$HOME/.factory/droids/"
fi
bash "$DROID_ACTION_DIR/gitlab/install-org-guidelines.sh" || true

RESOLVED_ENV_SHIM="${DROID_RESOLVED_ENV_FILE:-$PROMPTS_DIR/resolved-env.sh}"
# shellcheck disable=SC1090
[ -f "$RESOLVED_ENV_SHIM" ] && . "$RESOLVED_ENV_SHIM"

run_pass() {
  local tools="$1" log="$2" tag="$3"
  local -a args=(exec -f "$DROID_PROMPT_FILE" --enabled-tools "$tools"
    --output-format stream-json --skip-permissions-unsafe)
  if [ -n "${RESOLVED_MODEL:-}" ]; then args+=(--model "$RESOLVED_MODEL"); fi
  if [ -n "${RESOLVED_REASONING_EFFORT:-}" ]; then
    args+=(--reasoning-effort "$RESOLVED_REASONING_EFFORT")
  fi
  args+=(--tag "$tag")
  echo "Running: droid ${args[*]}"
  run_without_tokens droid "${args[@]}" 2>&1 | tee "$log"
}

# ---- Pass 1: candidates ----------------------------------------------------
run_pass "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Task,Skill,FetchUrl" \
  "$DROID_PASS1_LOG" "${DROID_SESSION_TAG_CANDIDATES:-code-review}" ||
  fail "droid exec pass 1 (candidates) failed"

# ---- Pass 2: validator -----------------------------------------------------
bun run "$DROID_ACTION_DIR/src/entrypoints/azure-devops-prepare-validator.ts" ||
  fail "azure-devops-prepare-validator failed"

run_pass "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Skill" \
  "$DROID_PASS2_LOG" "${DROID_SESSION_TAG_VALIDATOR:-code-review}" ||
  fail "droid exec pass 2 (validator) failed"

# ---- Post findings ---------------------------------------------------------
bun run "$DROID_ACTION_DIR/src/entrypoints/azure-devops-post-review.ts" ||
  fail "azure-devops-post-review failed to post the review"
