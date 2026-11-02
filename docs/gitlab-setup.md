# GitLab Setup

This action ships a **GitLab CI/CD Component** with rich automated
code reviews on GitLab merge
requests (MRs). The component runs on every `merge_request_event` pipeline,
posts inline comments on the diff, maintains a sticky tracking note, and
optionally runs a security-focused subagent in parallel.
It also supports incremental review state, verified discussion resolution,
severity-gated commit statuses, lifecycle awards, and commands through an
opt-in authenticated pipeline bridge. [Platform differences](#platform-differences)
are explicit; the component never approves or requests changes.

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

| Requirement                           | How to get it                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitLab Maintainer role on the project | Repo admin grants you Maintainer (40)                                                                                                                                                                                                                           |
| `FACTORY_API_KEY` CI/CD variable      | Generate at <https://app.factory.ai/settings/api-keys>; add as **masked**, **unprotected** variable at the project, subgroup, or top-level group level                                                                                                          |
| `GITLAB_TOKEN` CI/CD variable         | An access token with the `api` scope, owned by whichever account should post review comments. The token owner is the poster — there is no API impersonation. Add as **masked**, **unprotected**. See [Credential scope](#credential-scope) before choosing one. |

### Credential scope

The review passes run Droid with an `Execute` tool so it can investigate
the code, and a prompt injection in the MR (in the diff, the description,
or a comment) can steer it. The job unsets `GITLAB_TOKEN` before starting
each pass, but that is not a security boundary: the pass runs as the same
OS user as the job shell and can read every CI/CD variable the job holds,
including `GITLAB_TOKEN`, `FACTORY_API_KEY`, and `CI_JOB_TOKEN`, from
its parent processes. Comments the job posts are redacted for these
credentials, but a compromised pass can still send them over the network.
Scope them so that a leak costs as little as possible:

Before any model runs, the template bundles all five credentialed adapters
and pins their SHA-256 digests plus the actual Bun and Droid executables in
the parent shell. Each adapter/CLI invocation verifies its digest, so model
edits to the action checkout are not reloaded with credentials. Finalization
uses the same parent's EXIT trap and preserves the original job status;
a fresh `after_script` has no publishing authority. This is executable
integrity checking, not protection from every same-user attack or race.

- Prefer a **project access token** (a bot user limited to one project) over
  a personal access token, which can act on everything its owner can reach.
  Give it the lowest role that can comment on merge requests (Reporter), the
  `api` scope, and a short expiry that you rotate.
- The rich review can still post with a review-only token, but **Developer
  or higher** is needed for commit statuses and branch/report publishing.
  Missing optional status/award permission warns and does not fail the
  review. Fix commands additionally verify that both the command author and
  token can write to the actual source project. A target-project role alone
  never authorizes a fork write. Protected source branches use a stacked MR.
- Add both variables as **masked** (and **hidden** where available) so they
  stay out of job logs. They must stay **unprotected** for MR pipelines on
  unprotected branches to receive them, which also means anyone who can push
  a branch to the project can run a pipeline that reads them, with or
  without Droid.
- Pipelines for MRs from forks run in the fork's project and do not receive
  your project's variables unless you opt in to running them in the parent
  project. Only do that for forks you trust.

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
      automatic_security_review: "true"
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

Defaults below are **effective defaults**. Config-enabled component inputs use `""` as an inheritance sentinel, so an omitted include input does not overwrite base-branch configuration. Precedence is GitLab built-ins (automatic code/security review both on), immutable target-branch `.factory/review.yaml`, then explicit nonempty component inputs. Explicit `false` and `0` are preserved; `off` clears the priority gate and `[]` clears a list. The configuration file and CODEOWNERS are fetched from the target branch, not the MR checkout.

| Input                         | Effective default                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automatic_review`            | `true`                                                   | Run code review automatically on every MR event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `review_depth`                | `deep`                                                   | Review depth preset: `shallow` (fast) or `deep` (thorough). Factory keeps each preset on its recommended model, so this is the only model setting most projects need.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `review_model`                | `""`                                                     | Advanced. Leave empty to use the `review_depth` preset (recommended). If set, use a provider tier alias such as `openai-latest-premium` or `anthropic-latest-balanced`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reasoning_effort`            | `""`                                                     | Advanced. Leave empty to use the `review_depth` preset (recommended).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `include_suggestions`         | `true`                                                   | Include code suggestion blocks in review comments when the fix is high-confidence. Set to "false" to disable suggestion blocks entirely. Mirrors the GitHub action's `include_suggestions` input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `automatic_security_review`   | `true`                                                   | Automatically run a security-focused review subagent in parallel with the regular code review on every MR pipeline. Findings are prefixed with `[security]` and posted alongside code-review comments. Mirrors the GitHub action's `automatic_security_review` input. The security-review skill is built into the Droid CLI; no plugin install is required. Only runs when `automatic_review` is enabled. Set to "false" to keep code-only review.                                                                                                                                                                                                                                                                                         |
| `security_block_on_critical`  | `true`                                                   | When the security reviewer reports CRITICAL findings, block merge of the MR. Mirrors the GitHub action's `security_block_on_critical` input. Defaults to `"true"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `security_block_on_high`      | `false`                                                  | When the security reviewer reports HIGH findings, block merge of the MR. Mirrors the GitHub action's `security_block_on_high` input. Defaults to `"false"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `review_summary`              | `comment`                                                | comment, description, or off. Effective default: comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `review_summary_sections`     | `verdict,findings,changes,details`                       | Comma-separated sections. Default: verdict,findings,changes,details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `review_badges`               | `text`                                                   | text, image, or emoji. Effective default: text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `review_reactions`            | `true`                                                   | eyes / tada (clean) / confused lifecycle awards. Default: true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `review_check_run`            | `true`                                                   | Publish Droid Review commit status (GitLab check-run analog). Default: true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fail_on_severity`            | `""`                                                     | Fail commit status at or above P0, P1, or P2. Empty default disables; off clears base config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `review_incremental`          | `true`                                                   | Review changes since the last successful review. Default: true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `review_auto_resolve`         | `true`                                                   | Resolve discussions only after explicit fixed validation. Default: true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `review_max_auto_runs`        | `0`                                                      | Pause after N automatic reviews. Default: 0 (unlimited).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `show_dropped_findings`       | `false`                                                  | List validator-dropped candidates and reasons. Default: false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `include_agent_prompts`       | `true`                                                   | Include untrusted-data-safe AI-agent prompt blocks. Default: true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `fix_mode`                    | `commit`                                                 | commit, pr (stacked MR), or off. Effective default: commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `review_diagram`              | `auto`                                                   | auto or off. Effective default: auto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `review_severity_threshold`   | `P2`                                                     | Minimum priority to report: P0, P1, or P2. Default: P2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `review_ignore_paths`         | `Generated/build/lock globs`                             | Comma-separated ignore globs. Empty inherits base/default generated-lock exclusions; [] clears.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `review_auto_triggers`        | `opened,reopened,synchronize,ready_for_review`           | Comma-separated automatic events. Native MR pipelines infer opened or synchronize; empty inherits defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `review_drafts`               | `false`                                                  | Automatically review draft MRs. Default: false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `review_effort`               | `false`                                                  | Include evidence-backed review effort. Default: false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `review_category_chips`       | `false`                                                  | Include category labels. Default: false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `review_suggest_reviewers`    | `false`                                                  | Suggest reviewers from trusted base CODEOWNERS, never assign. Default: false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `review_pre_merge_checks`     | `None`                                                   | Comma-separated title,description,linked_issue checks. Default: none; [] clears.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `security_severity_threshold` | `medium`                                                 | Minimum security severity: critical,high,medium,low. Effective default: medium.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `settings`                    | `""`                                                     | Droid Exec settings as a JSON string or a path to a JSON file. Merged into ~/.factory/droid/settings.json on the runner before `droid exec` runs. Mirrors the GitHub action's `settings` input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `org_guidelines_source`       | `""`                                                     | Where organization-wide review guidelines live. Accepts an absolute file path on the runner (e.g. a group-level file-type CI/CD variable), an https URL to the raw markdown (same-instance URLs authenticate with $CI_JOB_TOKEN and do not follow redirects), an https clone URL ending in `.git`, or a GitLab project path (e.g. "my-group/review-guidelines") cloned from $CI_SERVER_HOST using $CI_JOB_TOKEN (add the consuming projects to the guidelines repo's job-token allowlist). The guidelines are installed as a user-level `org-review-guidelines` skill on the runner, separate from a project's own `.factory/skills/review-guidelines` skill; both apply, and the project-level skill wins on conflicts. Empty = disabled. |
| `org_guidelines_ref`          | `""`                                                     | Git sources only: branch or tag of the org guidelines repo to clone. Empty = the repo's default branch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `org_guidelines_path`         | `review-guidelines.md`                                   | Git sources only: path of the guidelines markdown file inside the org guidelines repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `droid_action_repo`           | `https://gitlab.com/factory-components/droid-action.git` | Git repo (clone URL) of droid-action. Defaults to the gitlab.com mirror so GitLab runners with restricted egress only need gitlab.com + app.factory.ai access. Override if you mirror it privately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `droid_action_ref`            | `main`                                                   | Git tag or branch of droid-action to clone at runtime (SHAs are not supported because the clone uses `--branch`). The same ref SHOULD match the `include: remote:` URL above. Internal: most users leave this at the default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stage`                       | `test`                                                   | GitLab CI stage to assign the droid-review job to. The consuming project's `.gitlab-ci.yml` must include this stage in its `stages:` list (or omit the list to use the default ordering).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Opting out of security review

Security review is on by default whenever `automatic_review` is enabled.
To keep code-only review, set the input explicitly:

```yaml
include:
  - project: "factory-components/droid-action"
    ref: main
    file: "/templates/droid-review.yml"
    inputs:
      automatic_security_review: "false"
```

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

- **A git clone URL** (an `https://` URL ending in `.git`, or `ssh://` /
  `git@` form). Cloned as-is; `org_guidelines_ref` / `org_guidelines_path`
  select the file.
- **An https URL** to the raw markdown. Fetched with `curl`; URLs on the
  same GitLab instance (`https://$CI_SERVER_HOST/...`) get a `JOB-TOKEN`
  header, so the repository files API works for private repos, e.g.
  `https://gitlab.com/api/v4/projects/<id>/repository/files/review-guidelines.md/raw?ref=main`.
  Those requests do not follow redirects, so the job token never reaches
  another host. Any other public https URL works too. Plain `http://` URLs
  are refused.
- **An absolute file path** on the runner. Useful with a group-level
  **file-type CI/CD variable**: define `DROID_ORG_GUIDELINES` (type: File)
  on the group and set `org_guidelines_source: "$DROID_ORG_GUIDELINES"`.
  No network access or allowlisting needed. Relative paths are never read as
  files, because the job's working directory is the MR checkout.
- **A GitLab project path** (e.g. `my-group/review-guidelines`, anything
  that is not a URL or an absolute path). Cloned from `$CI_SERVER_HOST`
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
  deterministic CI step after validation. Findings are prefixed with priority
  badges (`P0`, `P1`, `P2`), a Security badge where applicable, verification,
  related locations, stable hidden finding markers, and AI-agent prompts.
- **One sticky summary note**, matched by exact marker and token-user
  ownership, with a verdict, counts, linked findings, resolved findings,
  outside-diff findings, a walkthrough, validator transparency, and review
  details. In-progress, skipped and failed states retain previous context.
  `review_summary: description` owns a marked description block instead;
  `off` keeps only the hidden state note needed for incremental reviews.
- **Incremental review state** for the last reviewed head, finding IDs,
  discussion IDs, dismissal/resolution state, pause state, and automatic-run
  budget. Identical diffs skip. Only explicit validator evidence on changed
  code resolves a discussion with `✅ Fixed in <sha>.`; a human resolution is
  a dismissal, not a claim that code was fixed.
- **A Droid Review commit status**, pending/running during the review,
  successful for clean or nonblocking outcomes, and failed only when a
  configured priority/security threshold blocks. Configure GitLab's merge
  requirements to require this status if you want it to gate merging.
- **Lifecycle awards**: eyes while running, tada (hooray) when clean, and
  confused on failure. Droid removes only its own lifecycle awards and
  never reads reactions or creates learnings. Cleanup uses only award IDs
  returned when this job created its own lifecycle award, never an award list.
- **Debug artifacts** at `.droid-debug/` (prompts, candidate JSON, raw
  stream-json logs) retained for 1 week. The job's credentials
  (`FACTORY_API_KEY`, `GITLAB_TOKEN`, the CI job token) are redacted before
  upload, but the logs still contain MR content and the output of commands
  Droid ran. On a public project, anyone who can view the pipeline can
  download them.
- **A custom droid library** copied from
  `$DROID_ACTION_DIR/.factory/droids` into `~/.factory/droids` on the
  runner, so subagents like `security-reviewer` are reachable.

## Commands and the pipeline bridge

GitLab does **not** create a pipeline when someone adds an MR note. The
component accepts commands only when an existing note is explicitly routed
to a pipeline. It fetches that note itself, verifies its actual author has
an active Developer/Maintainer/Owner role, and uses the shared command
parser. Raw command text or actor IDs supplied as pipeline variables are
not trusted. Mentions inside code do not trigger commands.

| Command                                     | Result                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@droid help`                               | Commands and effective settings.                                                                                   |
| `@droid review`                             | Incremental review, full on the first run.                                                                         |
| `@droid review --full`                      | Full MR review, bypassing identical-diff skips.                                                                    |
| `@droid review <focus text>`                | Focused review.                                                                                                    |
| `@droid security`, `@droid review security` | Security-only MR review.                                                                                           |
| `@droid security --full`                    | Two-pass full-repository security audit and a stacked report MR with a findings index and verification checklists. |
| `@droid fix`                                | Fix the finding in the current Droid discussion, or all open findings at MR level.                                 |
| `@droid resolve`                            | Resolve Droid discussions as dismissed, without claiming a code fix.                                               |
| `@droid pause`, `@droid resume`             | Pause automatic reviews; resume resets the automatic-run budget.                                                   |
| `@droid fill`                               | Replace only the `droid-fill:start` / `droid-fill:end` block and preserve author text.                             |
| `@droid <question>` in a Droid discussion   | Reply in that discussion, not a full review.                                                                       |

Unknown top-level commands show help. `fix_mode: commit` publishes to an
authorized non-default source branch. Protected branches and `fix_mode: pr`
use a stacked MR. Source-project actor/token permission checks are separate
from target-project permission checks. Fix publishing rejects privileged
paths, credentials, symlinks/submodules, unsafe refs, and concurrent branch
advances. It never force-pushes or pushes to a source project's default
branch. The response includes the actual SHA/MR link, a collapsed diff
preview, and a warning when tests have not been independently verified by
the publisher. The next review verifies fixes before resolving discussions.

### Manual command pipeline

For a same-project MR:

1. Add the command as an MR note or a reply in a Droid discussion.
2. In **Build → Pipelines → New pipeline**, select that MR's **source branch**.
3. Add `CI_MERGE_REQUEST_IID` with the MR IID and `DROID_TRIGGER_NOTE_ID` with
   the command note's numeric ID. Start the pipeline.
4. The component's rules accept this `web` pipeline. If your project has
   restrictive `workflow: rules`, allow this explicitly routed command
   pipeline as well. Keep these variables scoped to the intended project;
   never supply arbitrary raw commands or impersonated actor information.

The MR IID is the short `!42` number, not its global database ID. A note's
numeric ID is the `note_1234` suffix in its permalink. A thread command must
be a real reply in the existing Droid discussion.

### Optional authenticated webhook service

The repository includes [`gitlab/note-pipeline-bridge.ts`](../gitlab/note-pipeline-bridge.ts).
Deploy it outside the untrusted MR runner, from a trusted action checkout:

1. Create a project pipeline trigger token in **Settings → CI/CD → Pipeline
   trigger tokens**. Keep it on the bridge host, never in MR content or model
   prompts. Its owner must be allowed to trigger pipelines on the source refs.
2. Set service secrets `GITLAB_BRIDGE_WEBHOOK_SECRET`,
   `GITLAB_BRIDGE_API_TOKEN` (`api` access to read notes/MRs/membership), and
   `GITLAB_PIPELINE_TRIGGER_TOKEN`. Set `GITLAB_BRIDGE_PROJECT_ID` to the
   numeric project ID. Prefer the same project bot identity as the review
   poster so its own notes are ignored.
   Also set the required trusted service authorization policy:

   ```bash
   GITLAB_BRIDGE_PIPELINE_DELEGATIONS='[{"authorId":123,"sourceBranches":["feature/review"]}]'
   ```

   Each tuple grants one actual GitLab user ID permission to start pipelines
   on the listed **exact, case-sensitive source-branch names**, in this
   configured project only. There are no wildcards, role-based automatic
   grants, or blanket enable switches. Missing, empty, or malformed policy
   refuses startup; an unmatched actual author/branch receives HTTP 403.
   Keep this policy on the trusted bridge host, never in MR content or
   pipeline-supplied CI variables. GitLab user IDs are specific to the
   configured trusted API instance.

   **This is explicit delegation of the trigger-token owner's entire
   pipeline authority, not impersonation of the note author.** Triggered
   jobs and their `CI_JOB_TOKEN` can have the owner's protected-ref,
   deployment, and other-project access. Only grant tuples to people and
   branch contents you trust with all of that authority. This delegation
   covers **all pipeline jobs, CI configuration, code, and writers able to
   change the admitted branch**, not only the note author or one approved
   command. The ordinary
   Developer membership check does not establish equivalent permissions.
   Do not grant this policy to untrusted contributors. If that delegation
   is unacceptable, do not deploy the bridge; use the manual/native pipeline
   route under an appropriately authorized user instead. Existing bridge
   deployments must add this policy before upgrading.
   Pipelines run branch content at trigger time. Re-fetching the MR and
   validating its ref/head syntax is not an atomic commit pin or an
   impersonated-author permission check.

3. For self-managed GitLab, set `GITLAB_BRIDGE_API_URL` to its HTTPS API v4
   base URL. Optionally set `GITLAB_BRIDGE_PORT` (default `8787`). The service
   binds only to `127.0.0.1`; put an authenticated TLS reverse proxy in front
   of it, restrict request size to 1 MiB, and use normal service supervision.
4. Start the trusted service with Bun 1.2.11:

   ```bash
   bun --config=/dev/null --env-file=/dev/null run /opt/droid-action/gitlab/note-pipeline-bridge.ts
   ```

5. In **Settings → Webhooks**, add the HTTPS proxy endpoint, enable **Comments**
   (Note Hook), and set its secret token to `GITLAB_BRIDGE_WEBHOOK_SECRET`.
6. Allow `trigger` pipelines with `DROID_TRIGGER_NOTE_ID` and
   `CI_MERGE_REQUEST_IID` in any project-level `workflow: rules`.

The handler checks the webhook secret in constant time, restricts the
project/event, re-fetches the actual note and author, verifies membership
and the exact trusted author/branch delegation, and triggers the live source
branch with **only** the MR IID and note ID.
The job repeats author authorization. The bridge suppresses duplicate
in-flight/completed note events in memory; command response receipts also
avoid repeat writes after job retries. MR jobs share a resource group so
reviews and commands do not race on the same sticky note.

The bundled bridge deliberately refuses cross-project/fork source refs and
posts an explanation. A fork branch is not a pipeline ref in the target
project, and handing a target project's secrets to fork code is unsafe.
An additional trusted source-snapshot integration would be needed for
automated fork commands; that route is not shipped or claimed here. Do not
work around this by exposing target-project variables to untrusted forks.

## Platform differences

- GitLab has **commit statuses**, not GitHub check runs. It has no neutral
  conclusion or check-run Markdown text/step-log field. Nonblocking findings
  and review errors therefore use a successful status with an explicit
  description; the rich sticky note carries counts, errors, and evidence.
  A review error is not a clean review. Only configured thresholds fail the
  status. Status/award permission failures warn and degrade.
- There is no GitHub review object or empty "reviewed" timeline entry to
  submit or rewrite as stale. GitLab discussions stay attached to their
  original diff versions; the sticky summary carries current/re-review state.
- GitHub's `$GITHUB_STEP_SUMMARY` is not available in GitLab. Use the MR
  summary and pipeline logs/artifacts instead. GitLab also sanitizes custom
  HTML and may render GitHub alert/relative-time markup as plain text; the
  underlying status wording and timestamps remain readable.
- Finding links use GitLab `#note_<id>` anchors and immutable `/-/blob/`
  permalinks, not GitHub `#discussion_r` links. Badge alt text is always
  present; choose `review_badges: emoji` or `text` if images are blocked.
- Native MR pipelines do not provide the same opened/reopened/synchronize/
  ready-for-review webhook action field. Automatic policy treats the first
  review as `opened` and subsequent pipelines as `synchronize`; it does not
  pretend to distinguish unavailable event actions.
- Commands need the explicit bridge/manual route above. The bundled bridge
  supports same-project MRs only and refuses forks safely. Full-security
  audit creates a report-only stacked MR; fixes remain an explicit
  `@droid fix` action rather than silently applying security patches.
- Droid never uses MR approval APIs or changes approval rules. Feedback
  reactions, learnings, `@droid remember`, and an undocumented Open in Droid
  URL scheme are not part of this release.

## Rendered examples and validation

[Rendered fixture previews](review-ux-preview.md) show all shared summary
states, inline bodies, check output and full-security reports. GitLab uses
the same deterministic renderer with MR links and terminology. Tests run
against local mocked API boundaries, including actual prepare/post/finalize
entrypoints, authorization, ref/default-branch guards, concurrent updates,
and bridge request handling. No real MR notes, commits, pushes, or pipelines
are created during validation.

## Advanced: Model overrides

<details>
<summary>Only needed if your organization requires a specific model provider</summary>

Most projects should use `review_depth` and leave these inputs empty. The
component also accepts `review_model` and `reasoning_effort`, which take
priority over the depth preset. If you set `review_model`, use a provider
tier alias (for example `openai-latest-premium` or `anthropic-latest-balanced`) so reviews keep picking
up new models. See
[Advanced: Model Overrides](../README.md#advanced-model-overrides) for the
full list and how model policy applies.

</details>
