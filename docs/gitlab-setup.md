# GitLab Setup

This action ships a **GitLab CI/CD Component** that delivers the same
automated code-review experience as the GitHub action on GitLab merge
requests (MRs). The component runs on every `merge_request_event` pipeline,
posts inline comments on the diff, maintains a sticky tracking note, and
optionally runs a security-focused subagent in parallel.

## Quick start with `/install-code-review`

The fastest path is the guided installer built into the Droid CLI:

```bash
droid
> /install-code-review
```

It detects GitLab, asks which account should be the poster of review
comments (you supply its PAT as `GITLAB_TOKEN`), asks the configuration
questions below, drops `factory/droid-review.yml` in your project, wires
it into `.gitlab-ci.yml`, and opens an MR / direct-commits to the target
project(s).

## Manual installation

### 1. Prerequisites

| Requirement                           | How to get it                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitLab Maintainer role on the project | Repo admin grants you Maintainer (40)                                                                                                                                                                    |
| `FACTORY_API_KEY` CI/CD variable      | Generate at <https://app.factory.ai/settings/api-keys>; add as **masked**, **unprotected** variable at the project, subgroup, or top-level group level                                                   |
| `GITLAB_TOKEN` CI/CD variable         | A personal access token with the `api` scope, owned by whichever account should post review comments. The token owner is the poster — there is no API impersonation. Add as **masked**, **unprotected**. |

### 2. Add the CI/CD Component

Drop-in samples live in [`gitlab/examples/`](../gitlab/examples/). The
layout is two files:

- [`factory/droid-review.yml`](../gitlab/examples/factory/droid-review.yml) — self-contained config (include + inputs + variables). Drop verbatim.
- [`.gitlab-ci.yml`](../gitlab/examples/.gitlab-ci.yml) — project-root entry point. If you already have one, append the include line below to its `include:` block.

**`factory/droid-review.yml`** (drop into your project):

```yaml
include:
  - project: "factory-components/droid-action"
    ref: main
    file: "/templates/droid-review.yml"
    inputs:
      automatic_review: "true"
      automatic_security_review: "false"
      review_depth: "deep"
      include_suggestions: "true"
      security_block_on_critical: "true"
      security_block_on_high: "false"

droid-review:
  variables:
    FACTORY_API_KEY: $FACTORY_API_KEY
    GITLAB_TOKEN: $GITLAB_TOKEN
```

**`.gitlab-ci.yml`** (project root, just needs the one include line):

```yaml
include:
  - local: "factory/droid-review.yml"
```

> The remote `include:` URL is pinned to `@main`, which tracks the
> latest stable cut of droid-action.

### 3. Push an MR

Open or push to an MR. The next `merge_request_event` pipeline will run
the `droid-review` job. Expect ~5-10 minutes for a typical change.

## Inputs

| Input                        | Default   | Description                                                                                                                                  |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `automatic_review`           | `"true"`  | Run code review automatically on every MR pipeline.                                                                                          |
| `automatic_security_review`  | `"false"` | Run a parallel security-focused subagent on every MR pipeline. Findings are prefixed `[security]` and posted alongside code-review comments. |
| `review_depth`               | `"deep"`  | `"deep"` (thorough) or `"shallow"` (fast).                                                                                                   |
| `review_model`               | `""`      | Override the model. Empty = use depth preset.                                                                                                |
| `reasoning_effort`           | `""`      | Override reasoning effort. Empty = use depth preset.                                                                                         |
| `include_suggestions`        | `"true"`  | Include code suggestion blocks in review comments when the fix is high-confidence.                                                           |
| `security_block_on_critical` | `"true"`  | Block merge on CRITICAL security findings. (Mirrors GitHub action; surface-level parity.)                                                    |
| `security_block_on_high`     | `"false"` | Block merge on HIGH security findings. (Mirrors GitHub action; surface-level parity.)                                                        |
| `settings`                   | `""`      | Droid Exec settings as a JSON string or a path to a JSON file. Merged into `~/.factory/droid/settings.json` before each `droid exec` call.   |
| `org_guidelines_source`      | `""`      | Org-wide review guidelines source: a local file path on the runner, an http(s) URL to the raw markdown, a git clone URL ending in `.git`, or a GitLab project path (e.g. `my-group/review-guidelines`) cloned with `$CI_JOB_TOKEN`. Empty = disabled. |
| `org_guidelines_ref`         | `""`      | Git sources only: branch or tag of the org guidelines repo. Empty = default branch.                                                          |
| `org_guidelines_path`        | `"review-guidelines.md"` | Git sources only: path of the guidelines markdown file inside the org guidelines repo.                                        |

## Org-wide review guidelines

Repository-specific guidelines live in the project itself at
`.factory/skills/review-guidelines/SKILL.md` (same as the GitHub action).
To apply one set of guidelines across every project in your org, point
`org_guidelines_source` at a single markdown file:

```yaml
include:
  - project: "factory-components/droid-action"
    ref: main
    file: "/templates/droid-review.yml"
    inputs:
      org_guidelines_source: "my-group/review-guidelines" # project path (see below for other forms)
      org_guidelines_path: "review-guidelines.md"
```

`org_guidelines_source` accepts, in order of lookup:

- **A git clone URL** (ending in `.git`, or `ssh://` / `git@` form). Cloned
  as-is; `org_guidelines_ref` / `org_guidelines_path` select the file.
- **An http(s) URL** to the raw markdown. Fetched with `curl`; URLs on the
  same GitLab instance get a `JOB-TOKEN` header, so the repository files
  API works for private repos, e.g.
  `https://gitlab.com/api/v4/projects/<id>/repository/files/review-guidelines.md/raw?ref=main`.
  Any other public URL works too.
- **A local file path** on the runner. Useful with a group-level
  **file-type CI/CD variable**: define `DROID_ORG_GUIDELINES` (type: File)
  on the group and set `org_guidelines_source: "$DROID_ORG_GUIDELINES"`.
  No network access or allowlisting needed.
- **A GitLab project path** (e.g. `my-group/review-guidelines`, anything
  that is not a URL or an existing file). Cloned from `$CI_SERVER_HOST`
  with `$CI_JOB_TOKEN`; add your projects (or the parent group) to the
  guidelines repo's **job token allowlist** (guidelines repo → Settings →
  CI/CD → Job token permissions).

Before each review, the job materializes the file as a **user-level**
`org-review-guidelines` skill on the runner
(`~/.factory/skills/org-review-guidelines/SKILL.md`). Because it lives
outside the project tree, it never collides with a project's own
`review-guidelines` skill — both apply, and the project-level skill takes
precedence on conflicts.

Notes:

- The guidelines file is plain markdown; if it starts with `---` YAML
  frontmatter it is installed verbatim as the skill file.
- An unreachable source logs a warning and the review proceeds without
  org guidelines; it never fails the pipeline.
- Set the inputs once in a group-level include (or in each project's
  `factory/droid-review.yml`) to roll out org-wide.

## What you get

Each MR pipeline produces:

- **Inline review comments** anchored to the relevant diff lines, posted in a
  single batched `submit_review` call. Findings are prefixed with priority
  tags (`P0`, `P1`, `P2`, `P3`) and `[security]` for security findings.
- **A sticky tracking note** on the MR with pipeline + job links, telemetry
  (`N turns • Xm Ys`), session IDs, and a security badge when
  `automatic_security_review` is enabled.
- **Debug artifacts** at `.droid-debug/` (prompts, candidate JSON, raw
  stream-json logs) retained for 1 week.
- **A custom droid library** copied from
  `$DROID_ACTION_DIR/.factory/droids` into `~/.factory/droids` on the
  runner, so subagents like `security-reviewer` are reachable.
