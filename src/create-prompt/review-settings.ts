import { reviewPromptSettingsFromEnvironment } from "../core/review/prompts/settings";
import type { ModelReviewPromptSettings } from "../core/review/prompts/types";

/** GitHub's publisher and native checks retain the complete trusted policy. */
export function githubReviewPromptSettingsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ModelReviewPromptSettings {
  const settings = reviewPromptSettingsFromEnvironment(env);
  return {
    depth: settings.depth,
    diagram: settings.diagram,
    effort: settings.effort,
    ignorePaths: settings.ignorePaths,
    severityThreshold: settings.severityThreshold,
    securitySeverityThreshold: settings.securitySeverityThreshold,
  };
}
