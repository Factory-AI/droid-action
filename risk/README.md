# Droid PR risk assessment

> Internal and experimental. The inputs, outputs and behavior of this
> sub-action can change without notice, and Factory only answers it for
> repositories and workflows it has been set up to trust.

This sub-action asks Factory whether a pull request should be risk-assessed,
runs the judge Factory serves against the pull request's exact head commit,
and hands the answer back to Factory. Factory decides the outcome and
publishes it on the pull request. The action itself holds no judging rules:
the judge's instructions, tools and settings arrive from Factory at run time
and are never printed to the job log.

## How a run goes

1. **Begin.** The action tells Factory which pull request and run this is.
   Factory answers `skip`, `hold` or `judge`. For `skip` and `hold` the
   action stops there and succeeds.
2. **Judge.** For `judge`, the action installs the Droid CLI, mints a
   read-only GitHub token, fetches the exact base and head commits into the
   job's checkout, and runs one `droid exec` session over a temporary
   workspace that holds the diff, the changed-file list, the head checked out
   as a detached worktree, and the default branch's
   `.factory/pr-risk/guidelines.md` when the repository has one. The
   changed-file list and its counts are computed from the same two commits
   as the diff; it names at most 3,000 files and counts the rest.
3. **Settle.** The action reports the judged head and the judge's answer to
   Factory. A run that produced no answer is reported too, with a short
   reason, so the head is marked unavailable instead of keeping a stale
   result.

## Usage

```yaml
name: PR risk
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request to assess
        required: true

permissions:
  contents: read
  id-token: write

concurrency:
  group: pr-risk-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  risk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: Factory-AI/droid-action/risk@dev-internal
        with:
          factory_api_key: ${{ secrets.FACTORY_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
```

`persist-credentials: false` keeps the workflow token out of the checkout's
git configuration. The action does not use it, and removes it before the
judge runs when it finds it there (see
[What the judge can reach](#what-the-judge-can-reach)).

When the action runs after a review step in the same job, pass that step's
conclusion so Factory can tell whether the pull request is ready to assess:

```yaml
- uses: Factory-AI/droid-action/risk@dev-internal
  if: ${{ !cancelled() }}
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    review_outcome: ${{ steps.review.outcome }}
```

The pull request is taken from the `pull_request` event, from the pull
request of a `workflow_run` event, or from `pr_number`.

## Inputs

| Input                | Required | Default                       | Description                                                                                             |
| -------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `factory_api_key`    | yes      |                               | Factory API key. Used for the begin and settle requests and by the judge session.                       |
| `pr_number`          | no       | the event's pull request      | Pull request to assess.                                                                                 |
| `review_outcome`     | no       |                               | Conclusion of the review step that ran before this one: `success`, `failure`, `cancelled` or `skipped`. |
| `api_base_url`       | no       | `https://app.factory.ai`      | Factory API host that answers the begin and settle requests.                                            |
| `judge_api_base_url` | no       | the Droid CLI's default       | Factory API host for the judge session only.                                                            |
| `dry_run`            | no       | `false`                       | Tells Factory this is a dry run. A dry run can also run without `id-token: write`.                      |
| `manual`             | no       | `true` on `workflow_dispatch` | Marks the run as an explicit request to assess.                                                         |

## Outputs

| Output     | Description                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`   | What Factory asked this run to do: `skip`, `hold` or `judge`.                                                                                           |
| `outcome`  | Set after a judge run: `approve`, `doNotApprove`, `unavailable`, `stale_head`, `skipped`, `unknown`, or `failed` when the result could not be reported. |
| `head_sha` | The head commit Factory named for a `hold` or a `judge` run.                                                                                            |

The step fails when the outcome is `unavailable` or the result could not be
reported. `stale_head` means the pull request moved on while it was being
judged; nothing is published and the run for the newer head owns the result.
`skipped` means Factory took the report and published nothing; the step
passes and the job log gives Factory's reason.
`unknown` means Factory answered with a status added after this version of
the action; the step passes with a warning, and an action Factory asks for
that this version does not know is likewise a `skip` with a warning.

## Requirements

- `id-token: write`. The job's OIDC token proves to Factory which workflow is
  asking, and is exchanged for the read-only GitHub token the judge uses.
- `contents: read`, and a checkout of the repository earlier in the job, made
  over HTTPS and not with an SSH key. Any fetch depth works: the action
  fetches the commits it needs and deepens a shallow checkout itself.
- The Factory Droid GitHub App installed on the repository.
- A Linux or macOS runner with `bash` and `git`. `gh` and `ripgrep` are used
  by the judge when present; on Linux the action installs whichever is
  missing.

## What the judge can reach

The judge session runs commands from the pull request (installs, builds,
tests), so the action limits what it is given:

- Its environment is an allow-list: `PATH`, `HOME`, `TMPDIR`,
  `XDG_CONFIG_HOME`, the Factory API key, and a GitHub token for `gh`.
- That GitHub token is minted for this run with read access to contents,
  pull requests, issues, checks and statuses, and is revoked when the run
  ends. Neither the workflow token nor any token input reaches the session,
  and a `GITHUB_TOKEN` or `GH_TOKEN` set in the job's environment is not
  read.
- The OIDC request credentials are removed from the step before the session
  starts.
- A token the checkout left in the repository's git configuration, as
  `actions/checkout` does unless it is given `persist-credentials: false`, is
  removed before the session starts: from the checkout, from any file its
  configuration includes, and from its submodules. It is not put back, so a
  later step in the same job that relies on it has to bring its own
  credential. A checkout that keeps an SSH key is not judged, because the key
  file would stay readable; the run fails with
  `checkout_credentials_persisted`.
- The two steps that run after the judge (revoking the token and reporting
  to Factory) do not run from the action's checkout or look anything up on
  `PATH`. Each runs a copy of its script bundled before the judge started,
  after checking that neither the copy nor the Bun binary changed.

The session still runs as the job's user on the job's machine. Run this
action only for pull requests whose authors you would let run code in that
job, the same as for any workflow that builds a pull request with secrets
present.

## Dry runs

`dry_run: true` is passed to Factory with every request. A dry run may run in
a job without `id-token: write`; the judge then reads GitHub with the
workflow token instead of a minted one.

## When no verdict is produced

The assess step always leaves a result, and the settle step always reports
it unless the run was cancelled. A failed result carries one short reason,
for example `github_token_missing`, `evidence_git_failed`,
`checkout_credentials_persisted`, `judge_timeout`, `judge_exec_failed`,
`invalid_pr_risk_verdict`, `runner_died` or `unexpected`. The job log names
the reason; it never contains the judge's instructions or its answer.

## Running a judge offline

`src/entrypoints/risk-assess.ts` can run a judge file against a pull request
without calling Factory's risk endpoints, which is how a judge is tried out
before it is served:

```bash
export GH_TOKEN=...        # can read the pull request
export FACTORY_API_KEY=... # for the judge session

bun run src/entrypoints/risk-assess.ts \
  --judge ./judge.json \
  --repo owner/name \
  --pr 123 \
  --repo-dir ../name \
  --out ./out
```

`--repo-dir` is a clone of the repository whose `origin` is GitHub; its git
configuration, credentials included, is left as it is. The judge
file is JSON with `skill` (the judge's instructions; the pull request
snapshot replaces `{{PR_SNAPSHOT_JSON}}` in it, or is appended when the
placeholder is absent), `enabledTools`, `settings` (written as the session's
settings file), `scores` (each score's name with its `[min, max]` range), and
optionally `group` and `timeoutSeconds`. The result is written to
`<out>/pr-risk-result.json`, and the command exits non-zero when no verdict
was produced. `--droid-binary` selects a Droid CLI other than the one on
`PATH`; a relative path is taken from the directory the command is run in.
`FACTORY_API_BASE_URL` points the judge session at another host.
