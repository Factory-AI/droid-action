#!/usr/bin/env bash
# Droid code review for a GitHub pull request, run outside GitHub Actions.
#
#   github/run-review.sh before     # before the review session
#   github/run-review.sh validate   # after the session, also when it failed
#   github/run-review.sh after      # after validate, also when it failed
#
# This is action.yml's automatic review with its first `droid exec` pass
# replaced by a session the caller runs:
#   before    prepare.ts opens the Droid Review check, marks the PR as being
#             reviewed, checks out the PR head, and writes the context files
#             and the candidates prompt, $RUNNER_TEMP/droid-prompts/droid-prompt.txt.
#             The session follows that prompt with read-only GitHub access and
#             writes $RUNNER_TEMP/droid-prompts/review_candidates.json.
#   validate  runs the validator pass as its own `droid exec`, with no GitHub
#             credential in its environment.
#   after     posts the review and closes the check, or closes it as failed.
#
# Run every part from the same clone of the repository, on the same machine,
# with:
#   GITHUB_REPOSITORY  owner/repo
#   PR_NUMBER          pull request number
#   PR_HEAD_SHA        commit to review; `before` skips if the PR moved on
#   PR_ACTION          pull_request action that started the run (opened,
#                      synchronize, ...), checked against review_auto_triggers
#   GITHUB_TOKEN       for before and after, a token with pull requests and
#                      checks write and contents read. For validate, a
#                      read-only token: its `droid exec` can read this
#                      process's environment, so it must never get the write one.
#   GITHUB_RUN_ID      id of this run, the same in every part
#   FACTORY_API_KEY    required by validate, for the validator pass
# Optional: RUNNER_TEMP (an existing directory; default $TMPDIR or /tmp),
# SESSION_USER (below), GITHUB_RUN_ATTEMPT, GITHUB_ACTOR (default: the PR
# author; ALLOWED_BOTS must list it when it is a bot), and the review settings
# action.yml passes as environment variables (AUTOMATIC_REVIEW,
# AUTOMATIC_SECURITY_REVIEW, REVIEW_DEPTH...), which win over the base
# branch's .factory/review.yaml. When neither sets AUTOMATIC_REVIEW, the review
# runs. validate runs the droid on its PATH.
#
# before exits 78 when there is nothing to review: the PR moved past
# PR_HEAD_SHA, or the review settings skip this event. Skip the session then;
# validate and after do nothing. Any other non-zero exit is a failure, which
# the Droid Review check reports once before has opened it. Run after even
# when before failed or was stopped: it closes a check before left open.
#
# The write token stays inside before and after: neither leaves a copy on
# disk once it exits (after deletes what a stopped before left), and every
# part sets its environment only from an allowlist of plain values in the
# state file before leaves. A session running as the same user could still
# change the code and tools after runs. To keep it out, run before and after
# as root and set SESSION_USER to the user the session and validate run as
# (Linux only):
#   - droid-action, RUNNER_TEMP and every directory above them must be
#     writable by root alone (sticky ones such as /tmp aside) and readable by
#     SESSION_USER;
#   - before hands the clone and $RUNNER_TEMP/droid-prompts over to
#     SESSION_USER after its git work, and copies the droids the prompt uses
#     into that user's ~/.factory/droids;
#   - after runs no git and reads what the session and validate wrote as
#     SESSION_USER; before and after keep their own files in
#     $RUNNER_TEMP/github-review.
# Root then runs only droid-action, bun from its own HOME (when missing,
# installed there from bun's GitHub release after checking its SHA-256), and
# the git, gh, curl and unzip on its PATH.
set -uo pipefail

PART="${1:-}"
case "$PART" in
  before | validate | after) ;;
  *)
    echo "usage: $0 before|validate|after" >&2
    exit 2
    ;;
esac
: "${GITHUB_REPOSITORY:?must be owner/repo}" "${PR_NUMBER:?is required}" \
  "${PR_HEAD_SHA:?is required}" "${PR_ACTION:?is required}" \
  "${GITHUB_TOKEN:?is required}" "${GITHUB_RUN_ID:?is required}"
if [ "$PART" = validate ]; then
  : "${FACTORY_API_KEY:?is required for the validator pass}"
fi
SESSION_USER="${SESSION_USER:-$(id -un)}"
SPLIT_USERS=false
if [ "$SESSION_USER" != "$(id -un)" ]; then SPLIT_USERS=true; fi
if [ "$PART" = validate ] && [ "$SPLIT_USERS" = true ]; then
  echo "Run validate as $SESSION_USER: its droid exec reads the PR's untrusted content." >&2
  exit 2
fi

DROID_ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# install_bun pins the SHA-256 of this version's builds.
BUN_VERSION=1.2.11
export RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
PROMPTS_DIR="$RUNNER_TEMP/droid-prompts"
# Written by before and after only.
STATE_DIR="$RUNNER_TEMP/github-review"
STATE_FILE="$STATE_DIR/state"
# before's WORK_DIR, which it deletes when it exits.
BEFORE_DIR="$STATE_DIR/before"
# validate's error, for after to report on the check.
ERROR_FILE="$PROMPTS_DIR/github-review-error"
WORK_DIR=
REVIEW_OPEN=false
NOTHING_TO_REVIEW=78

export REPO_OWNER="${GITHUB_REPOSITORY%%/*}" REPO_NAME="${GITHUB_REPOSITORY#*/}"
export REVIEW_CANDIDATES_PATH="$PROMPTS_DIR/review_candidates.json"
export REVIEW_VALIDATED_PATH="$PROMPTS_DIR/review_validated.json"
export REVIEW_PRIOR_FINDINGS_PATH="$PROMPTS_DIR/review_prior_findings.json"
export REVIEW_LIFECYCLE_PATH="$STATE_DIR/review_lifecycle.json"
export GITHUB_EVENT_NAME=pull_request
export PATH="$HOME/.bun/bin:$PATH"

# What validate and after need from prepare.ts, as ENV_NAME=output_name. The
# other outputs stay in $WORK_DIR, which is deleted on exit: some hold the token.
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

# Writes to $2 the state from the outputs prepare.ts left in the directory $1.
save_state() {
  local pair
  for pair in $STATE; do
    printf '%s=%s\n' "${pair%%=*}" "$(value "$1/prepare" "${pair#*=}")"
  done >"$2"
  # The effective depth (input or base config); the validator's model follows it.
  printf 'REVIEW_DEPTH=%s\n' "$(value "$1/env" REVIEW_DEPTH)" >>"$2"
}

load_state() {
  local pair name
  for pair in $STATE REVIEW_DEPTH=; do
    name="${pair%%=*}"
    export "$name=$(sed -n "s/^$name=//p" "$1" | tail -n 1)"
  done
}

# Fails unless only root (or this user) can change the directory $1, given as
# a canonical path, and the directories above it, apart from sticky ones such
# as /tmp.
check_owned() {
  local dir owner mode
  dir="$(realpath -e -- "$1")" || return 1
  if [ "$dir" != "$1" ]; then
    echo "Give $1 as $dir, without symbolic links, when SESSION_USER is set." >&2
    return 1
  fi
  while :; do
    read -r owner mode <<<"$(stat -c '%u %a' -- "$dir")"
    if { [ "$owner" != 0 ] && [ "$owner" != "$(id -u)" ]; } ||
      { ((8#$mode & 8#22)) && ! ((8#$mode & 8#1000)); }; then
      echo "Only root may be able to change $dir when SESSION_USER is set." >&2
      return 1
    fi
    [ "$dir" = / ] && return
    dir="$(dirname -- "$dir")"
  done
}

# Runs a command as SESSION_USER, with none of this environment: the session
# user can read the environments of its own processes.
as_session_user() {
  if [ "$SPLIT_USERS" = true ]; then
    env -i PATH="$PATH" runuser -u "$SESSION_USER" -- "$@"
  else
    "$@"
  fi
}

# Loads the state before left. Without one there is nothing to do: before
# skipped the review or failed, and closed any check it had opened. Unless
# after finds $BEFORE_DIR: before was then stopped, perhaps with the check
# open, and after closes it.
load_prepared() {
  local stopped=false
  if [ "$PART" = after ] && [ ! -f "$STATE_FILE" ] && [ -d "$BEFORE_DIR" ]; then
    stopped=true
  elif [ ! -f "$STATE_FILE" ]; then
    echo "No prepared review for this run ($STATE_FILE is missing); nothing to do."
    exit 0
  fi
  if [ "$SPLIT_USERS" = true ]; then
    check_owned "$DROID_ACTION_DIR" && check_owned "$STATE_DIR" || exit 1
  fi
  if [ "$stopped" = true ]; then close_stopped_before; fi
  load_state "$STATE_FILE"
  if [ "$PART" = after ]; then REVIEW_OPEN=true; fi
  if [ "$REVIEW_HEAD_SHA" != "$PR_HEAD_SHA" ]; then
    fail DROID_POST_ERROR_MESSAGE "The prepared review is for $REVIEW_HEAD_SHA, not $PR_HEAD_SHA; nothing was posted."
  fi
}

# Exits after closing the check prepare.ts opened, if it got that far, from
# the outputs it left in $BEFORE_DIR, and deleting them: they hold the token.
close_stopped_before() {
  if [ -f "$BEFORE_DIR/prepare" ]; then
    save_state "$BEFORE_DIR" "$WORK_DIR/state"
    load_state "$WORK_DIR/state"
  fi
  rm -rf "$BEFORE_DIR"
  if [ -z "${REVIEW_HEAD_SHA:-}" ]; then
    echo "before was stopped before it opened a check; nothing to do."
    exit 0
  fi
  REVIEW_OPEN=true
  fail PREPARE_ERROR "Droid was stopped while preparing the review of $REVIEW_HEAD_SHA; nothing was posted."
}

# Makes $1, a new directory only this user can read, the part's WORK_DIR.
use_work_dir() {
  [ -d "$1" ] || exit 1
  WORK_DIR="$1"
  # The entrypoints read their event and report outputs like a workflow step.
  export GITHUB_EVENT_PATH="$WORK_DIR/event.json" GITHUB_ENV="$WORK_DIR/env"
  : >"$GITHUB_ENV"
}

# Runs an entrypoint the way action.yml does, from the current directory but
# with bun reading neither bunfig.toml nor .env from it, with its temporary
# files and outputs in $WORK_DIR. Leading arguments go to env(1), where any
# user can read them in /proc: pass the write token in the environment.
# @actions/core prints ::add-mask:: commands holding the token for the
# Actions runner; nothing reads them here, so they are dropped.
run_entrypoint() {
  local step="$1" file="$2"
  shift 2
  : >"$WORK_DIR/$step"
  env "$@" TMPDIR="$WORK_DIR" GITHUB_OUTPUT="$WORK_DIR/$step" \
    bun --config=/dev/null --env-file=/dev/null run "$DROID_ACTION_DIR/$file" |
    awk '!/^::add-mask::/ { print; fflush() }'
}

# Exits non-zero with $2 as the error the check reports: through the variable
# $1 in before and after, and through $ERROR_FILE in validate, which cannot
# write to the check.
fail() {
  [ -z "$2" ] || echo "$2" >&2
  if [ "$PART" = validate ]; then
    printf '%s\n' "${2:-The validator pass failed.}" >"$ERROR_FILE"
  else
    export "$1=$2"
  fi
  exit 1
}

finish() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$code" -ne "$NOTHING_TO_REVIEW" ] && [ "$REVIEW_OPEN" = true ]; then
    run_entrypoint finalize src/entrypoints/github-review-lifecycle.ts \
      REVIEW_PHASE=finalize DROID_SUCCESS=false ||
      echo "warning: could not close the Droid Review check" >&2
  fi
  rm -rf "$WORK_DIR"
  exit "$code"
}
trap finish EXIT

# Installs bun from its GitHub release without running any script from the
# network, and only a build whose SHA-256 matches the one pinned here.
install_bun() {
  command -v bun >/dev/null 2>&1 && return
  local build sum
  case "$(uname -sm)" in
    "Linux x86_64")
      # As bun's installer does, CPUs without AVX2 get the baseline build.
      if grep -q avx2 /proc/cpuinfo; then
        build=linux-x64 sum=e481258190f8930a915ff52b5a0717b83d8f29dbd188294c9d45e37464dcf9e0
      else
        build=linux-x64-baseline sum=fa854c8daf814d8f8a41a875d14794a52904f2be18d6072450c1b526952d8aa8
      fi
      ;;
    "Linux aarch64")
      build=linux-aarch64 sum=ac863aad053ef69d1d0f60d89ab313c61dccaaa962b2c4d7436c3efdba9595bb
      ;;
    *)
      echo "No bun build is pinned for $(uname -sm); put bun $BUN_VERSION on PATH." >&2
      return 1
      ;;
  esac
  echo "Installing bun $BUN_VERSION ($build)"
  curl --retry 5 --retry-delay 2 -fsSL -o "$WORK_DIR/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$build.zip" &&
    echo "$sum  $WORK_DIR/bun.zip" | sha256sum -c --quiet - &&
    mkdir -p "$HOME/.bun/bin" && unzip -joq "$WORK_DIR/bun.zip" "bun-$build/bun" -d "$HOME/.bun/bin"
}

before() {
  if [ "$SPLIT_USERS" = true ]; then
    check_owned "$DROID_ACTION_DIR" && check_owned "$RUNNER_TEMP" || exit 1
  fi
  # New directories, so nothing another user left in them is written through.
  rm -rf "$STATE_DIR" "$PROMPTS_DIR" &&
    mkdir "$STATE_DIR" "$PROMPTS_DIR" && mkdir -m 700 "$BEFORE_DIR" || exit 1
  use_work_dir "$BEFORE_DIR"
  install_bun && (cd "$DROID_ACTION_DIR" && bun install --frozen-lockfile) || exit 1
  run_entrypoint event src/entrypoints/github-pr-event.ts || exit 1
  local head
  head="$(value "$WORK_DIR/event" head_sha)"
  if [ "$head" != "$PR_HEAD_SHA" ]; then
    echo "PR #$PR_NUMBER is at $head now, not $PR_HEAD_SHA; skipping. Nothing was posted to the pull request."
    exit "$NOTHING_TO_REVIEW"
  fi
  if [ -z "${GITHUB_ACTOR:-}" ]; then
    GITHUB_ACTOR="$(value "$WORK_DIR/event" author)"
    export GITHUB_ACTOR
  fi
  # `git clone --depth 1` fetches only the default branch, and gh pr checkout
  # cannot track a PR branch outside the fetch refspec.
  git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' || exit 1

  OVERRIDE_GITHUB_TOKEN="$GITHUB_TOKEN" run_entrypoint prepare src/entrypoints/prepare.ts \
    REVIEW_CONFIG_JSON= DEFAULT_AUTOMATIC_REVIEW=true
  local status=$?
  save_state "$WORK_DIR" "$WORK_DIR/state"
  load_state "$WORK_DIR/state"
  if [ -n "$REVIEW_HEAD_SHA" ]; then REVIEW_OPEN=true; fi
  if [ "$status" -ne 0 ]; then
    local error
    error="$(value "$WORK_DIR/prepare" prepare_error)"
    fail PREPARE_ERROR "${error:-Preparing the review failed with exit status $status.}"
  fi
  if [ "$(value "$WORK_DIR/prepare" run_code_review)" != true ]; then
    # prepare.ts has already closed the review it skipped.
    echo "No review to run for this event."
    exit "$NOTHING_TO_REVIEW"
  fi
  if [ "$REVIEW_HEAD_SHA" != "$PR_HEAD_SHA" ]; then
    fail PREPARE_ERROR "PR #$PR_NUMBER moved to $REVIEW_HEAD_SHA while Droid prepared the review of $PR_HEAD_SHA."
  fi

  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=candidates
  # The security-reviewer subagent the candidates prompt can ask for, copied
  # into the HOME sh sees as the session user.
  # shellcheck disable=SC2016
  as_session_user sh -c 'mkdir -p "$HOME/.factory/droids" && cp -r "$1/." "$HOME/.factory/droids/"' \
    sh "$DROID_ACTION_DIR/.factory/droids" ||
    fail PREPARE_ERROR "Could not copy the review droids into $SESSION_USER's ~/.factory/droids."
  cp "$PROMPTS_DIR/pr.diff" "$STATE_DIR/" ||
    fail PREPARE_ERROR "Could not keep a copy of the PR diff for posting."
  if [ "$SPLIT_USERS" = true ]; then
    # Git is done, so the session may have the clone and the prompts.
    chown -R "$SESSION_USER:" -- "$PROMPTS_DIR" "$(git rev-parse --show-toplevel)" ||
      fail PREPARE_ERROR "Could not hand the clone and prompts over to $SESSION_USER."
  fi
  mv "$WORK_DIR/state" "$STATE_FILE" || fail PREPARE_ERROR "Could not save the prepared review."
  echo "Ready for the review session: prompt $PROMPTS_DIR/droid-prompt.txt, candidates $REVIEW_CANDIDATES_PATH."
}

validate() {
  use_work_dir "$(mktemp -d)"
  load_prepared
  install_bun || fail DROID_VALIDATOR_ERROR_MESSAGE "Could not install bun."
  run_entrypoint event src/entrypoints/github-pr-event.ts ||
    fail DROID_VALIDATOR_ERROR_MESSAGE "Could not read PR #$PR_NUMBER from GitHub."

  # As in action.yml, the validator gets no effort for the "default" label.
  local effort="$REASONING_EFFORT"
  if [ "$effort" = default ]; then effort=; fi
  run_entrypoint validator-prompt src/entrypoints/prepare-validator.ts REASONING_EFFORT="$effort" ||
    fail DROID_VALIDATOR_ERROR_MESSAGE "$(value "$WORK_DIR/validator-prompt" prepare_error)"
  if [ "$(value "$WORK_DIR/validator-prompt" validator_should_run)" = false ]; then
    fail DROID_VALIDATOR_ERROR_MESSAGE "The review session did not write valid candidates to $REVIEW_CANDIDATES_PATH."
  fi
  # An allowlisted environment, as in action.yml's validator step, so no
  # GitHub credential reaches the validator.
  local -a validator_env=(-i PATH="$PATH" HOME="$HOME" RUNNER_TEMP="$RUNNER_TEMP"
    FACTORY_API_KEY="$FACTORY_API_KEY" DROID_EXEC_RUN_TYPE="$DROID_EXEC_RUN_TYPE"
    FACTORY_DROID_AUTO_UPDATE_ENABLED=false
    INPUT_MAX_TURNS=40 INPUT_PROMPT_FILE="$PROMPTS_DIR/droid-prompt.txt"
    INPUT_DROID_ARGS="$(value "$WORK_DIR/validator-prompt" droid_args)"
    INPUT_MCP_TOOLS="$(value "$WORK_DIR/validator-prompt" mcp_tools)")
  if [ -n "${FACTORY_API_BASE_URL:-}" ]; then
    validator_env+=(FACTORY_API_BASE_URL="$FACTORY_API_BASE_URL")
  fi
  run_entrypoint validator base-action/src/index.ts "${validator_env[@]}" ||
    fail DROID_VALIDATOR_ERROR_MESSAGE "$(value "$WORK_DIR/validator" error_message)"
}

after() {
  use_work_dir "$(mktemp -d)"
  # The session could have planted git config that runs commands, in the
  # clone or a parent directory, and after needs neither.
  export GIT_DIR=/dev/null
  cd "$WORK_DIR" || exit 1
  load_prepared
  # Copies of what the session and validate wrote, read as SESSION_USER: root
  # would follow a link they planted to one of its own files.
  local name
  for name in review_candidates.json review_validated.json; do
    as_session_user cat -- "$PROMPTS_DIR/$name" >"$WORK_DIR/$name" 2>/dev/null ||
      rm -f "$WORK_DIR/$name"
  done
  export REVIEW_CANDIDATES_PATH="$WORK_DIR/review_candidates.json" \
    REVIEW_VALIDATED_PATH="$WORK_DIR/review_validated.json" \
    REVIEW_DIFF_PATH="$STATE_DIR/pr.diff" \
    REVIEW_POST_RESULTS_PATH="$STATE_DIR/review_post_results.json"
  if [ -e "$ERROR_FILE" ] || [ -L "$ERROR_FILE" ]; then
    local error
    error="$(as_session_user head -c 2000 -- "$ERROR_FILE" 2>/dev/null)"
    fail DROID_VALIDATOR_ERROR_MESSAGE "${error:-The validator pass failed.}"
  fi
  run_entrypoint event src/entrypoints/github-pr-event.ts ||
    fail DROID_POST_ERROR_MESSAGE "Could not read PR #$PR_NUMBER from GitHub."
  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=validated
  run_entrypoint lifecycle src/entrypoints/github-review-lifecycle.ts REVIEW_PHASE=posted
  run_entrypoint post src/entrypoints/github-post-review.ts ||
    fail DROID_POST_ERROR_MESSAGE "$(value "$WORK_DIR/post" error_message)"
}

"$PART"
