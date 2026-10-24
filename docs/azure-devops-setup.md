# Azure DevOps Setup

Droid reviews Azure Repos pull requests from an Azure Pipelines job. It
delivers the same review as the GitLab component: a two-pass review
(candidate generation, then validation), inline PR threads on the changed
lines, a sticky tracking comment with status and telemetry, optional
security review, and a `deep` / `shallow` depth preset. `@droid`
mentions are not supported on Azure DevOps.

Supported:

- Azure DevOps Services (`https://dev.azure.com/{org}/` and
  `https://{org}.visualstudio.com/`).
- Azure DevOps Server 2020 and newer (collection URLs such as
  `https://ado.contoso.com/tfs/DefaultCollection/`).
- Azure Repos Git repositories. GitHub or Bitbucket repositories built by
  Azure Pipelines are not supported by this flow.

The runtime calls the Azure DevOps REST API with `api-version=6.0`, which
is GA on Services and on Server 2020+. Override it with an
`AZURE_DEVOPS_API_VERSION` pipeline variable only if you need to.

## How it runs

Azure Repos ignores the YAML `pr:` trigger, so PR runs come from a
**Build validation branch policy** on the target branch. Each run:

1. Skips anything that is not a PR build, draft PRs (unless
   `REVIEW_DRAFTS` is `"true"`), and PRs that are not active.
2. Creates the tracking comment on the PR, or reuses the one from an
   earlier run. A thread is only reused when its first comment was written
   by the identity the token acts as (read from `_apis/connectionData`);
   a pasted marker or a thread property set by someone else is ignored, and
   if the identity cannot be read a new thread is created.
3. Builds the diff locally from the PR iteration's merge base and source
   commit, and checks out the source commit.
4. Runs `droid exec` twice (candidates, then validator). Both passes start
   without any Azure DevOps credential in their environment and without
   any tool that can write to the PR. That is hygiene, not isolation: the
   passes keep `Execute`, run as the same OS user as the job, and could
   read the job's variables from their parent processes. Treat the job like
   any other job that runs untrusted code, and scope its credentials.
5. Posts the approved findings as PR threads through the REST API, then
   updates the tracking comment with the outcome.

The steps that hold the Azure DevOps token run bun from the droid-action
checkout with `--config=/dev/null --env-file=/dev/null`, so a PR's
`bunfig.toml` or `.env` never runs with the token. Everything that leaves
the job is redacted of `System.AccessToken`, `AZURE_DEVOPS_PAT`,
`AZURE_DEVOPS_EXT_PAT`, and `FACTORY_API_KEY`, including their Basic
`Authorization` encoding (`base64(":" + token)`), and of credentials
recognizable by format: PR threads, the tracking comment's error details,
API error messages, and the debug artifact.

The review passes can rewrite the state file the later steps read, so the
post steps take the collection, project, repository, and pull request from
the pipeline's own variables and stop if the state file disagrees. The final
step re-checks that the tracking thread named in the state file was written
by the token's identity before editing it.

## 1. Add the pipeline file

Copy [`azure-devops/droid-review.yml`](../azure-devops/droid-review.yml)
into your repository, for example at `azure-pipelines/droid-review.yml`:

```yaml
# Droid automated code review for Azure Repos pull requests.
#
# Copy this file into your repository (e.g. azure-pipelines/droid-review.yml),
# create a pipeline from it, and add it to the target branch as a Build
# validation branch policy. Azure Repos ignores `pr:` triggers, so the policy
# is what runs it on pull requests. See docs/azure-devops-setup.md.
#
# Self-hosted agents (always on Azure DevOps Server): replace the pool with
#   pool:
#     name: <your agent pool>
# The agent needs Linux or macOS with bash, git, and curl (plus unzip when
# bun is not installed).
trigger: none
pr: none

pool:
  vmImage: ubuntu-latest

variables:
  # Holds the secret FACTORY_API_KEY (and optionally AZURE_DEVOPS_PAT).
  - group: droid-review
  - name: DROID_ACTION_REPO
    value: https://github.com/Factory-AI/droid-action.git
  - name: DROID_ACTION_REF
    value: main

steps:
  - checkout: self
    fetchDepth: 0
    persistCredentials: false
    clean: true

  - bash: |
      set -euo pipefail
      # Created first so the artifact step below always has a directory.
      mkdir -p "$AGENT_TEMPDIRECTORY/droid-debug"
      DROID_ACTION_DIR="$AGENT_TEMPDIRECTORY/droid-action"
      rm -rf "$DROID_ACTION_DIR"
      git clone --quiet --depth 1 --branch "$DROID_ACTION_REF" "$DROID_ACTION_REPO" "$DROID_ACTION_DIR"
      bash "$DROID_ACTION_DIR/azure-devops/run-review.sh"
    displayName: Droid code review
    env:
      FACTORY_API_KEY: $(FACTORY_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      AZURE_DEVOPS_PAT: $(AZURE_DEVOPS_PAT)
      AUTOMATIC_REVIEW: "true"
      AUTOMATIC_SECURITY_REVIEW: "false"
      REVIEW_DEPTH: deep
      INCLUDE_SUGGESTIONS: "true"
      REVIEW_DRAFTS: "false"
      FORK_PULL_REQUESTS: skip

  # Build artifacts work on Services and Server alike; the `publish`
  # shortcut (Pipeline Artifacts) is Services-only.
  - task: PublishBuildArtifacts@1
    displayName: Publish Droid debug artifacts
    condition: always()
    continueOnError: true
    inputs:
      PathtoPublish: $(Agent.TempDirectory)/droid-debug
      ArtifactName: droid-debug-$(System.JobAttempt)
      publishLocation: Container
```

The file is self-contained: it clones droid-action at `DROID_ACTION_REF`
at run time, so no GitHub service connection or cross-project repository
permission is needed, and fixes reach you without editing the file. Pin a
release tag in `DROID_ACTION_REF` if you want fully reproducible runs.
On Azure DevOps Server or restricted networks, point `DROID_ACTION_REPO`
at an internal mirror.

Keep `fetchDepth: 0`: the diff is computed from the local clone. Also
clear any "Shallow fetch" override in the pipeline's settings.

### Agent pool and requirements

`vmImage: ubuntu-latest` uses Microsoft-hosted agents. For self-hosted
agents (always on Azure DevOps Server) replace the pool with:

```yaml
pool:
  name: <your agent pool>
```

Self-hosted agents need:

- Linux or macOS, x64 or arm64. Windows agents are not supported.
- `bash`, `git`, `curl`, and `sha256sum` or `shasum`. `unzip` is only
  needed when bun is not preinstalled.
- bun 1.2.11 runs the TypeScript steps. If `bun` is not on `PATH`, the
  script installs it into `~/.bun`. Node.js is not required.
- The droid CLI is installed into `~/.local/bin` when `droid` is not
  already on `PATH`.
- HTTPS egress to your collection URL, `github.com` (unless you mirror
  droid-action), `registry.npmjs.org`, `app.factory.ai`,
  `api.factory.ai`, `downloads.factory.ai`, and `bun.sh` (only when bun
  is not preinstalled).

## 2. Variables and secrets

Create a variable group (Pipelines > Library) named `droid-review`:

| Variable           | Required | Notes                                                                                          |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `FACTORY_API_KEY`  | Yes      | Secret. Generate at <https://app.factory.ai/settings/api-keys>.                                |
| `AZURE_DEVOPS_PAT` | No       | Secret. A PAT with **Code (Read & write)**. When set, review comments are posted as its owner. |

Authorize the pipeline to use the group (the first run otherwise waits on
"This pipeline needs permission to access a resource").

Secret variables are never exposed to scripts automatically, which is why
the pipeline maps them in `env:`. When `AZURE_DEVOPS_PAT` does not exist,
Azure Pipelines passes the literal text `$(AZURE_DEVOPS_PAT)`; the runtime
treats that as unset.

## 3. Permissions

By default the review posts with `$(System.AccessToken)` as the build
service identity:

- `{Project} Build Service ({org})` when "Limit job authorization scope to
  current project" is on (the default), or
- `Project Collection Build Service ({org})` when it is off.

That identity needs **Contribute to pull requests** on the repository:
Project settings > Repositories > Security > select the identity > set
"Contribute to pull requests" to Allow. Without it, posting fails with
`TF401027: You need the Git 'PullRequestContribute' permission`.

## 4. Create the pipeline and the branch policy

1. Pipelines > New pipeline > Azure Repos Git > your repository > Existing
   Azure Pipelines YAML file > pick the file > Save (do not run).
2. Repos > Branches > target branch (e.g. `main`) > Branch policies >
   Build validation > + > select the pipeline. Recommended: trigger
   Automatic, policy requirement **Optional**, build expiration
   **Never**. Optional keeps a Factory outage from blocking merges.
   If you make the policy **Required**, also set `REVIEW_DRAFTS: "true"`
   and `FORK_PULL_REQUESTS: fail` (see Drafts and Fork pull requests
   below).

The `/install-code-review` skill in the Droid CLI automates these steps
through the REST API, including org-wide rollout across repositories.

## Inputs

Set these in the review step's `env:`:

| Variable                                                               | Default                              | Description                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMATIC_REVIEW`                                                     | `"true"`                             | Run code review on PR builds.                                                                                                                           |
| `AUTOMATIC_SECURITY_REVIEW`                                            | `"false"`                            | Also run the security-reviewer subagent. Findings are prefixed `[security]`.                                                                            |
| `REVIEW_DEPTH`                                                         | `deep`                               | `deep` (thorough) or `shallow` (fast).                                                                                                                  |
| `REVIEW_MODEL` / `REASONING_EFFORT`                                    | `""`                                 | Advanced overrides of the depth preset.                                                                                                                 |
| `INCLUDE_SUGGESTIONS`                                                  | `"true"`                             | Allow suggestion blocks in review comments.                                                                                                             |
| `REVIEW_DRAFTS`                                                        | `"false"`                            | Review draft PRs too. Set it to `"true"` whenever the build policy is Required (blocking); see Drafts below.                                            |
| `FORK_PULL_REQUESTS`                                                   | `skip`                               | `skip` passes fork PR builds without a review; `fail` fails them. Set it to `fail` whenever the build policy is Required; see Fork pull requests below. |
| `SECURITY_BLOCK_ON_CRITICAL` / `SECURITY_BLOCK_ON_HIGH`                | `"true"` / `"false"`                 | Accepted for parity with GitLab; currently informational only.                                                                                          |
| `DROID_SETTINGS`                                                       | `""`                                 | Droid Exec settings as JSON or a path to a JSON file.                                                                                                   |
| `ORG_GUIDELINES_SOURCE` / `ORG_GUIDELINES_REF` / `ORG_GUIDELINES_PATH` | `""` / `""` / `review-guidelines.md` | Org-wide guidelines from a local file, a public http(s) URL, or a git clone URL. The GitLab-only `group/repo` shorthand is ignored with a warning.      |

## What you get

- **Inline PR threads** on the changed lines, status Active, prefixed with
  priority tags (`P0`-`P3`). Findings that cannot be anchored to a diff
  line are posted as general PR comments naming `path:line`. If your
  branch has the "Check for comment resolution" policy, these threads must
  be resolved before completing the PR.
- **A tracking comment** (a general thread with no status, so it never
  blocks comment resolution) that shows progress, the build link, posting
  counts, turns, duration, and session IDs.
- **A build artifact** `droid-debug-<attempt>` (PublishBuildArtifacts, so it works on Server too) with prompts, the
  candidate and validated JSON, and the `droid exec` logs. It is a redacted
  copy with symlinks skipped; if redaction fails, the artifact is empty.
  Anyone who can view the build can download it.

Fork pull requests: Droid never reviews them, because Azure Pipelines
withholds secrets from fork builds and the job should not run fork code
with a token that can write to the PR. Nothing is posted to a fork PR in
either mode. `FORK_PULL_REQUESTS` decides what the build reports:

- `skip` (default): the build succeeds without a review. With an Optional
  policy that is harmless. With a **Required** policy it satisfies the
  policy, so a fork PR can be completed without any review.
- `fail`: the build fails with an error explaining that the review cannot
  run on fork PRs. Use this whenever the policy is Required. The trade-off
  is that fork PRs cannot be completed while the policy is Required, the
  same as a GitHub required workflow on fork PRs; a maintainer has to
  bypass the policy or recreate the PR from a branch in the repository.

Drafts: by default draft PRs are skipped, and the run still succeeds.
Azure DevOps does not re-run build policies when a draft is published, so
that skipped run keeps satisfying the policy until the next push. With an
Optional policy this only delays the review. With a **Required** (blocking)
policy it means a draft published without a new push can be completed
without any review, so set `REVIEW_DRAFTS: "true"` in that case. Drafts are
then reviewed like any other PR.

## Troubleshooting

| Message                                                       | Cause and fix                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Missing Azure DevOps token`                                  | `SYSTEM_ACCESSTOKEN: $(System.AccessToken)` is not mapped and no `AZURE_DEVOPS_PAT` is set.                                                |
| `SYSTEM_ACCESSTOKEN was passed through as the literal string` | Typo in the `$(System.AccessToken)` mapping.                                                                                               |
| `FACTORY_API_KEY is not set`                                  | The variable group is not linked or authorized, or the secret is not mapped in `env:`. The check runs before anything is posted to the PR. |
| `Droid review cannot run on fork pull requests`               | `FORK_PULL_REQUESTS` is `fail` and the PR comes from a fork. Expected; see Fork pull requests above.                                       |
| `TF401027 ... 'PullRequestContribute' permission`             | Grant the build service identity "Contribute to pull requests" (section 3).                                                                |
| `Azure DevOps API 401`, or a 203 HTML sign-in page            | The PAT is invalid, expired, or missing the Code (Read & write) scope.                                                                     |
| `commit <sha> is not available in the checkout`               | Shallow clone. Keep `fetchDepth: 0` and clear the pipeline's "Shallow fetch" setting.                                                      |
| `unsupported-repository-provider` in the log                  | The pipeline builds a repository that is not Azure Repos Git.                                                                              |
