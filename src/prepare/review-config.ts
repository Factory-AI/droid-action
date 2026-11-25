import * as core from "@actions/core";
import {
  reviewConfigEnvironment,
  reviewConfigFromEnvironment,
  reviewInputsFromEnvironment,
} from "../core/review/config";
import {
  loadReviewUxConfigFromBase,
  type ReviewConfigBaseClient,
} from "../github/data/review-config";
import { isEntityContext, type GitHubContext } from "../github/context";

/** Runs before trigger selection or checkout, so the PR cannot set its own policy. */
export async function initializeReviewConfig(
  context: GitHubContext,
  client: ReviewConfigBaseClient,
): Promise<void> {
  const config =
    isEntityContext(context) && context.isPR
      ? await loadReviewUxConfigFromBase({
          client,
          owner: context.repository.owner,
          repo: context.repository.repo,
          prNumber: context.entityNumber,
          inputs: reviewInputsFromEnvironment(),
          // github/run-review.sh reviews unless the caller or the base-branch
          // file turns automatic review off; in Actions it stays opt-in.
          defaults:
            process.env.DEFAULT_AUTOMATIC_REVIEW === "true"
              ? { automatic_review: true }
              : undefined,
          onBaseSha: (sha) => {
            core.exportVariable("REVIEW_BASE_SHA", sha);
            core.setOutput("review_base_sha", sha);
          },
        })
      : reviewConfigFromEnvironment();
  context.inputs.reviewConfig = config;
  context.inputs.automaticReview = config.automatic_review;
  context.inputs.automaticSecurityReview = config.automatic_security_review;
  context.inputs.securitySeverityThreshold = config.security_severity_threshold;
  context.inputs.securityBlockOnCritical = config.security_block_on_critical;
  context.inputs.securityBlockOnHigh = config.security_block_on_high;
  const serializedConfig = JSON.stringify(config);
  core.setOutput("review_config_json", serializedConfig);
  for (const [key, value] of Object.entries(reviewConfigEnvironment(config))) {
    core.exportVariable(key, value);
  }
}
