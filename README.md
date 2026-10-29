# Droid Actions for GitHub

This GitHub Action powers the Factory **Droid** app. It watches your pull requests for supported commands and runs a full Droid Exec session to help you ship faster:

- `@droid fill` — turns a bare pull request into a polished description that matches your template or our opinionated fallback.
- `@droid review` — performs an automated code review, surfaces potential bugs, and leaves inline comments directly on the diff.
- `@droid security` — performs an automated security review using STRIDE methodology, identifying vulnerabilities and suggesting fixes.
- `@droid security --full` — performs a full repository security scan and creates a PR with the report.
- `@droid fix` — verifies open findings and publishes focused fixes to an authorized PR branch, or opens a stacked PR.

Everything runs inside GitHub Actions using your Factory API key, so the bot never leaves your repository and operates with the permissions you grant.

## CI Steward

CI Steward runs after configured workflows complete. It waits for all checks on
the commit, summarizes failed job logs, retries flaky or infrastructure
failures, and either commits a focused fix or posts inline suggestions.

Copy `templates/droid-ci-steward.yml` to `.github/workflows/ci-steward.yml` and
replace the workflow names with the checks you want to monitor. Enable direct
fixes with `auto_fix: "true"` only when the workflow has `contents: write`.

Leave `github_token` unset so the action authenticates as the Factory Droid
GitHub App, and keep `id-token: write` in the permissions block. This matters
more here than elsewhere: GitHub does not start a new workflow run for a push
made with `secrets.GITHUB_TOKEN`, so an auto-fix commit would land under stale
failing checks and never be verified. Reading job logs and rerunning jobs
always use the workflow token, which is why `actions: write` is also required.

The optional `.github/droid-ci.yml` file can configure `retry`, `fix`,
`workflows.exclude`, `skip`, `instructions`, and the lifetime
`max_runs_per_pr` budget. It is always read from the repository's **default
branch**, never from the pull request, so a branch cannot grant itself
auto-fix or clear its own protected paths. The budgets have distinct scopes:

- `max_retries` limits reruns of one failed job for one commit.
- `max_fix_attempts` limits consecutive fix commits from CI Steward.
- `max_runs_per_pr` limits all CI Steward invocations over the PR lifetime.

### Trust boundary

**CI Steward does not run on pull requests from forks.** `workflow_run` executes
in the base repository with write-scoped tokens and access to secrets, so
checking out a fork's commit and running commands against it would hand the
pull request author the app token, the workflow token, and your Factory API
key. The template enforces this with a job-level condition, and the action
re-checks it in case CI Steward is wired into a hand-written workflow.

Two further limits follow from the same reasoning:

- The shell and file-writing tools are granted only when `fix.enabled` is on.
  A diagnosis-only run cannot modify the working tree.
- `fix.protected_paths` is enforced after the run, not merely requested in the
  prompt. Changes to a protected path are reverted and the job fails.
- `fix.scope` decides which failures may be fixed, and is enforced by
  withholding the editing tools rather than by asking. The failing jobs for the
  commit are classified before Droid starts, and if none of them fall inside
  the scope the run is diagnosis-only. A commit whose only failure is
  `deploy-staging` therefore cannot be modified under the default scope, even
  with `auto_fix` on. Job names are matched by category, so `unit`, `tsc` and
  `eslint` are recognized as `tests`, `types` and `lint`; an unrecognized name
  stays out of scope, and the reason is printed in the job log.

## What Happens When You Tag `@droid`

1. **Trigger detection** – The action scans issue comments, PR descriptions, and review comments for `@droid` commands.
2. **Context gathering** – Droid collects the PR metadata, existing comments, changed files, and any PR description template in your repository.
3. **Prompt generation** – We compose a precise prompt instructing Droid what to do and which GitHub MCP tools it may use.
4. **Execution** – The action runs `droid exec` with full repository context. MCP tools are pre-registered so Droid can call the GitHub APIs safely.
5. **Results** – For fill, Droid updates the PR body. For review/security, it posts inline feedback and a summary comment.

## Installation

### Quick Setup with `/install-code-review` (Recommended)

The fastest way to get up and running is the guided installer built into the Droid CLI. From any local clone of your repo, run:

```bash
droid
> /install-code-review
```

The guided flow will:

- Detect whether your repository lives on GitHub, GitLab, or Bitbucket.
- Help you install the Droid GitHub App (or configure GitLab access).
- Generate the workflow files (`droid.yml` and `droid-review.yml`) with sensible defaults.
- Prompt you for `review_depth`, security review options, and other inputs.
- Recommend security review for new GitHub setups, while retaining an explicit opt-out.
- Open a PR/MR containing the new workflow files for you to review and merge.

For GitHub-only setups you can also run `/install-github-app`. See the [Automated Code Review guide](https://docs.factory.ai/guides/droid-exec/code-review) and the [GitHub App installation guide](https://docs.factory.ai/cli/features/install-github-app) for full details.

### GitLab

GitLab support ships as a **GitLab CI/CD Component** that delivers automated code review — inline MR comments on every merge request, with optional security review.

Two files in your project:

`factory/droid-review.yml`:

```yaml
include:
  - project: "factory-components/droid-action"
    ref: main
    file: "/templates/droid-review.yml"
    inputs:
      automatic_review: "true"
      automatic_security_review: "false"
      review_depth: "deep"

droid-review:
  variables:
    FACTORY_API_KEY: $FACTORY_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
```

`.gitlab-ci.yml` (one include line, append to existing if present):

```yaml
include:
  - local: "factory/droid-review.yml"
```

Full setup, available inputs, and troubleshooting live in [`docs/gitlab-setup.md`](docs/gitlab-setup.md).

### Bitbucket

Bitbucket Cloud and Bitbucket Data Center get the same automated review: inline PR comments, a sticky tracking comment, optional security review, and review depth presets. One CI-agnostic script, [`bitbucket/droid-review.sh`](bitbucket/droid-review.sh), runs the review from Bitbucket Pipelines (Cloud), Jenkins, or Bamboo (Data Center).

Bitbucket Cloud `bitbucket-pipelines.yml` (secured variables `FACTORY_API_KEY` and `DROID_BITBUCKET_TOKEN`):

```yaml
pipelines:
  pull-requests:
    "**":
      - step:
          name: Droid code review
          image: oven/bun:1.2.11
          script:
            - apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates curl
            - git clone --depth 1 --branch "${DROID_ACTION_REF:-main}" https://github.com/Factory-AI/droid-action.git /tmp/droid-action
            - bash /tmp/droid-action/bitbucket/droid-review.sh
```

Workspace-wide rollout, Data Center CI examples, enforcement, and troubleshooting live in [`docs/bitbucket-setup.md`](docs/bitbucket-setup.md).

### Azure DevOps

Azure Repos pull requests (Azure DevOps Services and Azure DevOps Server 2020+) are reviewed by an Azure Pipelines job run from a Build validation branch policy. Copy [`azure-devops/droid-review.yml`](azure-devops/droid-review.yml) into your repository and follow [`docs/azure-devops-setup.md`](docs/azure-devops-setup.md).

### Manual Setup

If you prefer to wire things up by hand:

1. **Install the Droid GitHub App**
   - Install from the Factory dashboard and grant it access to the repositories where you want Droid to operate.
2. **Create a Factory API Key**
   - Generate a token at [https://app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) and save it as `FACTORY_API_KEY` in your repository or organization secrets.
3. **Add the Action Workflows**
   - Create two workflow files under `.github/workflows/` to separate on-demand tagging from automatic PR reviews, based on your needs.

### Setup

`droid.yml` (responds to explicit `@droid` mentions):

```yaml
name: Droid Tag

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]
  pull_request:
    types: [opened, edited]

jobs:
  droid:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@droid')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@droid')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@droid')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@droid') || contains(github.event.issue.title, '@droid'))) ||
      (github.event_name == 'pull_request' && (contains(github.event.pull_request.body, '@droid') || contains(github.event.pull_request.title, '@droid')))
    runs-on: ubuntu-latest
    permissions:
      contents: write # needed for @droid fix; use read with fix_mode: off
      pull-requests: write
      issues: write
      id-token: write
      actions: read
      checks: write # caller token publishes the Droid Review check
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run Droid Exec
        uses: Factory-AI/droid-action@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
```

Once committed, tagging `@droid fill`, `@droid review`, or `@droid security` on an open PR will trigger the bot automatically.

`droid-review.yml` (automatic reviews on PRs):

```yaml
name: Droid Auto Review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  droid-review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
      checks: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run Droid Auto Review
        uses: Factory-AI/droid-action@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          automatic_review: true
          automatic_security_review: true
          allowed_bots: factory-droid
```

Set `automatic_review: true` to run code reviews automatically on non-draft PRs. Set `automatic_security_review: true` to additionally run a STRIDE-based security review concurrently on every non-draft PR.
The example allows reviews triggered by `factory-droid[bot]`. `allowed_bots` checks the event actor, not the PR author, so PRs opened by other bots can also be reviewed when a human triggers the workflow.

On GitHub, omitting `automatic_security_review` (or leaving it empty) follows `automatic_review`. Existing workflows with `automatic_review: true` therefore also run security review unless they explicitly set `automatic_security_review: false`. New GitHub setup tooling writes your choice explicitly. Workflows that omit both inputs remain mention-driven, and explicit `@droid security` commands remain available.

Both examples set `persist-credentials: false` so the workflow's `GITHUB_TOKEN` is not left in `.git/config`, where any command Droid runs could read it. The action authenticates its own git commands through `gh`.

Pull requests from forks are reviewed without checking out their code. The action fetches the fork's commits to a separate ref and reviews the diff, so files from the fork, such as `.factory` hooks and MCP servers, `bunfig.toml` and `.env`, are never loaded in a job that holds your secrets. Droid is told it is reviewing a fork and reads the fork's files from that ref.

## Using the Commands

| Command                                       | Behavior                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `@droid help`                                 | Show commands and effective review settings.                                     |
| `@droid review`                               | Review changes since the last successful review, full review on first use.       |
| `@droid review --full`                        | Review the full diff, bypassing identical-diff skips.                            |
| `@droid review <focus text>`                  | Focus on the requested behavior or area.                                         |
| `@droid security`, `@droid review security`   | Run a security-focused review.                                                   |
| `@droid security --full`                      | Run a full repository security audit and create a report PR/MR.                  |
| `@droid fix`                                  | In a Droid finding thread, fix that finding; at PR level, fix all open findings. |
| `@droid resolve`                              | Resolve open Droid threads as dismissed, without claiming the code was fixed.    |
| `@droid pause`, `@droid resume`               | Pause automatic reviews; resume resets the automatic-run budget.                 |
| `@droid fill`                                 | Replace only Droid's marked description block, preserving author text.           |
| `@droid <question>` in a Droid finding thread | Answer in that thread, without starting a review.                                |

Unknown top-level commands show help. Mentions inside fenced or inline code do not trigger commands.
GitLab commands require an [authenticated note-to-pipeline bridge](docs/gitlab-setup.md#commands-and-the-pipeline-bridge); ordinary MR pipelines do not react to new notes.

### `@droid fill`

- Place the command in the PR description or in a top-level comment.
- Droid searches for common PR template locations (`.github/pull_request_template.md`, etc.). When a template exists, it fills the sections; otherwise it writes a structured summary (overview, changes, testing, rollout).
- Generated content is wrapped in `droid-fill:start` / `droid-fill:end` markers. Re-running replaces that block only, with a commit provenance line; author text outside it stays untouched.

### `@droid review`

- Mention `@droid review` in a PR comment.
- Droid inspects the diff, prioritizes potential bugs or high-impact issues, and leaves inline comments directly on the changed lines.
- One sticky summary comment holds the verdict, linked findings, resolved findings, outside-diff findings, validator counts, and review details.

### `@droid fix`

The default `fix_mode: commit` verifies open findings and commits a focused fix when the actor and token can write to the source branch. Protected branches and writable forks use an authorized stacked PR/MR. `fix_mode: pr` always uses a stacked change; `off` disables publishing. Forks without source-repository write permission receive an explicit refusal.

Droid never pushes to a repository's default branch and never force-pushes. The publisher checks the live source head, source-repository permissions, paths, credentials, and concurrent updates after the file-only model step. It reports the commit or stacked-change link, a collapsed diff preview, and actual validation limitations. The next review resolves threads only after the validator confirms the fixes, not merely because code moved.

### Review UX and visible defaults

Review output is rendered by TypeScript from the two-pass validator's structured JSON. The model supplies evidence and prose, not layout, counts, badges, or links.

- A sticky issue comment is the default summary location. Running and failed states preserve the previous review below a clear banner.
- Findings use native text severity labels by default, optional complete suggestions, a stable hidden finding marker, and a collapsed **Fix with an agent** prompt with an untrusted-data warning. Verification, related locations, rationale and guideline permalinks live in the summary's collapsed **Review details**; security severity and CWE remain visible inline. Image and emoji badges remain explicit opt-ins.
- Clean reviews explicitly say no issues were found. Droid does not submit an empty review object.
- Lifecycle reactions are eyes while running, hooray when clean, and confused on failure. Eyes are removed at completion. Droid does not request, read, or learn from thumbs feedback.
- Re-reviews use stored state to avoid duplicates, honor human-dismissed threads, and resolve only confirmed fixes. Unchanged optional suggestions are suppressed only when explicitly classified as optional, never merely because they are P2.
- The `Droid Review` check is successful when clean, neutral for nonblocking findings or review errors, and fails only at a configured priority/security threshold. Droid never approves or requests changes.
- Generated/lock files are excluded by default and listed with reasons. Unknown `review_depth` values warn and use `deep`. The legacy `label_trigger` input is unsupported and has no default trigger.

See [rendered fixture examples](docs/review-ux-preview.md), [all inputs and permissions](docs/setup.md), and [GitLab differences](docs/gitlab-setup.md#platform-differences).

### `@droid security`

- Mention `@droid security` in a PR comment to trigger an on-demand security review of the PR diff.
- Droid runs a security-focused review using STRIDE methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) along with OWASP Top 10 and OWASP LLM Top 10 checks.
- Each finding includes a severity level, CWE reference (where applicable), an explanation, and a suggested fix posted as inline review comments.
- Set `automatic_security_review: true` in your auto-review workflow to run the security pass on every non-draft PR alongside the standard code review (the two run concurrently).

### `@droid security --full`

- Performs a full repository security scan instead of just PR changes — useful for scheduled audits or onboarding a new repo.
- Creates a new branch and opens a PR containing a security report at `.factory/security/reports/security-report-{date}.md` plus auto-generated patches where Droid is confident in the fix.
- To run on a schedule, invoke the action from a cron-triggered workflow with `security_scan_schedule: true`. Use `security_scan_days` to control how many days of recent commits are included.

#### Enabling automatic security review

Security review is enabled by default in GitHub workflows with `automatic_review: true`. You can also set it explicitly in your `droid-review.yml`:

```yaml
- name: Run Droid Auto Review
  uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    automatic_security_review: true
```

#### Scheduling full-repo scans

```yaml
name: Droid Security Scan

on:
  schedule:
    - cron: "0 9 * * 1" # Every Monday at 09:00 UTC
  workflow_dispatch:

jobs:
  security-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: Factory-AI/droid-action@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          security_scan_schedule: true
          security_scan_days: 7
```

## Authentication

Droid needs two separate kinds of access: permission to run Droid, and permission to post on your pull requests. You set them up independently.

### 1. Factory API key (run Droid)

Droid runs using your Factory API key. Create one at [app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) and save it as a `FACTORY_API_KEY` secret in your repository or organization. Pass it to the action on every run:

```yaml
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
```

This input is required.

### 2. GitHub access (post reviews)

To leave comments and reviews on your PRs, Droid needs a GitHub token. Droid never approves. There are two ways to provide one:

- **Factory Droid GitHub App (default, recommended).** If you don't pass a token, the action securely requests one for the installed Factory Droid GitHub App. For most teams this is all you need: install the app on your repositories from [app.factory.ai/settings/organization](https://app.factory.ai/settings/organization). It requires the `id-token: write` permission so the action can request the token:

  ```yaml
  permissions:
    contents: write
    pull-requests: write
    issues: write
    id-token: write # required for GitHub App auth
  ```

  The app token only carries what the run needs. Review posting can read code and write to pull requests; fix publishing separately requires contents write. Check runs use the caller workflow token with `checks: write`, not a broadened Factory App token. Missing check permission produces one warning and does not fail the review. The action revokes its App token when it finishes, so later steps cannot use its `github_token` output.

- **Your own token (override).** If you'd rather use a personal access token or your own GitHub App — for example on GitHub Enterprise, or to control which account posts comments — pass it as `github_token`. When set, Droid uses it directly and skips the app. The token needs write access to pull requests and repository contents.

  ```yaml
  - uses: Factory-AI/droid-action@main
    with:
      factory_api_key: ${{ secrets.FACTORY_API_KEY }}
      github_token: ${{ secrets.MY_GITHUB_TOKEN }}
  ```

> On GitLab, the same two pieces apply: set `FACTORY_API_KEY` and `GITLAB_TOKEN` as CI/CD variables. See [`docs/gitlab-setup.md`](docs/gitlab-setup.md).

## Configuration

### Core Inputs

| Input                    | Purpose                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_api_key`        | **Required.** Grants Droid Exec permission to run via Factory.                                                                                                                                                                                |
| `github_token`           | Optional override if you prefer a custom GitHub App/token. By default the installed app token is used.                                                                                                                                        |
| `upload_debug_artifacts` | Default `false`. Uploads a `droid-review-debug-<run_id>` artifact with Droid's logs, sessions and review prompts. Credentials are redacted, but anyone who can read the repository's Actions runs can download it, including on public repos. |

### Review Configuration

| Input                         | Default | Purpose                                                                                              |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `automatic_review`            | `false` | Automatically run code review on PRs without requiring `@droid review`.                              |
| `review_depth`                | `deep`  | Review depth preset: `shallow` (fast) or `deep` (thorough). See [Review Depth](#review-depth) below. |
| `review_candidates_max_turns` | `100`   | Stop candidate generation after this many assistant turns.                                           |
| `review_validator_max_turns`  | `40`    | Stop validation after this many assistant turns.                                                     |

### Review UX Inputs

These are **effective defaults**. Config-enabled action inputs use an empty-string inheritance sentinel, not an explicit default override. Set a nonempty input to override the base-branch file, including `false` and `0`. Use `off` to clear `fail_on_severity`; use `[]` to clear a list. GitLab exposes the same settings as component inputs, with automatic code and security review effectively enabled by default.

| Input                       | Effective default                              | Purpose                                                                              |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `review_summary`            | `comment`                                      | `comment`, `description`, or `off`. Description mode owns only its marked block.     |
| `review_summary_sections`   | `verdict,findings,changes,details`             | Visible sections; also accepts `diagram`, `risk`, `effort`.                          |
| `review_badges`             | `text`                                         | Native code-formatted severity labels; `image` and `emoji` remain explicit opt-ins.  |
| `review_reactions`          | `true`                                         | Running/clean/failure lifecycle reactions, never feedback reactions.                 |
| `review_check_run`          | `true`                                         | GitHub check run; GitLab commit status.                                              |
| `fail_on_severity`          | `""`                                           | Fail only when an open finding meets `P0`, `P1`, or `P2` or a higher priority.       |
| `review_incremental`        | `true`                                         | Review only new changes after a successful review; full-review commands override it. |
| `review_auto_resolve`       | `true`                                         | Resolve only validator-confirmed fixed threads.                                      |
| `review_max_auto_runs`      | `0`                                            | Automatic-run budget; `0` means unlimited.                                           |
| `show_dropped_findings`     | `false`                                        | Show dropped candidate details/reasons. Aggregate counts always remain visible.      |
| `include_agent_prompts`     | `true`                                         | Per-finding and fix-all prompts with an untrusted-data preamble.                     |
| `fix_mode`                  | `commit`                                       | `commit`, `pr` (stacked PR/MR), or `off`.                                            |
| `review_diagram`            | `auto`                                         | Include an evidenced passive Mermaid diagram, or `off`.                              |
| `review_severity_threshold` | `P2`                                           | Report P0/P1/P2 by default; choose `P0` or `P1` for a stricter reporting floor.      |
| `review_ignore_paths`       | Generated/build/lock files                     | Comma/newline-separated glob patterns. See the base-config example below.            |
| `review_auto_triggers`      | `opened,reopened,synchronize,ready_for_review` | Automatic event actions. The workflow must subscribe to those events too.            |
| `review_drafts`             | `false`                                        | Review drafts automatically; explicit review commands still work.                    |
| `review_effort`             | `false`                                        | Include an evidence-backed effort estimate.                                          |
| `review_category_chips`     | `false`                                        | Show correctness/security/performance/maintainability labels.                        |
| `review_suggest_reviewers`  | `false`                                        | Suggest reviewers from base-branch CODEOWNERS, never assign them.                    |
| `review_pre_merge_checks`   | None                                           | Opt-in `title,description,linked_issue` checks.                                      |

### Base-branch repository configuration

Precedence is built-in defaults, then `.factory/review.yaml` fetched at an immutable **base-branch** SHA, then explicit nonempty action/component inputs. A PR cannot weaken its own review by changing the head checkout's configuration. Invalid configuration fails explicitly instead of silently loading head-branch files.

```yaml
# .factory/review.yaml, merged to the base branch
review_depth: deep
review_badges: text
review_summary: comment
review_summary_sections: [verdict, findings, changes, details, risk]
review_incremental: true
review_auto_resolve: true
review_max_auto_runs: 0
review_severity_threshold: P2
review_ignore_paths:
  - "**/*.lock"
  - "**/*.lockb"
  - "**/package-lock.json"
  - "**/pnpm-lock.yaml"
  - "**/go.sum"
  - "**/dist/**"
  - "**/build/**"
  - "**/coverage/**"
  - "**/*.generated.*"
  - "**/generated/**"
auto_review:
  enabled: true
  security: true
  triggers: [opened, reopened, synchronize, ready_for_review]
  drafts: false
fix_mode: commit
```

The shorter aliases `depth`, `severity_threshold`, `ignore_paths`, `summary_sections`, `badges`, `incremental`, `auto_resolve`, and `max_auto_runs` are accepted. Do not specify an alias and its full key together. Model and reasoning inputs still override the selected depth preset.

### Review Depth

`review_depth` is the only setting you need to choose how reviews run. Each preset picks the model and reasoning effort for you, and Factory keeps it on its recommended model as new models ship. You get upgrades without editing your workflow or updating `droid-action`.

| Depth              | Best For                                                              |
| ------------------ | --------------------------------------------------------------------- |
| **deep** (default) | Thorough reviews that catch subtle bugs and design issues             |
| **shallow**        | Fast, lower-cost reviews for straightforward PRs or high-volume repos |

```yaml
# Deep review (default - no extra config needed)
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    automatic_security_review: true

# Shallow review for faster feedback
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    automatic_security_review: true
    review_depth: shallow
```

`deep` is what the Factory team uses on its own repositories. When you pick `deep`, you get the model Factory has hand-picked for code review: a strong, balanced model run with medium reasoning effort, updated as better models ship.

We recommend using one of these presets rather than choosing a model yourself. If your workflow sets `review_model`, `security_model`, or `reasoning_effort` from an earlier setup, remove them so reviews follow the preset and stay current.

### Security Configuration

| Input                         | Default                    | Purpose                                                                                                           |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `automatic_security_review`   | Follows `automatic_review` | Automatically run security review on PRs without requiring `@droid security`. Set `false` to opt out.             |
| `security_severity_threshold` | `medium`                   | Minimum severity to report (`critical`, `high`, `medium`, `low`). Findings below this threshold are filtered out. |
| `security_block_on_critical`  | `true`                     | Fail the check/status for critical security findings; never request changes.                                      |
| `security_block_on_high`      | `false`                    | Fail the check/status for high or critical security findings; never request changes.                              |
| `security_notify_team`        | `""`                       | GitHub team to @mention on critical findings (e.g., `@org/security-team`).                                        |
| `security_scan_schedule`      | `false`                    | Configuration for scheduled security scans (when invoked from scheduled workflows).                               |
| `security_scan_days`          | `7`                        | Number of days of commits to scan for scheduled security scans.                                                   |

## Custom Review Guidelines

You can add repository-specific review guidelines by creating a `.factory/skills/review-guidelines/SKILL.md` file:

```markdown
Additional checks for this codebase:

- React hooks rules violations
- Missing TypeScript types on public APIs
- Prisma query performance issues
```

These guidelines are automatically loaded whenever the `review` skill runs, which covers both the code review candidate-generation and validation passes. No workflow changes needed.

### Learning guidelines from past reviews

The `review-guidelines` actions write this file for you. On each run, the first job collects the review comments that authors acted on since the last run and turns them into guidelines. A second job opens a pull request with the changes (or updates the open one). Nothing reaches the repository until you merge that pull request.

```yaml
name: Learn review guidelines

on:
  schedule:
    - cron: "0 9 * * 1"
  workflow_dispatch:

jobs:
  learn-review-guidelines:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    # `id-token: write` lets the job request the OIDC token it exchanges for
    # a Factory GitHub App token.
    permissions:
      contents: read
      id-token: write
    concurrency:
      group: droid-review-guidelines
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Factory-AI/droid-action/review-guidelines@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}

  publish-review-guidelines:
    needs: learn-review-guidelines
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: Factory-AI/droid-action/review-guidelines/publish@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
```

| Input                  | Action                      | Default | Description                                                                                      |
| ---------------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `include_bot_comments` | `review-guidelines`         | `true`  | Learn from bots' review comments too. Set to `false` to use people's comments only.              |
| `github_token`         | both                        | `""`    | Optional. Without it, each action exchanges the job's OIDC token for a Factory GitHub App token. |
| `factory_api_key`      | `review-guidelines/publish` | `""`    | Optional. Only used to check that the published files do not contain it.                         |

The step that writes guidelines reads untrusted comment text. It runs with file tools only and no GitHub token, and because it could still change any file in its job, publishing happens in the second job on a fresh runner. That job accepts only the guidelines files and the PR description, refuses anything else, and refuses output that contains a credential.

## Security Skills

The security review uses specialized Factory skills installed from the public `Factory-AI/skills` repository:

- **threat-model-generation** – Generates STRIDE-based threat models for repositories
- **commit-security-scan** – Scans code changes for security vulnerabilities
- **vulnerability-validation** – Validates findings and filters false positives
- **security-review** – Comprehensive security review and patch generation

These skills are automatically installed when running security reviews.

## Advanced: Model Overrides

<details>
<summary>Only needed if your organization requires a specific model provider</summary>

Most teams should use [`review_depth`](#review-depth) and leave these inputs empty. Overrides take priority over the depth preset.

| Input              | Applies to                                                |
| ------------------ | --------------------------------------------------------- |
| `review_model`     | Code review                                               |
| `security_model`   | Security review (falls back to `review_model` when empty) |
| `fill_model`       | PR description fill                                       |
| `reasoning_effort` | Code and security review (`deep` uses `medium`)           |

If you set a model, use a provider tier alias. Factory keeps each alias on its recommended model for that provider and tier, so your reviews still pick up new models automatically. An alias stays in the same price tier when its model changes.

| Provider           | Aliases                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| OpenAI             | `openai-latest-premium`, `openai-latest-balanced`, `openai-latest-fast`          |
| Anthropic          | `anthropic-latest-premium`, `anthropic-latest-balanced`, `anthropic-latest-fast` |
| Open-weight models | `oss-latest-premium`, `oss-latest-balanced`, `oss-latest-fast`                   |

```yaml
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    automatic_security_review: true
    review_model: openai-latest-premium # or anthropic-latest-balanced
```

Your organization's model policy is checked against the model an alias currently resolves to. If that model is not allowed, Droid falls back to your organization's default model and says so in the tracking comment.

Exact model IDs are also accepted, but they never upgrade on their own, so reviews stay on that model until you edit the workflow. We do not recommend them.

</details>

## Troubleshooting & Support

- Check the workflow run linked from the Droid tracking comment for execution logs.
- Verify that the workflow file and repository allow the GitHub App to run (branch protections can block bots).
- Automatic security reviews are deduplicated per PR to reduce duplicate scans; use `@droid security` explicitly if you need to re-run.
- Need more detail? Start with the [Setup Guide](./docs/setup.md) or [FAQ](./docs/faq.md).
