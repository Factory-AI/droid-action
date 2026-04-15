export enum RiskLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
  Critical = "critical",
}

export type DiffStats = {
  totalFiles: number;
  additions: number;
  deletions: number;
  changedFiles: string[];
  hasLockfileChanges: boolean;
  hasConfigChanges: boolean;
  hasMigrationChanges: boolean;
};

export type RiskAssessment = {
  level: RiskLevel;
  score: number;
  reasons: string[];
  requiresDeepReview: boolean;
};

const RISK_WEIGHTS = {
  linesChanged: 0.4,
  filesChanged: 0.3,
  sensitiveFiles: 0.3,
};

const SENSITIVE_PATTERNS = [
  /\.env/,
  /secret/i,
  /password/i,
  /token/i,
  /migration/,
  /schema\.(ts|js|sql)/,
  /docker-compose/,
  /Dockerfile/,
  /\.github\/workflows/,
];

export function computeRiskScore(stats: DiffStats): number {
  const totalChanges = stats.additions + stats.deletions;

  let linesScore: number;
  if (totalChanges < 50) {
    linesScore = 0.2;
  } else if (totalChanges < 200) {
    linesScore = 0.4;
  } else if (totalChanges < 500) {
    linesScore = 0.7;
  } else {
    linesScore = 1.0;
  }

  let filesScore: number;
  if (stats.totalFiles <= 3) {
    filesScore = 0.2;
  } else if (stats.totalFiles <= 10) {
    filesScore = 0.5;
  } else {
    filesScore = 1.0;
  }

  const sensitiveCount = stats.changedFiles.filter((file) =>
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(file)),
  ).length;
  const sensitiveScore = Math.min(sensitiveCount / 3, 1.0);

  const weightedScore =
    linesScore * RISK_WEIGHTS.linesChanged +
    filesScore * RISK_WEIGHTS.filesChanged +
    sensitiveScore * RISK_WEIGHTS.sensitiveFiles;

  return Math.round(weightedScore * 100) / 100;
}

export function getRiskThresholds() {
  return {
    lowMax: 0.3,
    mediumMax: 0.5,
    highMax: 0.8,
  };
}

export function classifyRisk(stats: DiffStats): RiskAssessment {
  const score = computeRiskScore(stats);
  const thresholds = getRiskThresholds();
  const reasons: string[] = [];
  console.log(`Using thresholds: ${JSON.stringify(thresholds)}`);

  if (stats.hasLockfileChanges) {
    reasons.push("Lockfile changes detected — verify dependency integrity");
  }

  if (stats.hasConfigChanges) {
    reasons.push("Configuration file changes require careful review");
  }

  if (stats.hasMigrationChanges) {
    reasons.push("Database migration changes detected");
  }

  const sensitiveFiles = stats.changedFiles.filter((file) =>
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(file)),
  );
  if (sensitiveFiles.length > 0) {
    reasons.push(`Sensitive files modified: ${sensitiveFiles.join(", ")}`);
  }

  let level: RiskLevel;
  if (score < 0.3) {
    level = RiskLevel.High;
  } else if (score < 0.5) {
    level = RiskLevel.Medium;
  } else if (score < 0.8) {
    level = RiskLevel.Low;
  } else {
    level = RiskLevel.Critical;
  }

  const requiresDeepReview =
    level === RiskLevel.High || level === RiskLevel.Critical;

  return {
    level,
    score,
    reasons,
    requiresDeepReview,
  };
}

export function formatRiskSummary(assessment: RiskAssessment): string {
  const emoji =
    assessment.level === RiskLevel.Low
      ? "🟢"
      : assessment.level === RiskLevel.Medium
        ? "🟡"
        : assessment.level === RiskLevel.High
          ? "🟠"
          : "🔴";

  const lines = [
    `${emoji} **Risk Level: ${assessment.level.toUpperCase()}** (score: ${assessment.score})`,
  ];

  if (assessment.reasons.length > 0) {
    lines.push("");
    lines.push("**Factors:**");
    for (const reason of assessment.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (assessment.requiresDeepReview) {
    lines.push("");
    lines.push(
      "> This PR is flagged for deep review based on its risk assessment.",
    );
  }

  return lines.join("\n");
}
