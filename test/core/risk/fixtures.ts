import type { RiskJudge, RiskPlan } from "../../../src/core/risk/types";

type RiskIncremental = NonNullable<RiskPlan["incremental"]>;

export const judge: RiskJudge = {
  group: "group-a",
  skill:
    "---\nname: pr-risk-judge\ndescription: Judge one PR.\n---\n\n# Custom skill\n\n{{PR_SNAPSHOT_JSON}}\n",
  enabledTools: ["Read", "Grep", "Task"],
  settings: {
    sessionDefaultSettings: { model: "test-model", reasoningEffort: "low" },
    subagentAutonomyLevel: "high",
  },
  scores: { blastRadius: [1, 5], testCoverage: [0, 3] },
  timeoutSeconds: 1,
  sha256: "c".repeat(64),
};

export const validVerdict = {
  verdict: true,
  brief: "- The changed path is directly covered.",
  details: "Read the test; it exercises the changed path.",
  scores: { blastRadius: 2, testCoverage: 3 },
};

export function planFor(overrides: Partial<RiskPlan> = {}): RiskPlan {
  return {
    repo: "acme/app",
    pr: 123,
    run: {
      runner: "droid-action",
      trigger: "pull_request",
      runId: "77",
      runAttempt: 2,
      dryRun: true,
    },
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    pullRequest: { title: "Rotate sessions safely" },
    priorDeclines: [],
    judge,
    ...overrides,
  };
}

/** An earlier verdict to re-check, as Factory's `begin` serves one. */
export function incrementalFor(
  overrides: Partial<RiskIncremental> = {},
): RiskIncremental {
  return {
    mode: "enforce",
    reason: "small_change_since_decline",
    priorHeadSha: "1".repeat(40),
    priorAssessmentId: "0b9f6f0e-4c1d-4a55-9d2e-6a1f0c3b7e21",
    priorBaseSha: "2".repeat(40),
    judgeSha256: "9".repeat(64),
    prior: {
      verdict: false,
      outcome: "doNotApprove",
      brief: "- The rotation is untested.",
      details: "No test exercises the rotation.",
      concerns: [{ id: "c1", text: "The rotation is untested." }],
    },
    ...overrides,
  };
}
