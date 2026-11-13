# Risk assessment phase

Risk assessment is an optional second phase of the GitHub action. It runs in the same job as the review, after the review has finished, and is off unless the workflow sets `risk_assessment: true`.

The action does not decide anything. It asks the Factory backend whether a pull request head should be assessed, runs the judge the backend hands it, and sends the judge's raw answer back. The backend validates the answer, applies its thresholds, and performs every GitHub write (the risk comment and the approval review).

This phase exists on the `dev-internal` branch only.

## Inputs

| Input                  | Default                  | Purpose                                                                               |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `risk_assessment`      | `false`                  | Turns the phase on.                                                                   |
| `risk_pr_number`       | empty                    | Pull request to assess on `workflow_dispatch`. Ignored on `pull_request` events.      |
| `risk_dry_run`         | `false`                  | Asks the backend to publish the comment only and leave the approval review untouched. |
| `risk_factory_api_key` | `factory_api_key`        | Factory API key for the phase: the plan and publish calls and the judge session.      |
| `risk_api_base_url`    | `https://api.factory.ai` | Factory API host for the phase, such as a preview backend. Must be `https`.           |

## Steps

The steps run after `Review lifecycle finalize` and before debug files are collected and the App token is revoked.

1. **Risk assessment plan.** `POST /api/internal/pr-risk/plan` with the repository, the pull request number, the event action and the event's head commit. The answer is `skip`, `hold` or `judge`. Only `judge` continues. An answer this version cannot read is treated as "do not assess". Fork pull requests and events other than `opened`, `reopened`, `ready_for_review`, `synchronize` and `workflow_dispatch` are skipped without a request.
2. **Install Droid CLI for risk assessment.** Only when no review session ran in the job. Otherwise the judge runs the executable the review phase froze, and refuses it if its bytes changed.
3. **Risk assessment judge.**
   - Revokes the review phase's App token. If that fails, nothing is judged.
   - Mints a second token from the same App with read access only (`contents`, `pull_requests`, `issues`, `checks`, `statuses`). A caller-provided `github_token` is used as it is instead, and is never revoked.
   - Stops if the pull request head is no longer the planned head.
   - Builds evidence in a new bare repository under the runner's temporary directory: the exact head as a detached worktree, the merge-base diff, the changed-file inventory, and `.factory/pr-risk/guidelines.md` from the default branch tip. It borrows objects from the job checkout but takes no configuration, hooks or refs from it, and never reads the working tree.
   - Runs `droid exec` with the plan's skill, tools, settings and timeout, in an environment that holds only a private home, the Factory key and the read-only token. An answer outside the expected shape gets one retry.
   - Hashes the executable again and discards the answer if it changed.
4. **Publish risk assessment.** `POST /api/internal/pr-risk/publish` with the raw answer. When the judge step failed or produced no usable answer, the head is published without one, which the backend reports as unavailable.
5. **Require a published risk assessment.** Fails the job when the plan step failed, or when a head was planned for judging and nothing was published. No other step in the phase fails the job.

Each step runs a program bundled before the first model started, verified by SHA-256 and started under `env -i` with an explicit list of variables, the same way the review's publishing steps run.

## Workflow requirements

- `permissions: id-token: write`, as for the review. The read-only token comes from a second OIDC exchange.
- Check the repository out with `persist-credentials: false`. Otherwise the checkout leaves the workflow's own token in `.git/config`, where a judge session can read it.
- Add `synchronize` to the workflow's `pull_request` types if pushes should be assessed. Review triggers are configured separately.

## Limits

- This is configuration and credential isolation, not a sandbox. The judge session runs as the job's user on a machine where a review session may already have run commands. It can read files that user can read, including the environment of the processes that started it.
- The phase needs backend support for the two routes above and for `checks` and `statuses` read access in the token exchange.
