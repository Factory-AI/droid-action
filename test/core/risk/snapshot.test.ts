import { describe, expect, it } from "bun:test";
import {
  buildPrRiskSnapshot,
  renderPrRiskSkill,
} from "../../../src/core/risk/snapshot";
import type { PrRiskEvidenceWorkspace } from "../../../src/core/risk/types";
import { file, pullRequest } from "./fixtures";

const evidence: PrRiskEvidenceWorkspace = {
  rootDir: "/tmp/pr-risk",
  headTreeDir: "/tmp/pr-risk/evidence/head",
  diffPath: "/tmp/pr-risk/evidence/pr.diff",
  inventoryPath: "/tmp/pr-risk/evidence/changed-files.json",
  guidelinesPath: null,
  snapshotHash: "snapshot-hash",
};

describe("buildPrRiskSnapshot", () => {
  it("separates runtime, test, and noise changes without treating fanout as risk", () => {
    const snapshot = buildPrRiskSnapshot({ ...pullRequest, changedFiles: 4 }, [
      file("packages/common/src/session.ts"),
      file("packages/common/src/session.test.ts"),
      file("docs/sessions.md"),
      file("package-lock.json", 400, 80),
    ]);

    expect(snapshot.summary).toMatchObject({
      runtimeFiles: 1,
      testFiles: 1,
      docsFiles: 1,
      generatedOrLockFiles: 1,
      runtimeLinesChanged: 12,
      testLinesChanged: 12,
    });
    expect(snapshot.summary.workspaces).toEqual(["packages/common"]);
    expect(snapshot.summary.unlistedFiles).toBe(0);
  });

  it("counts Markdown that changes agent behavior as runtime, and reports the files it was not given by name", () => {
    const snapshot = buildPrRiskSnapshot({ ...pullRequest, changedFiles: 5 }, [
      file(".factory/skills/review/SKILL.md"),
      file("AGENTS.md"),
      file("README.md"),
    ]);

    expect(
      snapshot.files.map(({ filename, kind }) => [filename, kind]),
    ).toEqual([
      [".factory/skills/review/SKILL.md", "runtime"],
      ["AGENTS.md", "runtime"],
      ["README.md", "docs"],
    ]);
    expect(snapshot.summary.unlistedFiles).toBe(2);
    expect(snapshot.summary.workspaces).toEqual(["root"]);
  });
});

describe("renderPrRiskSkill", () => {
  const snapshot = buildPrRiskSnapshot(pullRequest, [
    file("packages/common/src/session.ts"),
  ]);

  it("substitutes the snapshot, evidence paths included, without the base revision", () => {
    const skill = renderPrRiskSkill(
      "RULES\n{{PR_SNAPSHOT_JSON}}\nEND",
      snapshot,
      evidence,
    );

    expect(skill.startsWith("RULES\n{")).toBe(true);
    expect(skill.endsWith("}\nEND")).toBe(true);
    expect(skill).toContain('"prNumber": 123');
    expect(skill).toContain(`"diffPath": "${evidence.diffPath}"`);
    expect(skill).toContain(`"headTreePath": "${evidence.headTreeDir}"`);
    expect(skill).not.toContain('"baseSha"');
    expect(skill).not.toContain("{{PR_SNAPSHOT_JSON}}");
    expect(skill).toContain('"guidelinesPath": null');
  });

  it("shows the judge the concerns this PR's earlier revisions were declined for", () => {
    const priorDeclines = [
      { headSha: "d".repeat(12), concerns: "- Do not approve: stale bytes." },
    ];
    const skill = renderPrRiskSkill(
      "{{PR_SNAPSHOT_JSON}}",
      buildPrRiskSnapshot(
        pullRequest,
        [file("packages/common/src/session.ts")],
        priorDeclines,
      ),
      evidence,
    );

    expect(JSON.parse(skill).priorDeclines).toEqual(priorDeclines);
  });

  it("names the guidelines file when the default branch has one", () => {
    const guidelinesPath = "/tmp/pr-risk/evidence/pr-risk-guidelines.md";
    const skill = renderPrRiskSkill("{{PR_SNAPSHOT_JSON}}", snapshot, {
      ...evidence,
      guidelinesPath,
    });

    expect(skill).toContain(`"guidelinesPath": "${guidelinesPath}"`);
  });

  it("appends the snapshot as a fenced section when the skill carries no placeholder", () => {
    const skill = renderPrRiskSkill("RULES\n", snapshot, evidence);

    expect(skill).toMatch(/^RULES\n\n## PR snapshot\n\n```json\n\{/);
    expect(skill.endsWith("}\n```\n")).toBe(true);
  });

  it("keeps replacement patterns in a pull request title literal", () => {
    const title = "Fix $& and $' and $1 in the price formatter";
    const skill = renderPrRiskSkill(
      "{{PR_SNAPSHOT_JSON}}",
      buildPrRiskSnapshot({ ...pullRequest, title }, [file("src/price.ts")]),
      evidence,
    );

    expect(JSON.parse(skill).pullRequest.title).toBe(title);
  });
});
