# Bitbucket Setup

Droid reviews Bitbucket pull requests on both hosting variants:

| Variant                        | API                             | CI that runs the review                                           |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------- |
| Bitbucket Cloud                | `https://api.bitbucket.org/2.0` | Bitbucket Pipelines (`pull-requests:` trigger)                    |
| Bitbucket Data Center / Server | `<your server>/rest/api/1.0`    | Jenkins (Bitbucket Branch Source plugin), Bamboo, or any other CI |

What you get, matching the GitLab and GitHub integrations:

- A two-pass review (candidate generation, then validation) on every pull request update.
- Inline comments anchored to the changed lines. A finding on a line outside the diff is posted as a regular PR comment instead.
- One sticky tracking comment that shows progress, the review summary, comment counts, and run telemetry.
- An optional security reviewer running in parallel (`AUTOMATIC_SECURITY_REVIEW=true`); its findings are prefixed `[security]`.
- `REVIEW_DEPTH=deep` (default) or `shallow`.
- Draft pull requests are skipped unless `REVIEW_DRAFTS=true`.
- An optional `droid-review` commit build status for merge enforcement (`BUILD_STATUS=true`).

`@droid` mentions in PR comments are not supported on Bitbucket.

## How it runs

Every CI system runs the same two commands, with the action cloned to a directory outside the checkout under review:

```sh
git clone --depth 1 --branch "${DROID_ACTION_REF:-main}" https://github.com/Factory-AI/droid-action.git /tmp/droid-action
bash /tmp/droid-action/bitbucket/droid-review.sh
```

A fixed path such as `/tmp/droid-action` is fine in Bitbucket Pipelines, where every step gets a fresh container. On Jenkins or Bamboo agents that run several builds at once, use a per-build directory instead, as the [Jenkins](#jenkins) and [Bamboo](#bamboo) examples do. The script itself keeps its prompts, state, and results in a fresh `mktemp -d` directory per run, so concurrent runs never share files.

[`bitbucket/droid-review.sh`](../bitbucket/droid-review.sh) installs the Droid CLI (and bun, if missing), then:

1. `bitbucket-prepare` finds the pull request, creates or updates the tracking comment (before fetching the diff, so any later failure shows on the PR; an existing tracking comment is reused only if the token's own user wrote it; see the note on Cloud access tokens below), and writes the diff, existing comments, and description to disk.
2. `droid exec` pass 1 writes candidate findings.
3. `bitbucket-prepare-validator` builds the validation prompt.
4. `droid exec` pass 2 writes the approved findings.
5. `bitbucket-post-review` posts the approved findings through the Bitbucket REST API.
6. `bitbucket-update-comment-link` always runs last and renders the final tracking comment (and build status).

Both `droid exec` passes run without the Bitbucket credentials in their environment (including any other variable holding the same secret, such as Bamboo's `bamboo_..._SECRET`) and without any tool that can post to the pull request. The steps that hold the credentials run from the action checkout with `bun --config=/dev/null --env-file=/dev/null`, so `.env` or `bunfig.toml` files in the pull request are never loaded. Everything they publish (comments, error details, build statuses) has the job's credentials redacted. They keep `Execute` for investigating the code, so treat the review job like any CI job that builds untrusted code.

The agent needs `bash`, `git`, `curl`, and `bun` 1.2.x (the script installs bun if `unzip` is available). It needs outbound HTTPS to:

- `github.com`, to clone droid-action (or your mirror's host, if you change the clone URL).
- `registry.npmjs.org`, for `bun install` of droid-action's dependencies.
- `app.factory.ai`, for the Droid CLI installer script and the Factory API.
- `downloads.factory.ai`, for the Droid CLI binary and its checksum.
- `api.factory.ai`, for the Factory API that `droid exec` calls.
- Your Bitbucket API host: `api.bitbucket.org` on Cloud, or your server URL on Data Center.
- Only when bun is not preinstalled (Jenkins, Bamboo, or other CI): `bun.sh` for the installer, plus `github.com` and `release-assets.githubusercontent.com` for the bun release download.
- Only in the Pipelines templates: `deb.debian.org`, where the `oven/bun` image installs `git` and `curl` with `apt-get`.
- Only when `ORG_GUIDELINES_SOURCE` is a URL or git repository: that host.

**Pinning:** `DROID_ACTION_REF` is a branch or tag (not a SHA). Pin a release tag for reproducible runs. Set `DROID_ACTION_REPO` and change the clone URL to use a private mirror.

## Credentials

| Variable                                                 | Notes                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACTORY_API_KEY`                                        | Required. Generate at <https://app.factory.ai/settings/api-keys>.                                                                                                                                                                                                     |
| `DROID_BITBUCKET_TOKEN`                                  | Sent as `Authorization: Bearer`. Cloud: repository, project, or workspace **access token**. Data Center: **HTTP access token** (project, repository, or personal).                                                                                                    |
| `DROID_BITBUCKET_USERNAME` + `DROID_BITBUCKET_API_TOKEN` | Alternative, sent as HTTP Basic. Cloud **API token** with scopes; the username is your Atlassian account email. Also works with Data Center personal tokens. Bitbucket Cloud app passwords were permanently disabled on June 9, 2026; replace them with an API token. |

When both are set, the Bearer token wins. Store all of them as secured/masked variables. The names avoid the `BITBUCKET_` prefix that Pipelines uses for its own variables. Tokens are never printed.

Permissions:

- **Cloud access token:** `pullrequest:write` (read, comment on, and update pull requests) and `repository` (read commits; the `repository` scope does not cover pull requests, so both are needed). Add `repository:write` when `BUILD_STATUS=true`. Comments appear as the token's bot user.
- **Cloud API token:** `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`, `read:repository:bitbucket` (+ `write:repository:bitbucket` for build statuses). Write scopes do not imply the matching read scope, so request both.
- **Data Center HTTP access token:** Repository read (or Project read for a project-wide token) is enough to read, comment, and post build statuses. Comments appear as the token's bot user.

**Cloud access tokens and the tracking comment.** Droid reuses a tracking comment only when it can prove its own user wrote it, so a marker pasted by someone else is never taken over. Cloud access tokens cannot look up their own user (`GET /2.0/user` rejects them), so with an access token each run posts a fresh tracking comment and then deletes the earlier ones written by the same bot user (the author of the comment it just posted; comments with replies are kept). The PR still shows one tracking comment, but each run sends a new-comment notification. For a single tracking comment that is edited in place, use a Cloud API token with `DROID_BITBUCKET_USERNAME` (your Atlassian account email) and add the `read:user:bitbucket` scope.

The scope needed to post a Cloud build status (`repository:write`) and the Data Center permission for the repository-scoped build status endpoint (Repository read) follow Atlassian's documentation as of this writing; if a build status is refused with 403, grant the write level.

## Inputs

All inputs are environment variables; set them as CI variables or `export` them before the `bash` line.

| Variable                                                               | Default                                | Meaning                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMATIC_REVIEW`                                                     | `true`                                 | `false` turns the job into a no-op.                                                                                                                                                     |
| `AUTOMATIC_SECURITY_REVIEW`                                            | `false`                                | Run the security reviewer in parallel.                                                                                                                                                  |
| `REVIEW_DEPTH`                                                         | `deep`                                 | `deep` or `shallow`.                                                                                                                                                                    |
| `REVIEW_MODEL` / `REASONING_EFFORT`                                    | empty                                  | Advanced overrides of the depth preset.                                                                                                                                                 |
| `INCLUDE_SUGGESTIONS`                                                  | `true`                                 | Allow suggestion blocks in comments.                                                                                                                                                    |
| `REVIEW_DRAFTS`                                                        | `false`                                | Review draft pull requests too.                                                                                                                                                         |
| `BUILD_STATUS`                                                         | `false`                                | Post a `droid-review` build status on the PR head commit (in progress, then successful or failed). Blocking merges on it needs Bitbucket Cloud Premium or Data Center; see Enforcement. |
| `DROID_SETTINGS`                                                       | empty                                  | Droid Exec settings JSON, or a path to a JSON file.                                                                                                                                     |
| `ORG_GUIDELINES_SOURCE` / `ORG_GUIDELINES_REF` / `ORG_GUIDELINES_PATH` | empty / empty / `review-guidelines.md` | Organization review guidelines from a file path, an http(s) URL, or a git clone URL ending in `.git`.                                                                                   |

## Pull request context

`BITBUCKET_VARIANT` (`cloud` or `datacenter`) is detected automatically: Data Center when `BITBUCKET_SERVER_URL` is set or the PR URL is a Data Center URL, Cloud when `BITBUCKET_WORKSPACE` is set.

- **Bitbucket Pipelines:** nothing to configure. The script reads `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_PR_ID`, `BITBUCKET_COMMIT`, and links the tracking comment to the pipeline step.
- **Data Center**, first match wins:
  1. `BITBUCKET_SERVER_URL` (including any context path, e.g. `https://host/bitbucket`), `BITBUCKET_PROJECT_KEY`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_PR_ID`.
  2. A pull request URL in `DROID_PR_URL`, or Jenkins' `CHANGE_URL` (`<server>/projects/<KEY>/repos/<slug>/pull-requests/<id>`). Explicit variables override parts of it; when `BITBUCKET_SERVER_URL` names a different host than the URL, the review warns and calls `BITBUCKET_SERVER_URL`.
  3. The PR id from Bamboo `bamboo_repository_pr_key`, or from Jenkins `CHANGE_ID` only when `CHANGE_URL` is a Bitbucket pull request URL. Jenkins sets `CHANGE_ID` for GitHub and GitLab change requests too, so any other `CHANGE_ID` is ignored with a warning.
  4. The CI link from `DROID_BUILD_URL`, Jenkins `BUILD_URL`, or Bamboo `bamboo_resultsUrl`.

A build without a pull request id logs `Not a pull request build; skipping Droid review.` and exits successfully.

## Bitbucket Cloud

### Single repository

Copy [`bitbucket/pipelines/bitbucket-pipelines.yml`](../bitbucket/pipelines/bitbucket-pipelines.yml) to the repository root as `bitbucket-pipelines.yml`. If the repository already has one, add the step under `pipelines.pull-requests."**"` (append to the existing list if that pattern exists). Then:

1. Enable Pipelines: Repository settings → Pipelines → Settings, or `PUT /2.0/repositories/{workspace}/{repo}/pipelines_config` with `{"enabled": true}`.
2. Add secured repository variables `FACTORY_API_KEY` and `DROID_BITBUCKET_TOKEN`: Repository settings → Pipelines → Repository variables, or `POST /2.0/repositories/{workspace}/{repo}/pipelines_config/variables/` with `{"key": "...", "value": "...", "secured": true}`.
3. Open or update a pull request. The "Droid code review" step runs and the PR gets a tracking comment.

Secured variables are not available to pull requests from forks, so forked PRs fail with `Missing Bitbucket credentials.`

### Whole workspace

**Requires the Bitbucket Cloud Premium plan.** Sharing Pipelines configurations across repositories (`export: true` / `import:`) is a Premium-only feature ([Atlassian: Share Pipelines Configurations](https://support.atlassian.com/bitbucket-cloud/docs/share-pipelines-configurations/)). On Free or Standard, use the [single-repository](#single-repository) file in every repository instead.

With Premium, shared pipeline configurations let one repository own the pipeline definition:

1. Create a repository in the workspace (for example `droid-pipelines`) and commit [`bitbucket/pipelines/shared-pipeline.yml`](../bitbucket/pipelines/shared-pipeline.yml) as its `bitbucket-pipelines.yml` (it sets `export: true`).
2. Add secured **workspace** variables `FACTORY_API_KEY` and `DROID_BITBUCKET_TOKEN` (a workspace access token): Workspace settings → Workspace variables, or `POST /2.0/workspaces/{workspace}/pipelines-config/variables`.
3. In each repository, enable Pipelines and commit:

   ```yaml
   pipelines:
     pull-requests:
       "**":
         import: droid-pipelines:main:droid-review
   ```

Imported pipelines use the consuming repository's variables plus workspace variables. Changing the central definition updates every repository on its next PR build. An `import` replaces the whole step list for that pattern, so a repository with its own pull-request steps must keep them under a different pattern.

### Enforcement

Add a branch restriction that requires passing builds: Repository settings → Branch restrictions, or `POST /2.0/repositories/{workspace}/{repo}/branch-restrictions` with `{"kind": "require_passing_builds_to_merge", "pattern": "main", "value": 1}`.

**Enforcement requires the Bitbucket Cloud Premium plan.** Only Premium can turn on "Prevent a merge with unresolved merge checks"; on Free and Standard, a failed or missing build only shows a warning and the PR can still be merged. Enforcement proves the review ran successfully; it does not block on findings.

## Bitbucket Data Center

### Jenkins

1. Install the **Bitbucket Branch Source** plugin, register your Data Center server under Manage Jenkins → System → Bitbucket Endpoints, and let the plugin manage webhooks so PR events trigger builds.
2. Create a Multibranch Pipeline (one repository) or a Bitbucket Team/Project organization folder (every repository in a project) with "Discover pull requests" enabled.
3. Add "Secret text" credentials `factory-api-key` and `bitbucket-droid-token`.
4. Commit [`bitbucket/examples/Jenkinsfile`](../bitbucket/examples/Jenkinsfile) (or add its stage to your existing `Jenkinsfile`).

The example clones the action into `$WORKSPACE@tmp/droid-action`, Jenkins' per-workspace scratch directory, so concurrent builds never share it and it stays out of the checkout under review. It runs the `oven/bun` container as root only to `apt-get install` git and curl, then hands workspace files back to the workspace owner. With an agent image that already has bash, git, curl, and bun, drop `args '-u root'`, the `apt-get` line, and the `chown` trap.

The plugin builds each pull request as `PR-<id>` and sets `CHANGE_URL`, `CHANGE_ID`, and `BUILD_URL`, which is all the review needs. With other plugins or generic webhook triggers, set `BITBUCKET_SERVER_URL`, `BITBUCKET_PROJECT_KEY`, `BITBUCKET_REPO_SLUG`, and `BITBUCKET_PR_ID` (or `DROID_PR_URL`) in the pipeline's `environment` block.

### Bamboo

Link the Data Center repository, enable plan branches for pull requests, and use [`bitbucket/examples/bamboo-specs.yml`](../bitbucket/examples/bamboo-specs.yml) as `bamboo-specs/bamboo.yml`. Fill in the server URL, project key, and repository slug variables, and add secret variables `FACTORY_API_KEY_SECRET` and `DROID_BITBUCKET_TOKEN_SECRET`. The example clones the action into a fresh `mktemp -d` directory per build and removes it afterwards, so concurrent builds on one agent never collide.

### Other CI systems

Export the context variables from [Pull request context](#pull-request-context) plus the credentials, then run the two commands from [How it runs](#how-it-runs).

### Enforcement

Run the review with `BUILD_STATUS=true` so it posts a build status with the fixed key `droid-review`, then add a **Required builds** merge check (Data Center 7.14+) for that key in repository or project settings. The `Minimum successful builds` merge check also works but counts any build. Enforcement proves the review ran successfully; it does not block on findings.

## Troubleshooting

| Message                                                         | Cause                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Missing Bitbucket credentials.`                                | No token variable reached the job (missing, or withheld from a forked PR).                                                                                                                                               |
| `... was passed through as the literal string "$..."`           | The CI passed an unexpanded variable reference (`$NAME`, `${NAME}`, Bamboo's `${bamboo.NAME}`).                                                                                                                          |
| `Bitbucket truncated the pull request diff`                     | The diff exceeds the Data Center server's diff size limit. The review covers only part of the changes, and the tracking comment says so.                                                                                 |
| `ignoring Jenkins CHANGE_ID`                                    | Jenkins built a change request whose `CHANGE_URL` is not a Bitbucket pull request (for example a GitHub PR). Set `BITBUCKET_PR_ID` to review it anyway.                                                                  |
| `Missing FACTORY_API_KEY.`                                      | The Factory key is not set for this job.                                                                                                                                                                                 |
| `Could not determine the Bitbucket variant.`                    | Not running in Pipelines and no Data Center variables or PR URL are set.                                                                                                                                                 |
| `Missing Bitbucket Data Center context: ...`                    | The server URL, project key, or repository slug could not be resolved.                                                                                                                                                   |
| `Bitbucket API 401`                                             | Bad or expired token, or the wrong scheme: an API token needs `DROID_BITBUCKET_USERNAME` set to your Atlassian account email (Basic), and an access token goes in `DROID_BITBUCKET_TOKEN`. App passwords no longer work. |
| `Bitbucket API 403`                                             | The token lacks a scope or repository permission.                                                                                                                                                                        |
| `Bitbucket API 404`                                             | Wrong workspace, project, repository, or PR, or the token cannot see the repository.                                                                                                                                     |
| `bitbucket-post-review: all N approved comments failed to post` | Every inline and fallback comment was refused; check the token's permissions.                                                                                                                                            |

Debug output (prompts, state, pass logs) is staged in `.droid-debug/` in the working directory, with the Bitbucket and Factory credentials redacted and symlinks left out; the templates keep it as a build artifact. If staging fails, the directory is removed rather than uploaded unredacted. The pass logs hold the output of every command Droid ran, so treat the artifact as sensitive anyway.
