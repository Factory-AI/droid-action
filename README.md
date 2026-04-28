# Droid Actions for GitHub

This GitHub Action powers the Factory **Droid** app. It watches your pull requests for supported commands and runs a full Droid Exec session to help you ship faster:

- `@droid fill` — turns a bare pull request into a polished description that matches your template or our opinionated fallback.
- `@droid review` — performs an automated code review, surfaces potential bugs, and leaves inline comments directly on the diff.
- `@droid security` — performs an automated security review using STRIDE methodology, identifying vulnerabilities and suggesting fixes.
- `@droid security --full` — performs a full repository security scan and creates a PR with the report.

Everything runs inside GitHub Actions using your Factory API key, so the bot never leaves your repository and operates with the permissions you grant.

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

- Detect whether your repository lives on GitHub or GitLab.
- Help you install the Droid GitHub App (or configure GitLab access).
- Generate the workflow files (`droid.yml` and `droid-review.yml`) with sensible defaults.
- Prompt you for `review_depth`, security review options, and other inputs.
- Open a PR/MR containing the new workflow files for you to review and merge.

For GitHub-only setups you can also run `/install-github-app`. See the [Automated Code Review guide](https://docs.factory.ai/guides/droid-exec/code-review) and the [GitHub App installation guide](https://docs.factory.ai/cli/features/install-github-app) for full details.

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
      contents: read
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1

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
    types: [opened, ready_for_review, reopened]

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
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5
        with:
          fetch-depth: 1

      - name: Run Droid Auto Review
        uses: Factory-AI/droid-action@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          automatic_review: true
          automatic_security_review: true
```

Set `automatic_review: true` to run code reviews automatically on non-draft PRs. Set `automatic_security_review: true` to additionally run a STRIDE-based security review concurrently on every non-draft PR.

## Using the Commands

### `@droid fill`

- Place the command in the PR description or in a top-level comment.
- Droid searches for common PR template locations (`.github/pull_request_template.md`, etc.). When a template exists, it fills the sections; otherwise it writes a structured summary (overview, changes, testing, rollout).
- The original request is replaced with the generated description so reviewers can merge immediately.

### `@droid review`

- Mention `@droid review` in a PR comment.
- Droid inspects the diff, prioritizes potential bugs or high-impact issues, and leaves inline comments directly on the changed lines.
- A short summary comment is posted in the original thread highlighting the findings and linking to any inline feedback.

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

To run the security review on every non-draft PR (alongside the regular code review), add `automatic_security_review: true` to your `droid-review.yml`:

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

      - uses: Factory-AI/droid-action@main
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          security_scan_schedule: true
          security_scan_days: 7
```

## Configuration

### Core Inputs

| Input             | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `factory_api_key` | **Required.** Grants Droid Exec permission to run via Factory.                                         |
| `github_token`    | Optional override if you prefer a custom GitHub App/token. By default the installed app token is used. |

### Review Configuration

| Input              | Default | Purpose                                                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `automatic_review` | `false` | Automatically run code review on PRs without requiring `@droid review`.                              |
| `review_depth`     | `deep`  | Review depth preset: `shallow` (fast) or `deep` (thorough). See [Review Depth](#review-depth) below. |
| `review_model`     | `""`    | Override the model for code review. When empty, determined by `review_depth`.                        |
| `reasoning_effort` | `""`    | Override reasoning effort for review. When empty, determined by `review_depth`.                      |
| `fill_model`       | `""`    | Override the model used for PR description fill.                                                     |

### Review Depth

The `review_depth` input controls which model and reasoning effort are used for code reviews. Two presets are available:

| Depth       | Model          | Reasoning Effort | Best For                                                |
| ----------- | -------------- | ---------------- | ------------------------------------------------------- |
| **deep**    | `gpt-5.2`      | `high`           | Thorough reviews catching subtle bugs and design issues |
| **shallow** | `kimi-k2-0711` | default          | Fast, cost-effective reviews for straightforward PRs    |

**Examples:**

```yaml
# Deep review (default - no extra config needed)
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true

# Shallow review for faster feedback
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    review_depth: shallow

# Fully custom model (overrides depth preset entirely)
- uses: Factory-AI/droid-action@main
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    review_model: claude-sonnet-4-6
    reasoning_effort: high
```

> **Tip:** Setting `review_model` or `reasoning_effort` explicitly always takes priority over the depth preset. You can mix and match -- for example, use `review_depth: shallow` but override just `reasoning_effort: high` to get the shallow model with higher reasoning.

The default models (`gpt-5.2` for `deep`, `kimi-k2-0711` for `shallow`) are managed by Factory and may change over time. To pin a specific model regardless of the depth preset, set `review_model` to any model ID supported by `droid exec --model`. A few common choices:

- `claude-opus-4-7`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`
- `gpt-5.5`
- `gpt-5.5-pro`
- `gpt-5.3-codex`
- `kimi-k2.6`

See the [CLI reference](https://docs.factory.ai/reference/cli-reference#available-models) for the canonical, up-to-date list.

### Security Configuration

| Input                         | Default  | Purpose                                                                                                           |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `automatic_security_review`   | `false`  | Automatically run security review on PRs without requiring `@droid security`.                                     |
| `security_model`              | `""`     | Override the model used for security review. Falls back to `review_model` if not set.                             |
| `security_severity_threshold` | `medium` | Minimum severity to report (`critical`, `high`, `medium`, `low`). Findings below this threshold are filtered out. |
| `security_block_on_critical`  | `true`   | Submit `REQUEST_CHANGES` review when critical severity findings are detected.                                     |
| `security_block_on_high`      | `false`  | Submit `REQUEST_CHANGES` review when high severity findings are detected.                                         |
| `security_notify_team`        | `""`     | GitHub team to @mention on critical findings (e.g., `@org/security-team`).                                        |
| `security_scan_schedule`      | `false`  | Configuration for scheduled security scans (when invoked from scheduled workflows).                               |
| `security_scan_days`          | `7`      | Number of days of commits to scan for scheduled security scans.                                                   |

## Custom Review Guidelines

You can add repository-specific review guidelines by creating a `.factory/skills/review-guidelines/SKILL.md` file:

```markdown
Additional checks for this codebase:

- React hooks rules violations
- Missing TypeScript types on public APIs
- Prisma query performance issues
```

These guidelines are automatically loaded and injected into all review prompts (code review, security review, and validation passes). No workflow changes needed.

## Security Skills

The security review uses specialized Factory skills installed from the public `Factory-AI/skills` repository:

- **threat-model-generation** – Generates STRIDE-based threat models for repositories
- **commit-security-scan** – Scans code changes for security vulnerabilities
- **vulnerability-validation** – Validates findings and filters false positives
- **security-review** – Comprehensive security review and patch generation

These skills are automatically installed when running security reviews.

## Troubleshooting & Support

- Check the workflow run linked from the Droid tracking comment for execution logs.
- Verify that the workflow file and repository allow the GitHub App to run (branch protections can block bots).
- Automatic security reviews are deduplicated per PR to reduce duplicate scans; use `@droid security` explicitly if you need to re-run.
- Need more detail? Start with the [Setup Guide](./docs/setup.md) or [FAQ](./docs/faq.md).
