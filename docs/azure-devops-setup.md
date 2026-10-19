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

1. Skips anything that is not a PR build, draft PRs, and PRs that are not
   active.
2. Creates (or reuses) the tracking comment on the PR.
3. Builds the diff locally from the PR iteration's merge base and source
   commit, and checks out the source commit.
4. Runs `droid exec` twice (candidates, then validator). Both passes run
   without any Azure DevOps credential in their environment and without
   any tool that can write to the PR.
5. Posts the approved findings as PR threads through the REST API, then
   updates the tracking comment with the outcome.

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

The `/install-code-review` skill in the Droid CLI automates these steps
through the REST API, including org-wide rollout across repositories.

## Inputs

Set these in the review step's `env:`:

| Variable                                                               | Default                              | Description                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMATIC_REVIEW`                                                     | `"true"`                             | Run code review on PR builds.                                                                                                                      |
| `AUTOMATIC_SECURITY_REVIEW`                                            | `"false"`                            | Also run the security-reviewer subagent. Findings are prefixed `[security]`.                                                                       |
| `REVIEW_DEPTH`                                                         | `deep`                               | `deep` (thorough) or `shallow` (fast).                                                                                                             |
| `REVIEW_MODEL` / `REASONING_EFFORT`                                    | `""`                                 | Advanced overrides of the depth preset.                                                                                                            |
| `INCLUDE_SUGGESTIONS`                                                  | `"true"`                             | Allow suggestion blocks in review comments.                                                                                                        |
| `SECURITY_BLOCK_ON_CRITICAL` / `SECURITY_BLOCK_ON_HIGH`                | `"true"` / `"false"`                 | Accepted for parity with GitLab; currently informational only.                                                                                     |
| `DROID_SETTINGS`                                                       | `""`                                 | Droid Exec settings as JSON or a path to a JSON file.                                                                                              |
| `ORG_GUIDELINES_SOURCE` / `ORG_GUIDELINES_REF` / `ORG_GUIDELINES_PATH` | `""` / `""` / `review-guidelines.md` | Org-wide guidelines from a local file, a public http(s) URL, or a git clone URL. The GitLab-only `group/repo` shorthand is ignored with a warning. |

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
  candidate and validated JSON, and the raw `droid exec` logs.

Fork pull requests are skipped before anything is posted: Azure Pipelines
withholds secrets from fork builds, and the job should not run fork code
with a token that can write to the PR.

Drafts: Azure DevOps does not re-run build policies when a draft is
published. The review runs on the next push, or when you queue the check
again from the PR.

## Troubleshooting

| Message                                                       | Cause and fix                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Missing Azure DevOps token`                                  | `SYSTEM_ACCESSTOKEN: $(System.AccessToken)` is not mapped and no `AZURE_DEVOPS_PAT` is set.                                                |
| `SYSTEM_ACCESSTOKEN was passed through as the literal string` | Typo in the `$(System.AccessToken)` mapping.                                                                                               |
| `FACTORY_API_KEY is not set`                                  | The variable group is not linked or authorized, or the secret is not mapped in `env:`. The check runs before anything is posted to the PR. |
| `TF401027 ... 'PullRequestContribute' permission`             | Grant the build service identity "Contribute to pull requests" (section 3).                                                                |
| `Azure DevOps API 401`, or a 203 HTML sign-in page            | The PAT is invalid, expired, or missing the Code (Read & write) scope.                                                                     |
| `commit <sha> is not available in the checkout`               | Shallow clone. Keep `fetchDepth: 0` and clear the pipeline's "Shallow fetch" setting.                                                      |
| `unsupported-repository-provider` in the log                  | The pipeline builds a repository that is not Azure Repos Git.                                                                              |
