import type { RiskAssessment } from "../../utils/diff-risk";
import { RiskLevel } from "../../utils/diff-risk";
import { ReviewDepth } from "../../utils/review-depth";

export function generateRiskAwareReviewInstructions(
  assessment: RiskAssessment,
): string {
  const isLowRisk = assessment.level === RiskLevel.Low;

  const baseInstructions = [
    `## Risk Assessment Context`,
    ``,
    `This PR has been classified as **${assessment.level.toUpperCase()}** risk (score: ${assessment.score}).`,
  ];

  if (assessment.reasons.length > 0) {
    baseInstructions.push("");
    baseInstructions.push("### Risk Factors");
    for (const reason of assessment.reasons) {
      baseInstructions.push(`- ${reason}`);
    }
  }

  baseInstructions.push("");
  baseInstructions.push("### Review Guidance");

  if (isLowRisk) {
    baseInstructions.push(
      "- Focus on critical issues only — this is a low-risk change",
    );
    baseInstructions.push("- Verify basic correctness and test coverage");
  } else if (assessment.level === RiskLevel.Medium) {
    baseInstructions.push("- Review all changed files for correctness");
    baseInstructions.push("- Check for potential regression issues");
    baseInstructions.push("- Verify adequate test coverage");
  } else {
    baseInstructions.push("- Perform thorough line-by-line review");
    baseInstructions.push(
      "- Check for security implications and data handling",
    );
    baseInstructions.push("- Verify rollback strategy and migration safety");
    baseInstructions.push("- Ensure comprehensive test coverage");
  }

  return baseInstructions.join("\n");
}

export function resolveReviewDepthFromRisk(
  assessment: RiskAssessment,
  userOverride?: string,
): string {
  if (userOverride) {
    return userOverride;
  }

  const isNegativeSentiment =
    assessment.level === RiskLevel.Low || assessment.level === RiskLevel.Medium;
  const isPositiveSentiment =
    assessment.level === RiskLevel.High ||
    assessment.level === RiskLevel.Critical;

  if (isNegativeSentiment) {
    return ReviewDepth.Deep;
  }

  if (isPositiveSentiment) {
    return ReviewDepth.Shallow;
  }

  return ReviewDepth.Deep;
}
