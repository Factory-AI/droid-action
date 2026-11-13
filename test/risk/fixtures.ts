import type { RiskEvidenceWorkspace } from "../../src/risk/evidence";
import type { RiskJudgePlan } from "../../src/risk/plan";

export const sha = (character: string) => character.repeat(40);

export function judgePlan(
  overrides: Partial<RiskJudgePlan["judge"]> = {},
): RiskJudgePlan {
  return {
    action: "judge",
    headSha: sha("a"),
    baseSha: sha("b"),
    assignment: {
      experiment: "risk_assessment_judge",
      group: "skill-v4",
      ruleId: "rule-1",
      judgeConfig: "risk_assessment_config_v5",
    },
    judge: {
      skill: "# Judge\n\n{{PR_SNAPSHOT_JSON}}\n",
      skillSha256: "c".repeat(64),
      enabledTools: ["Read", "Grep", "Execute"],
      settings: { model: "synthetic-model" },
      timeoutSeconds: 1000,
      scores: { blastRadius: [1, 5] },
      contract: '{"verdict": boolean, "brief": string, "details": string}',
      ...overrides,
    },
    priorDeclines: [{ headSha: sha("d"), concerns: "Earlier concern" }],
  };
}

/** A workspace record over real directories, for code that writes into it. */
export function evidenceAt(workDir: string): RiskEvidenceWorkspace {
  return {
    workDir,
    rootDir: `${workDir}/judge`,
    homeDir: `${workDir}/home`,
    tmpDir: `${workDir}/tmp`,
    headTreeDir: `${workDir}/judge/evidence/head`,
    diffPath: `${workDir}/judge/evidence/pr.diff`,
    inventoryPath: `${workDir}/judge/evidence/changed-files.json`,
    guidelinesPath: null,
    snapshotHash: "e".repeat(64),
  };
}

/** What `droid exec --output-format json` prints for one session. */
export const execSummary = (result: string, isError = false) =>
  JSON.stringify({ is_error: isError, result, session_id: "session-1" });
