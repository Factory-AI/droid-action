import { reviewConfigFromEnvironment } from "../config";
import type { ReviewPromptSettings } from "./types";

/** Consume the resolved preparation environment; never load PR-controlled files here. */
export function reviewPromptSettingsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReviewPromptSettings {
  const config = reviewConfigFromEnvironment(env);
  return {
    depth: config.review_depth,
    diagram: config.review_diagram,
    effort: config.review_effort,
    suggestReviewers: config.review_suggest_reviewers,
    preMergeChecks: config.review_pre_merge_checks,
    ignorePaths: config.review_ignore_paths,
    severityThreshold: config.review_severity_threshold,
    securitySeverityThreshold: config.security_severity_threshold,
    securityBlockOnCritical: config.security_block_on_critical,
    securityBlockOnHigh: config.security_block_on_high,
  };
}
