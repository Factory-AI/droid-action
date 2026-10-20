#!/usr/bin/env bash
# Installs organization-wide review guidelines as a user-level skill.
#
# Reads (all optional; no-op when ORG_GUIDELINES_SOURCE is empty):
#   ORG_GUIDELINES_SOURCE Where the guidelines markdown lives. One of:
#                         - an absolute local file path on the runner
#                           (e.g. a group-level file-type CI/CD variable).
#                           Relative paths are never read as files: the
#                           working directory is the MR checkout.
#                         - an https URL to the raw markdown (http:// is
#                           refused)
#                         - a git source: an https clone URL ending in `.git`,
#                           an ssh:// / git@ URL, or a GitLab project
#                           path ("group/repo") cloned from
#                           $CI_SERVER_HOST with $CI_JOB_TOKEN
#   ORG_GUIDELINES_REF    Git sources only: branch or tag. Empty =
#                         default branch.
#   ORG_GUIDELINES_PATH   Git sources only: guidelines markdown file
#                         inside the repo (default: review-guidelines.md).
#
# Writes ~/.factory/skills/org-review-guidelines/SKILL.md. The user-level
# skills directory is distinct from the project's .factory/skills, so this
# never collides with a repo-level `review-guidelines` skill.
#
# Failures are warnings, not job failures: a broken guidelines source
# should not block code review.
set -u

if [ -z "${ORG_GUIDELINES_SOURCE:-}" ]; then
  exit 0
fi

ORG_GUIDELINES_PATH="${ORG_GUIDELINES_PATH:-review-guidelines.md}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
GUIDELINES_FILE=""

fetch_from_git() {
  local clone_url="$1"
  local carries_token="${2:-}"
  local -a git_config=()
  local -a clone_args=(--depth 1 --quiet)
  if [ -n "$carries_token" ]; then
    # The URL embeds the job token; never follow a redirect to another host.
    git_config=(-c http.followRedirects=false)
  fi
  if [ -n "${ORG_GUIDELINES_REF:-}" ]; then
    clone_args+=(--branch "$ORG_GUIDELINES_REF")
  fi
  # Never echo clone_url: it may embed the job token.
  if ! git ${git_config[@]+"${git_config[@]}"} clone "${clone_args[@]}" "$clone_url" "$WORK_DIR/repo"; then
    echo "WARNING: could not clone org guidelines repo '$ORG_GUIDELINES_SOURCE'" \
      "(ref: '${ORG_GUIDELINES_REF:-default}'); skipping org review guidelines." >&2
    exit 0
  fi
  if [ ! -f "$WORK_DIR/repo/$ORG_GUIDELINES_PATH" ]; then
    echo "WARNING: '$ORG_GUIDELINES_PATH' not found in org guidelines repo" \
      "'$ORG_GUIDELINES_SOURCE'; skipping org review guidelines." >&2
    exit 0
  fi
  GUIDELINES_FILE="$WORK_DIR/repo/$ORG_GUIDELINES_PATH"
}

fetch_from_url() {
  local url="$1"
  local -a curl_args=(--retry 3 --retry-delay 2 -fsS --proto =https)
  local http_code
  # Same-instance URLs (e.g. the /projects/:id/repository/files/.../raw
  # API) authenticate with the job token, and never follow redirects so the
  # token cannot be carried to another host. Other hosts get a plain fetch
  # that may follow https-only redirects.
  case "$url" in
    "https://${CI_SERVER_HOST:-gitlab.com}/"*)
      curl_args+=(--header "JOB-TOKEN: ${CI_JOB_TOKEN:-}")
      ;;
    *)
      curl_args+=(-L --proto-redir =https)
      ;;
  esac
  if ! http_code="$(curl "${curl_args[@]}" -w '%{http_code}' "$url" -o "$WORK_DIR/guidelines.md")" ||
    [ "${http_code#2}" = "$http_code" ]; then
    echo "WARNING: could not fetch org guidelines from '$url'" \
      "(HTTP ${http_code:-error}); skipping org review guidelines." >&2
    exit 0
  fi
  GUIDELINES_FILE="$WORK_DIR/guidelines.md"
}

case "$ORG_GUIDELINES_SOURCE" in
  http://*)
    echo "WARNING: refusing plain-http org guidelines source '$ORG_GUIDELINES_SOURCE';" \
      "use https. Skipping org review guidelines." >&2
    exit 0
    ;;
  https://*.git | ssh://* | git@*)
    fetch_from_git "$ORG_GUIDELINES_SOURCE"
    ;;
  https://*)
    fetch_from_url "$ORG_GUIDELINES_SOURCE"
    ;;
  file://*)
    fetch_from_git "$ORG_GUIDELINES_SOURCE"
    ;;
  /*)
    # Local file already on the runner (e.g. file-type CI/CD variable).
    if [ ! -f "$ORG_GUIDELINES_SOURCE" ]; then
      echo "WARNING: org guidelines file '$ORG_GUIDELINES_SOURCE' does not exist;" \
        "skipping org review guidelines." >&2
      exit 0
    fi
    GUIDELINES_FILE="$ORG_GUIDELINES_SOURCE"
    ;;
  *)
    # A GitLab project path on the current instance; the guidelines repo
    # must allowlist this project for job-token access. Never a relative
    # file: those would resolve inside the MR checkout.
    fetch_from_git "https://gitlab-ci-token:${CI_JOB_TOKEN:-}@${CI_SERVER_HOST:-gitlab.com}/${ORG_GUIDELINES_SOURCE}.git" carries-token
    ;;
esac

SKILL_DIR="$HOME/.factory/skills/org-review-guidelines"
mkdir -p "$SKILL_DIR"

if head -n 1 "$GUIDELINES_FILE" | grep -q '^---[[:space:]]*$'; then
  # File already carries skill frontmatter; install verbatim.
  cp "$GUIDELINES_FILE" "$SKILL_DIR/SKILL.md"
else
  {
    echo "---"
    echo "name: org-review-guidelines"
    echo "description: Organization-wide code review guidelines. Always load and apply these when reviewing code. Project-level review guidelines take precedence on conflicts."
    echo "---"
    cat "$GUIDELINES_FILE"
  } >"$SKILL_DIR/SKILL.md"
fi

echo "Installed org review guidelines from '$ORG_GUIDELINES_SOURCE'" \
  "to $SKILL_DIR/SKILL.md"
