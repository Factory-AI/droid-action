#!/usr/bin/env bash
# Source once before any model process. Functions and expected digests remain
# in this parent shell, never in model-writable files or a fresh after_script.
# This detects changed executable content; it is not a same-user OS sandbox.

droid_freeze_runtime() {
  DROID_FROZEN_BUN="$(readlink -f "$(command -v bun)")" || return 1
  DROID_FROZEN_CLI="$(readlink -f "$(command -v droid)")" || return 1
  test -x "$DROID_FROZEN_BUN" && test -x "$DROID_FROZEN_CLI" || return 1
  DROID_FROZEN_DIR="$(mktemp -d /tmp/droid-trusted.XXXXXX)" || return 1
  local entry digest
  local -a sources=()
  for entry in gitlab-prepare gitlab-prepare-validator gitlab-post-review gitlab-collect-debug-artifacts gitlab-update-comment-link; do
    sources+=("$DROID_ACTION_DIR/src/entrypoints/$entry.ts")
  done
  env -u BUN_OPTIONS -u NODE_OPTIONS "$DROID_FROZEN_BUN" --config=/dev/null --env-file=/dev/null build --target=bun --outdir "$DROID_FROZEN_DIR" "${sources[@]}" || return 1
  declare -gA DROID_FROZEN_SHA=()
  for entry in gitlab-prepare gitlab-prepare-validator gitlab-post-review gitlab-collect-debug-artifacts gitlab-update-comment-link; do
    digest="$(/usr/bin/sha256sum -- "$DROID_FROZEN_DIR/$entry.js")" || return 1
    DROID_FROZEN_SHA["$entry"]="${digest%% *}"
  done
  digest="$(/usr/bin/sha256sum -- "$DROID_FROZEN_BUN")" || return 1
  DROID_FROZEN_BUN_SHA="${digest%% *}"
  digest="$(/usr/bin/sha256sum -- "$DROID_FROZEN_CLI")" || return 1
  DROID_FROZEN_CLI_SHA="${digest%% *}"
  readonly DROID_FROZEN_DIR DROID_FROZEN_BUN DROID_FROZEN_CLI DROID_FROZEN_BUN_SHA DROID_FROZEN_CLI_SHA DROID_FROZEN_SHA
}

droid_verify_file() {
  local actual
  actual="$(/usr/bin/sha256sum -- "$1")" || return 1
  if [ "${actual%% *}" != "$2" ]; then
    printf '%s\n' "Droid executable integrity check failed; refusing credentialed execution." >&2
    return 1
  fi
}

droid_verify_cli() {
  droid_verify_file "$DROID_FROZEN_CLI" "$DROID_FROZEN_CLI_SHA"
}

droid_run_trusted() {
  local entry="$1"
  case "$entry" in
    gitlab-prepare|gitlab-prepare-validator|gitlab-post-review|gitlab-collect-debug-artifacts|gitlab-update-comment-link) ;;
    *) printf '%s\n' "Unknown trusted GitLab entrypoint" >&2; return 1 ;;
  esac
  droid_verify_file "$DROID_FROZEN_BUN" "$DROID_FROZEN_BUN_SHA" || return 1
  droid_verify_file "$DROID_FROZEN_DIR/$entry.js" "${DROID_FROZEN_SHA[$entry]}" || return 1
  env -u BUN_OPTIONS -u NODE_OPTIONS "$DROID_FROZEN_BUN" --config=/dev/null --env-file=/dev/null run "$DROID_FROZEN_DIR/$entry.js"
}

droid_finalize() {
  local original_status="$?"
  trap - EXIT
  set +e
  if [ "$original_status" -ne 0 ] || [ -s /tmp/droid-error.txt ]; then export DROID_SUCCESS=false; fi
  export DROID_PASS1_LOG="/tmp/droid-prompts/pass1-output.jsonl"
  export DROID_PASS2_LOG="/tmp/droid-prompts/pass2-output.jsonl"
  if ! droid_run_trusted gitlab-collect-debug-artifacts; then
    printf '%s\n' "Droid debug artifact finalization warning; suppressing artifact upload." >&2
    /bin/rm -rf -- "$CI_PROJECT_DIR/.droid-debug"
  fi
  if ! droid_run_trusted gitlab-update-comment-link; then
    printf '%s\n' "Droid summary finalization warning; original job status preserved." >&2
  fi
  exit "$original_status"
}

droid_install_finalize_trap() {
  trap 'droid_finalize' EXIT
}
