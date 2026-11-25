#!/usr/bin/env bash
# Droid code review for a GitHub pull request, run outside GitHub Actions.
#
#   github/run-review.sh before   # before the review session
#   github/run-review.sh after    # after it, also when it failed
#
# This is action.yml's automatic review with its first `droid exec` pass
# replaced by a session the caller runs:
#   before  prepare.ts opens the Droid Review check, marks the PR as being
#           reviewed, checks out the PR head, and writes the context files and
#           the candidates prompt, $RUNNER_TEMP/droid-prompts/droid-prompt.txt.
#           The session follows that prompt with read-only GitHub access and
#           writes $RUNNER_TEMP/droid-prompts/review_candidates.json.
#   after   runs the validator pass as its own `droid exec` without GitHub
#           credentials, then posts the review and closes the check.
#
# Run both parts from a clone of the repository, on the same machine, with:
#   GITHUB_REPOSITORY  owner/repo
#   PR_NUMBER          pull request number
#   PR_HEAD_SHA        commit to review; `before` skips if the PR moved on
#   PR_ACTION          pull_request action that started the run (opened,
#                      synchronize, ...), checked against review_auto_triggers
#   GITHUB_TOKEN       repository token with pull requests and checks write
#                      and contents read; each part may get its own
#   GITHUB_RUN_ID      id of this run, the same in both parts
#   FACTORY_API_KEY    required by `after`, for the validator pass
# Optional: RUNNER_TEMP (default $TMPDIR or /tmp), GITHUB_RUN_ATTEMPT,
# GITHUB_ACTOR (default: the PR author), and the review settings action.yml
# passes as environment variables (REVIEW_DEPTH, AUTOMATIC_SECURITY_REVIEW...).
#
# GITHUB_TOKEN stays inside the two parts: `before` leaves no copy on disk,
# and `after` sets its environment only from an allowlist of plain values in
# the state file `before` leaves. The session still runs as the same user and
# could change the code and tools `after` runs, so this is not a sandbox.
set -uo pipefail

PART="${1:-}"
case "$PART" in
  before | after) ;;
  *)
    echo "usage: $0 before|after" >&2
    exit 2
    ;;
esac
: "${GITHUB_REPOSITORY:?must be owner/repo}" "${PR_NUMBER:?is required}" \
  "${PR_HEAD_SHA:?is required}" "${PR_ACTION:?is required}" \
  "${GITHUB_TOKEN:?is required}" "${GITHUB_RUN_ID:?is required}"
if [ "$PART" = after ]; then
  : "${FACTORY_API_KEY:?is required for the validator pass}"
fi

DROID_ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION=1.2.11
export RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
PROMPTS_DIR="$RUNNER_TEMP/droid-prompts"
STATE_FILE="$PROMPTS_DIR/github-review-state"
WORK_DIR="$(mktemp -d)"
REVIEW_OPEN=false

export REPO_OWNER="${GITHUB_REPOSITORY%%/*}" REPO_NAME="${GITHUB_REPOSITORY#*/}"
export REVIEW_CANDIDATES_PATH="$PROMPTS_DIR/review_candidates.json"
export REVIEW_VALIDATED_PATH="$PROMPTS_DIR/review_validated.json"
# The entrypoints read their event and report outputs like a workflow step.
export GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$WORK_DIR/event.json"
export GITHUB_ENV="$WORK_DIR/env"
: >"$GITHUB_ENV"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# What `after` needs from prepare.ts, as ENV_NAME=output_name. The other
# outputs stay in $WORK_DIR, which is deleted on exit: some hold the token.
STATE="DROID_EXEC_RUN_TYPE=droid_exec_run_type DROID_COMMENT_ID=droid_comment_id
REVIEW_HEAD_SHA=review_head_sha REVIEW_BASE_SHA=review_base_sha
REVIEW_COMMENT_ID=review_comment_id REVIEW_CHECK_ID=review_check_id
REVIEW_STARTED_AT=review_started_at
REVIEW_INCREMENTAL_BASE_SHA=review_incremental_base_sha
REVIEW_REACTION_ID=review_reaction_id REVIEW_REACTION_TARGET=review_reaction_target
REVIEW_REACTION_KIND=review_reaction_kind REVIEW_AUTOMATIC=review_automatic
REVIEW_SECURITY_ONLY=review_security_only REVIEW_CONFIG_JSON=review_config_json
REVIEW_MODEL=review_model REASONING_EFFORT=review_reasoning_effort"

# Prints the last value set for $2 in $1, a GITHUB_OUTPUT or GITHUB_ENV file.
value() {
  awk -v key="$2" '
    delim == "" {
      i = index($0, "<<")
      if (i) { name = substr($0, 1, i - 1); delim = substr($0, i + 2); n = 0; text = "" }
      next
    }
    $0 == delim { if (name == key) found = text; delim = ""; next }
    { text = (n++ ? text "\n" : "") $0 }
    END { printf "%s", found }
  ' "$1"
}

save_state() {
  local pair
  for pair in $STATE; do
    printf '%s=%s\n' "${pair%%=*}" "$(value "$WORK_DIR/prepare" "${pair#*=}")"
  done >"$1"
  # The effective depth (input or base config); the validator's model follows it.
  printf 'REVIEW_DEPTH=%s\n' "$(value "$GITHUB_ENV" REVIEW_DEPTH)" >>"$1"
}

load_state() {
  local pair name
  for pair in $STATE REVIEW_DEPTH=; do
    name="${pair%%=*}"
    export "$name=$(sed -n "s/^$name=//p" "$1" | tail -n 1)"
  done
}

# Runs an entrypoint the way action.yml does: from the repository checkout,
# with bun reading neither bunfig.toml nor .env from it, and with its outputs
# in $WORK_DIR/<step>. Leading arguments go to env(1). @actions/core prints
# ::add-mask:: commands holding the token for the Actions runner; nothing
# reads them here, so they are dropped.
run_entrypoint() {
  local step="$1" file="$2"
  shift 2
  : >"$WORK_DIR/$step"
  env "$@" GITHUB_OUTPUT="$WORK_DIR/$step" \
    bun --config=/dev/null --env-file=/dev/null run "$DROID_ACTION_DIR/$file" |
    awk '!/^::add-mask::/ { print; fflush() }'
}

# Exits non-zero with $2 as the error, in the variable $1, the check reports.
fail() {
  export "$1=$2"
  [ -z "$2" ] || echo "$2" >&2
  exit 1
}

finish() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$REVIEW_OPEN" = true ]; then
    run_entrypoint finalize src/entrypoints/github-review-lifecycle.ts \
      REVIEW_PHASE=finalize DROID_SUCCESS=false ||
      echo "warning: could not close the Droid Review check" >&2
  fi
  rm -rf "$WORK_DIR"
  exit "$code"
}
trap finish EXIT

install_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "Installing bun $BUN_VERSION"
    curl --retry 5 --retry-delay 2 -fsSL https://bun.sh/install |
      bash -s "bun-v$BUN_VERSION" >/dev/null || return 1
  fi
  (cd "$DROID_ACTION_DIR" && bun install --frozen-lockfile)
}

before() {
  install_bun || exit 1
  run_entrypoint event src/entrypoints/github-pr-event.ts || exit 1
  local head
  head="$(value "$WORK_DIR/event" head_sha)"
  if [ "$head" != "$PR_HEAD_SHA" ]; then
    echo "PR #$PR_NUMBER is at $head now, not $PR_HEAD_SHA; skipping. Nothing was posted to the pull request."
    exit 0
  fi
  if [ -z "${GITHUB_ACTOR:-}" ]; then
    GITHUB_ACTOR="$(value "$WORK_DIR/event" author)"
    export GITHUB_ACTOR
  fi
  # `git clone --depth 1` fetches only the default branch, and gh pr checkout
  # cannot track a PR branch outside the fetch refspec.
  git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' || exit 1

  run_entrypoint prepare src/entrypoints/prepare.ts \
    REVIEW_CONFIG_JSON= OVERRIDE_GITHUB_TOKEN="$GITHUB_TOKEN" AUTOMATIC_REVIEW=true
  local status=$?
  save_state "$WORK_DIR/state"
  load_state "$WORK_DIR/state"
  if [ -n "$REVIEW_HEAD_SHA" ]; then REVIEW_OPEN=true; fi
  if [ "$status" -ne 0 ]; then
    fail PREPARE_ERROR "$(value "$WORK_DIR/prepare" prepare_error)"
  fi
  if [ "$(value "$WORK_DIR/prepare" run_code_review)" != true ]; then
    echo "No review to run for this event."
    exit 0
  fi
  if [ "$REVIEW_HEAD_SHA" != "$PR_HEAD_SHA" ]; then
    fail PREPARE_ERROR "PR #$PR_NUMBER moved to $REVIEW_HEAD_SHA while Droid prepared the review of $PR_HEAD_SHA."
  fi

  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=candidates
  # The security-reviewer subagent the candidates prompt can ask for.
  mkdir -p "$HOME/.factory/droids" &&
    cp -r "$DROID_ACTION_DIR/.factory/droids/." "$HOME/.factory/droids/" &&
    mv "$WORK_DIR/state" "$STATE_FILE" || exit 1
  echo "Ready for the review session: prompt $PROMPTS_DIR/droid-prompt.txt, candidates $REVIEW_CANDIDATES_PATH."
}

after() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "No prepared review for this run ($STATE_FILE is missing); nothing to post."
    exit 0
  fi
  load_state "$STATE_FILE"
  if [ "$REVIEW_HEAD_SHA" != "$PR_HEAD_SHA" ]; then
    echo "The prepared review is for $REVIEW_HEAD_SHA, not $PR_HEAD_SHA; nothing was posted." >&2
    exit 1
  fi
  REVIEW_OPEN=true

  install_bun || fail DROID_ERROR_MESSAGE "Could not install bun or droid-action's dependencies."
  if ! command -v droid >/dev/null 2>&1; then
    curl --retry 5 --retry-delay 2 --retry-all-errors -fsSL https://app.factory.ai/cli | sh ||
      fail DROID_ERROR_MESSAGE "Could not install the droid CLI."
  fi
  run_entrypoint event src/entrypoints/github-pr-event.ts || exit 1
  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=validated

  # As in action.yml, the validator gets no effort for the "default" label.
  local effort="$REASONING_EFFORT"
  if [ "$effort" = default ]; then effort=; fi
  run_entrypoint validator-prompt src/entrypoints/prepare-validator.ts REASONING_EFFORT="$effort" ||
    fail PREPARE_ERROR "$(value "$WORK_DIR/validator-prompt" prepare_error)"
  if [ "$(value "$WORK_DIR/validator-prompt" validator_should_run)" = false ]; then
    fail DROID_ERROR_MESSAGE "The review session did not write valid candidates to $REVIEW_CANDIDATES_PATH."
  fi
  run_entrypoint validator base-action/src/index.ts -u GITHUB_TOKEN -u GH_TOKEN \
    FACTORY_DROID_AUTO_UPDATE_ENABLED=false DETAILED_PERMISSION_MESSAGES=1 INPUT_MAX_TURNS=40 \
    INPUT_PROMPT_FILE="$PROMPTS_DIR/droid-prompt.txt" \
    INPUT_DROID_ARGS="$(value "$WORK_DIR/validator-prompt" droid_args)" \
    INPUT_MCP_TOOLS="$(value "$WORK_DIR/validator-prompt" mcp_tools)" ||
    fail DROID_VALIDATOR_ERROR_MESSAGE "$(value "$WORK_DIR/validator" error_message)"

  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=posted
  run_entrypoint post src/entrypoints/github-post-review.ts ||
    fail DROID_POST_ERROR_MESSAGE "$(value "$WORK_DIR/post" error_message)"
}

"$PART"
