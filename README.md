# Droid Actions for GitHub

This GitHub Action powers the Factory **Droid** app. It watches your pull requests for the two supported commands and runs a full Droid Exec session to help you ship faster:

* `@droid fill` — turns a bare pull request into a polished description that matches your template or our opinionated fallback.
* `@droid review` — performs an automated code review, surfaces potential bugs, and leaves inline comments directly on the diff.

Everything runs inside GitHub Actions using your Factory API key, so the bot never leaves your repository and operates with the permissions you grant.

## What Happens When You Tag `@droid`

1. **Trigger detection** – The action scans issue comments, PR descriptions, and review comments for `@droid fill` or `@droid review`.
2. **Context gathering** – Droid collects the PR metadata, existing comments, changed files, and any PR description template in your repository.
3. **Prompt generation** – We compose a precise prompt instructing Droid what to do (fill or review) and which GitHub MCP tools it may use.
4. **Execution** – The action runs `droid exec` with full repository context. MPU tools are pre-registered so Droid can call the GitHub APIs safely.
5. **Results** – For fill, Droid updates the PR body. For review, it posts inline feedback and a summary comment under the original request.

## Installation

1. **Install the Droid GitHub App**
   * Install from the Factory dashboard and grant it access to the repositories where you want Droid to operate.
2. **Create a Factory API Key**
   * Generate a token at [https://app.factory.ai/settings/api-keys](https://app.factory.ai/settings/api-keys) and save it as `FACTORY_API_KEY` in your repository or organization secrets.
3. **Add the Action Workflows**
   * Create two workflow files under `.github/workflows/` to separate on-demand tagging from automatic PR reviews.

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

      - name: Run Droid Exec
        uses: Factory-AI/droid-action@v1
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
```

`droid-review.yml` (runs automatic reviews when PRs are ready):

```yaml
name: Droid Auto Review

on:
  pull_request:
    types: [opened, ready_for_review, reopened]

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
        uses: Factory-AI/droid-action@v1
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          automatic_review: true
```

Once committed, tagging `@droid fill` or `@droid review` on an open PR will trigger the bot automatically, and non-draft PRs will also receive automatic reviews if `droid-review.yml` is enabled.

## Using the Commands

### `@droid fill`
* Place the command in the PR description or in a top-level comment.
* Droid searches for common PR template locations (`.github/pull_request_template.md`, etc.). When a template exists, it fills the sections; otherwise it writes a structured summary (overview, changes, testing, rollout).
* The original request is replaced with the generated description so reviewers can merge immediately.

### `@droid review`
* Mention `@droid review` in a PR comment.
* Droid inspects the diff, prioritizes potential bugs or high-impact issues, and leaves inline comments directly on the changed lines.
* A short summary comment is posted in the original thread highlighting the findings and linking to any inline feedback.

## Configuration Essentials

| Input | Purpose |
| --- | --- |
| `factory_api_key` | **Required.** Grants Droid Exec permission to run via Factory. |
| `github_token` | Optional override if you prefer a custom GitHub App/token. By default the installed app token is used. |
| `review_model` | Optional. Override the model used for code review (e.g., `claude-sonnet-4-5-20250929`, `gpt-5.1-codex`). Only applies to review flows. |

## Troubleshooting & Support

* Check the workflow run linked from the Droid tracking comment for execution logs.
* Verify that the workflow file and repository allow the GitHub App to run (branch protections can block bots).
* Need more detail? Start with the [Setup Guide](./docs/setup.md) or [FAQ](./docs/faq.md).
