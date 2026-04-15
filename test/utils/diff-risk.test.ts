import { describe, it, expect } from "bun:test";
import {
  computeRiskScore,
  classifyRisk,
  formatRiskSummary,
  type DiffStats,
} from "../../src/utils/diff-risk";

function createStats(overrides: Partial<DiffStats> = {}): DiffStats {
  return {
    totalFiles: 1,
    additions: 10,
    deletions: 5,
    changedFiles: ["src/index.ts"],
    hasLockfileChanges: false,
    hasConfigChanges: false,
    hasMigrationChanges: false,
    ...overrides,
  };
}

describe("computeRiskScore", () => {
  it("returns low score for small changes", () => {
    const stats = createStats({ additions: 5, deletions: 3, totalFiles: 1 });
    const score = computeRiskScore(stats);
    expect(score).toBeLessThan(0.3);
  });

  it("returns higher score for large changes", () => {
    const stats = createStats({
      additions: 400,
      deletions: 200,
      totalFiles: 15,
    });
    const score = computeRiskScore(stats);
    expect(score).toBeGreaterThan(0.5);
  });

  it("increases score for sensitive files", () => {
    const baseStats = createStats({ additions: 50, deletions: 20 });
    const sensitiveStats = createStats({
      additions: 50,
      deletions: 20,
      changedFiles: [".env.production", "src/auth/token.ts"],
    });

    const baseScore = computeRiskScore(baseStats);
    const sensitiveScore = computeRiskScore(sensitiveStats);
    expect(sensitiveScore).toBeGreaterThan(baseScore);
  });
});

describe("classifyRisk", () => {
  it("classifies small safe changes correctly", () => {
    const stats = createStats({
      additions: 5,
      deletions: 3,
      totalFiles: 1,
      changedFiles: ["src/utils/helper.ts"],
    });
    const result = classifyRisk(stats);
    expect(result.level).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("flags lockfile changes", () => {
    const stats = createStats({
      hasLockfileChanges: true,
    });
    const result = classifyRisk(stats);
    expect(result.reasons).toContain(
      "Lockfile changes detected — verify dependency integrity",
    );
  });

  it("flags migration changes", () => {
    const stats = createStats({
      hasMigrationChanges: true,
    });
    const result = classifyRisk(stats);
    expect(result.reasons).toContain("Database migration changes detected");
  });

  it("requires deep review for high risk", () => {
    const stats = createStats({
      additions: 800,
      deletions: 200,
      totalFiles: 25,
      changedFiles: [
        ".env",
        "src/auth/secret.ts",
        "migrations/001.sql",
        ...Array.from({ length: 22 }, (_, i) => `src/file${i}.ts`),
      ],
      hasConfigChanges: true,
      hasMigrationChanges: true,
    });
    const result = classifyRisk(stats);
    expect(result.requiresDeepReview).toBe(true);
  });
});

describe("formatRiskSummary", () => {
  it("includes risk level in output", () => {
    const assessment = classifyRisk(createStats());
    const summary = formatRiskSummary(assessment);
    expect(summary).toContain("Risk Level:");
    expect(summary).toContain("score:");
  });

  it("includes reasons when present", () => {
    const assessment = classifyRisk(createStats({ hasLockfileChanges: true }));
    const summary = formatRiskSummary(assessment);
    expect(summary).toContain("Factors:");
  });
});
