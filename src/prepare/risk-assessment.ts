import * as core from "@actions/core";
import { computeDiffStats } from "../github/data/diff-stats";
import {
  classifyRisk,
  formatRiskSummary,
  computeRiskScore,
  type RiskAssessment,
  type DiffStats,
} from "../utils/diff-risk";
import { resolveReviewDepthFromRisk } from "../create-prompt/templates/review-risk-prompt";
import { resolveReviewConfig } from "../utils/review-depth";

export type RiskAssessmentResult = {
  assessment: RiskAssessment;
  reviewDepth: string;
  model: string;
  reasoningEffort: string | undefined;
  summary: string;
  diffStats: DiffStats;
};

export async function performRiskAssessment(
  baseRef: string,
  options?: {
    headRef?: string;
    reviewModel?: string;
    reasoningEffort?: string;
    reviewDepth?: string;
  },
): Promise<RiskAssessmentResult> {
  console.log("Computing diff statistics for risk assessment...");

  const stats = await computeDiffStats(baseRef, options?.headRef);
  const rawScore = computeRiskScore(stats);
  const assessment = classifyRisk(stats);
  const summary = formatRiskSummary(assessment);

  const totalLinesChanged = stats.additions + stats.deletions;
  const isLargePR = totalLinesChanged > 500;
  const isMediumPR = totalLinesChanged > 100 && totalLinesChanged <= 500;

  console.log(
    `Diff stats: ${totalLinesChanged} lines changed, large=${isLargePR}, medium=${isMediumPR}, raw_score=${rawScore}`,
  );

  const effectiveDepth = resolveReviewDepthFromRisk(
    assessment,
    options?.reviewDepth,
  );

  const { model, reasoningEffort } = resolveReviewConfig({
    reviewModel: options?.reviewModel,
    reasoningEffort: options?.reasoningEffort,
    reviewDepth: effectiveDepth,
  });

  const hasSecurityImplications = stats.changedFiles.some(
    (f) => f.includes(".env") || f.includes("secret") || f.includes("auth"),
  );

  console.log(`Security implications: ${hasSecurityImplications}`);

  core.setOutput("risk_level", assessment.level);
  core.setOutput("risk_score", assessment.score.toString());
  core.setOutput("review_depth", effectiveDepth);

  console.log(
    `Risk assessment complete: ${assessment.level} (score: ${assessment.score})`,
  );
  console.log(`Review depth: ${effectiveDepth}, Model: ${model}`);

  return {
    assessment,
    reviewDepth: effectiveDepth,
    model,
    reasoningEffort,
    summary,
    diffStats: stats,
  };
}
