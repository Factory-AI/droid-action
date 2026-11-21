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
   read-only GitHub token, downloads the `droid-review` worker
   (see [The worker](#the-worker)), and fetches into the job's checkout the
   commits a judgment reads: the base, the pull request's head, the tip of
   the default branch, and for a re-check the two commits of the earlier
   verdict. It then runs the worker on them. The worker builds the evidence
   from those commits alone: the diff, the changed-file list with its counts (at
   most 3,000 files are named and the rest counted), the head checked out
   in a repository of its own, and the default branch's
   `.factory/pr-risk/guidelines.md` when the repository has one. It runs the
   judge in one Droid session, checks the answer against the judge's
   contract, and gives an answer that breaks it one more session.
3. **Settle.** The action reports the judged head and the judge's answer to
   Factory. The answer is JSON with `verdict`, `brief`, `details`, and the
   judge's declared `scores`; a judge Factory serves with
   `"verdictField": "omitted"` is decided by risk level alone, so its
   answer carries no `verdict`. A run that produced no answer is reported too, with a short
   reason, so the head is marked unavailable instead of keeping a stale
   result.

### Re-checking an earlier verdict

Every begin request says the action can re-check an earlier verdict
(`capabilities: ["incremental"]`). Factory may then answer `judge` with an
`incremental` block naming the prior head, its base and the prior verdict.
The action fetches those two commits as well and hands the block to the
worker unchanged. Next to the full evidence, the worker then lays out the
pull request's own diff as it stood at the prior head, the head-tree changes
since the prior head on every path whose own change moved (paths the base
alone changed are left out), and a focus list of those paths. When that
evidence cannot be built, for example because the repository no longer has
the prior commits, the head is judged afresh and the result says so
(`mode: "full"`, `incrementalFallback`).

The prior verdict may be an approval or a decline (`prior.outcome`). After a
decline, Factory also sends the concerns it rested on (`prior.concerns`, each
with an id such as `c1`). A re-check answers with the usual verdict plus the
`checks` it ran and, after a decline, `resolvedConcerns`. Factory approves a
re-check only when a passing check covers a path that changed since the
prior head and, after a decline, every concern is resolved.

- `mode: "enforce"`: the judge re-checks the prior verdict, and its answer is
  the result. When that answer approves, the worker runs each check it cited
  again before it reports, and Factory takes the exit codes from that run
  (`checkRuns`), never from the verdict. The checks run in a clean copy of
  the judge's workspace with a fresh checkout of the head, with none of the
  job's credentials, for at most 5 minutes each and 10 for all of them, and
  stop at the first one that passes and covers a path that changed since the
  prior head.
- `mode: "shadow"`: the head is judged afresh as without the block, and the
  re-check runs at the same time in a workspace and sessions of its own. Its
  answer is sent as a separate `shadow` result, which Factory records but
  never publishes. A re-check that ends without an answer is sent as a
  failed `shadow` and never changes the main result, and a shadow answer too
  large to send is dropped before the main one is.

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
          worker_token: ${{ secrets.DROID_REVIEW_READ_TOKEN }}
          pr_number: ${{ inputs.pr_number }}
```

`persist-credentials: false` keeps the workflow token out of the checkout's
git configuration. The action does not use it, and removes it before the
judge runs when it finds it there (see
[What the judge can reach](#what-the-judge-can-reach)).

When the action runs after a review step in the same job, pass that step's
conclusion so Factory can tell whether the pull request is ready to assess,
and what it read of `.factory/review.yaml`, so Factory reads the pull
request's rules at the same commit and reads nothing when the file has none:

```yaml
- uses: Factory-AI/droid-action/risk@dev-internal
  if: ${{ !cancelled() }}
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    worker_token: ${{ secrets.DROID_REVIEW_READ_TOKEN }}
    review_outcome: ${{ steps.review.outcome }}
    review_base_sha: ${{ steps.review.outputs.review_base_sha }}
    review_has_rules: ${{ steps.review.outputs.review_has_rules }}
```

Without both of the last two, Factory reads the rules from the tip of the
base branch.

## Bundled with the review

The full action runs the same steps after its review when `risk_assessment`
is `true`, so one step does both:

```yaml
- uses: Factory-AI/droid-action@dev-internal
  with:
    factory_api_key: ${{ secrets.FACTORY_API_KEY }}
    automatic_review: true
    risk_assessment: true
    worker_token: ${{ secrets.DROID_REVIEW_READ_TOKEN }}
```

The assessment starts once the review's steps have ended and its GitHub App
token is revoked. The review's model session has run with the pull request
checked out by then, so every risk script runs from a copy bundled before
the review started, with the Bun that bundled it, after checking that
neither changed; nothing is run from the action's checkout or found on
`PATH`. It still runs when the review failed, and Factory is told
how the review ended: `success`, `failure`, or `skipped` when the event gave
the action nothing to review, as on a `workflow_dispatch` that only asks for
an assessment. A cancelled run assesses nothing. On a comment left on a pull
request, that pull request is the one assessed.

Factory is also told what the review read of `.factory/review.yaml` before
it started: the pull request's base commit, and whether the file there has
a `rules` key. Factory reads the pull request's rules at that commit, so
one version of the file configures the review and the assessment, and reads
nothing when the file has no rules. The full action also has both as
outputs, `review_base_sha` and `review_has_rules`, for a workflow that runs
this sub-action as its own step.

The inputs are this sub-action's with a `risk_` prefix: `risk_pr_number`,
`risk_api_base_url`, `risk_judge_api_base_url`, `risk_dry_run` and
`risk_manual`. `factory_api_key` and `worker_token` are shared with the
review, which runs in the same worker, and there is no `review_outcome`,
`review_base_sha` or `review_has_rules`. The outputs are `risk_action`,
`risk_outcome` and `risk_head_sha`. The full action downloads the worker once,
before its first model session starts. Its prepare step is handed every input
at once, `worker_token` among them, and also ends before that session starts.
Everything else on this page applies unchanged.

The pull request is taken from the `pull_request` event, from the pull
request of a `workflow_run` event, or from `pr_number`.

## Inputs

| Input                | Required | Default                       | Description                                                                                                          |
| -------------------- | -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `factory_api_key`    | yes      |                               | Factory API key. Used for the begin and settle requests and by the judge session.                                    |
| `worker_token`       | yes      |                               | GitHub token that can read the `droid-review` release the worker is downloaded from (see [The worker](#the-worker)). |
| `pr_number`          | no       | the event's pull request      | Pull request to assess.                                                                                              |
| `review_outcome`     | no       |                               | Conclusion of the review step that ran before this one: `success`, `failure`, `cancelled` or `skipped`.              |
| `review_base_sha`    | no       |                               | The review step's `review_base_sha` output: the base commit it read `.factory/review.yaml` at.                       |
| `review_has_rules`   | no       |                               | The review step's `review_has_rules` output: whether that file has a `rules` key.                                    |
| `api_base_url`       | no       | `https://app.factory.ai`      | Factory API host that answers the begin and settle requests.                                                         |
| `judge_api_base_url` | no       | the Droid CLI's default       | Factory API host for the judge session only.                                                                         |
| `dry_run`            | no       | `false`                       | Tells Factory this is a dry run. A dry run can also run without `id-token: write`.                                   |
| `manual`             | no       | `true` on `workflow_dispatch` | Marks the run as an explicit request to assess.                                                                      |

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
- A GitHub token that can read the private repository the worker is released
  from, passed as `worker_token` (see [The worker](#the-worker)).
- A Linux or macOS runner with `bash` and `git`. `gh` and `ripgrep` are used
  by the judge when present; on Linux the action installs whichever is
  missing.

## The worker

The judge session is run by `droid-review`, a worker built as one file. Each
version of the action names one build of it: the address of the file and the
SHA-256 digest of its bytes. A step of its own downloads the file into the
runner's temporary directory, where only the job's user can read it, and
ends. The assess step then reads the file, runs those bytes only when they
have that digest, and deletes the copy it ran when the run ends. The worker
runs under the Bun the step itself runs under, never one found on `PATH`.

The file is an asset of a release in a private repository, which GitHub
serves only to a token that can read that repository. `worker_token` is that
token, and the download step is the only step of this sub-action given it. That
step sends it to GitHub's API with the request for the file and nowhere
else: the storage GitHub redirects the download to is not sent it, and the
job log never quotes it. The step has ended before the assess step starts,
so the worker, the judge session and everything the session runs start
after the one process that was given the token is gone. Without the token,
or with one that cannot read the release, the download step warns, the
assess step finds no worker to run, and the run fails with
`worker_unavailable`.

The worker is handed the commits to judge, the judge Factory served, and the
credentials listed under
[What the judge can reach](#what-the-judge-can-reach). It fetches nothing and
leaves the job's checkout as it found it. It writes one report, which says
how the run ended; the action tells Factory about an answer as it stands and
about every other ending as a failure with a reason (see
[When no verdict is produced](#when-no-verdict-is-produced)).

## What the judge can reach

The judge session runs commands from the pull request (installs, builds,
tests), so the action limits what it is given:

- The worker's environment is an allow-list: `PATH`, `HOME`, `TMPDIR`, the
  Factory API key, and a GitHub token for `gh`. The session it starts gets
  `PATH`, those two credentials, and a home directory of its own.
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

The session still runs as the job's user on the job's machine, where a
process can read the environment of another process of the same user. The
assess step's own environment holds the Factory API key, the read-only
GitHub token and whatever the job sets for every step. It does not hold
`worker_token`: the one step given that token has ended before the session
starts. Two things stay out of this action's hands. A process already
running as the job's user when the download step starts, left behind by an
earlier step of the job, can read that step's environment while it runs. And the runner holds every secret of the job in
its own memory, as it does for any action. Run this action only for pull
requests whose authors you would let run code in that job, the same as for
any workflow that builds a pull request with secrets present.

## Dry runs

`dry_run: true` is passed to Factory with every request. A dry run may run in
a job without `id-token: write`; the judge then reads GitHub with the
workflow token instead of a minted one.

## When no verdict is produced

The assess step always leaves a result, and the settle step always reports
it unless the run was cancelled. A failed result carries one short reason:

| Reason                                                 | What happened                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `plan_unreadable`, `env_missing`                       | The step could not read the plan the begin step left, or a variable the action sets.                          |
| `github_token_missing`                                 | The step had no token to read the pull request with.                                                          |
| `pr_risk_default_branch_unresolved`                    | The repository's default branch could not be found.                                                           |
| `evidence_git_failed`                                  | The commits could not be fetched, or the worker could not resolve them.                                       |
| `checkout_credentials_persisted`                       | The checkout keeps an SSH key the judge could read.                                                           |
| `worker_unavailable`                                   | The worker could not be downloaded with `worker_token`, or its bytes do not have the digest the action names. |
| `worker_no_report`                                     | The worker refused its input or stopped without a report. The job log quotes what it said.                    |
| `worker_report_unreadable`                             | The worker's report could not be read or understood, or answers about commits other than the planned ones.    |
| `judge_exec_failed`                                    | The judge session could not start, or ended on an error.                                                      |
| `judge_timeout`                                        | The judge session ran past the judge's time limit.                                                            |
| `judge_interrupted`                                    | The judge session was stopped before it answered, by its turn limit or by a signal to the worker.             |
| `invalid_pr_risk_verdict`                              | Both of the judge's answers broke its contract.                                                               |
| `runner_died`, `result_unreadable`, `result_too_large` | The settle step found no result, one it could not read, or one too large to send.                             |
| `unexpected`                                           | Anything else.                                                                                                |

The job log names the reason; it never contains the judge's instructions or
its answer.
