import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { prepareMcpTools } from "../src/mcp/install-mcp-server";
import { handleUpdatePRDescription } from "../src/mcp/github-pr-server";
import { createMockContext } from "./mockContext";
import { DroidRunType } from "../src/run-type";

const SOURCE = "a".repeat(40);
const FIXED = "b".repeat(40);
const BRANCH = "droid/security-report-2026-10-30";
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  delete process.env.DEFAULT_WORKFLOW_TOKEN;
  Object.assign(process.env, {
    DROID_EXEC_RUN_TYPE: DroidRunType.SecurityScan,
    SECURITY_REPORT_SOURCE_REVISION: SOURCE,
    SECURITY_REPORT_BRANCH: BRANCH,
    SECURITY_REPORT_BASE_BRANCH: "main",
    SECURITY_REPORT_AUTHOR: "factory-droid[bot]",
    SECURITY_REPORT_ACTOR: "human",
    SECURITY_REPORT_TRIGGER_NUMBER: "41",
  });
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
const finding = (id: string, path: string) => ({
  status: "approved",
  comment: {
    id,
    title: "Unsafe input",
    severity: "P1",
    security: true,
    path,
    line: 10,
    body: "Input reaches the unsafe sink",
    verification: "Run the regression",
    outside_diff: true,
  },
});
const payload = () => ({
  version: 1,
  results: [
    finding("VULN-1", "src/patched.ts"),
    finding("VULN-2", "src/manual.ts"),
  ],
  securityReport: {
    sourceRevision: SOURCE,
    outcomes: [
      {
        id: "VULN-1",
        disposition: "patched",
        fixCommit: FIXED,
        verification: "Regression passed after the patch",
      },
      { id: "VULN-2", disposition: "manual" },
    ],
  },
});
function fixture() {
  const data: any = {
    state: "open",
    merged: false,
    body: "Report placeholder",
    user: { login: "factory-droid[bot]", type: "Bot" },
    head: { sha: FIXED, ref: BRANCH, repo: { full_name: "o/r" } },
    base: { ref: "main", repo: { full_name: "o/r" } },
  };
  const updates: any[] = [];
  const octokit: any = {
    rest: {
      pulls: {
        get: async () => ({ data: structuredClone(data) }),
        update: async (x: any) => {
          updates.push(x);
          return { data: {} };
        },
      },
    },
  };
  const publish = (
    body: unknown = payload(),
    prNumber = 7,
    mode: "security-report" | "replace" = "security-report",
  ) =>
    handleUpdatePRDescription({
      owner: "o",
      repo: "r",
      prNumber,
      body: JSON.stringify(body),
      mode,
      octokit,
    });
  return { data, updates, octokit, publish };
}

describe("issue-triggered security report capability is scoped to its new report PR", () => {
  it("installs a report-only PR server without binding the triggering issue as its PR", async () => {
    const result = JSON.parse(
      await prepareMcpTools({
        githubToken: "test-only",
        owner: "o",
        repo: "r",
        runType: DroidRunType.SecurityScan,
        allowedTools: ["github_pr___update_pr_description"],
        mode: "tag",
        context: createMockContext({
          isPR: false,
          entityNumber: 41,
          actor: "human",
        }),
        securityReportTarget: {
          sourceRevision: SOURCE,
          branch: BRANCH,
          baseBranch: "main",
          author: "factory-droid[bot]",
        },
      } as any),
    );
    expect(result.mcpServers.github_pr).toBeDefined();
    expect(result.mcpServers.github_pr.env.PR_NUMBER).toBe("");
    expect(
      result.mcpServers.github_pr.env.SECURITY_REPORT_SOURCE_REVISION,
    ).toBe(SOURCE);
    expect(result.mcpServers.github_pr.env.SECURITY_REPORT_TRIGGER_NUMBER).toBe(
      "41",
    );
  });
  it("does not install the PR server for an ordinary issue", async () => {
    const result = JSON.parse(
      await prepareMcpTools({
        githubToken: "test-only",
        owner: "o",
        repo: "r",
        runType: DroidRunType.Default,
        allowedTools: ["github_pr___update_pr_description"],
        mode: "tag",
        context: createMockContext({ isPR: false }),
      }),
    );
    expect(result.mcpServers.github_pr).toBeUndefined();
  });
  it("does not allow the scan capability to use ordinary replace mode", async () => {
    const f = fixture();
    await expect(f.publish(payload(), 7, "replace")).rejects.toThrow();
    expect(f.updates).toHaveLength(0);
  });
  for (const field of ["repo", "author", "branch", "trigger"]) {
    it(`rejects a ${field} target mismatch without a write`, async () => {
      const f = fixture();
      if (field === "repo") f.data.head.repo.full_name = "other/repo";
      if (field === "author") f.data.user.login = "other-user";
      if (field === "branch") f.data.head.ref = "unrelated";
      await expect(
        f.publish(payload(), field === "trigger" ? 41 : 7),
      ).rejects.toThrow();
      expect(f.updates).toHaveLength(0);
    });
  }
  it("refuses a head change between rendering and the description write", async () => {
    const f = fixture();
    let reads = 0;
    f.octokit.rest.pulls.get = async () => ({
      data: {
        ...f.data,
        head: { ...f.data.head, sha: reads++ ? "c".repeat(40) : FIXED },
      },
    });
    await expect(f.publish()).rejects.toThrow();
    expect(f.updates).toHaveLength(0);
  });
});

describe("security reports preserve pre-patch source and explicit remediation outcomes", () => {
  it("renders mixed reported-patched/manual results against their original source", async () => {
    const f = fixture();
    const body = await f.publish();
    expect(body).toContain("Reported patched");
    expect(body).toContain("Manual remediation required");
    expect(body).toContain("Regression passed after the patch");
    expect(body).toContain(`/blob/${SOURCE}/src/patched.ts`);
    expect(body).not.toContain(`/blob/${FIXED}/src/patched.ts`);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0].pull_number).toBe(7);
  });
  it("qualifies legacy scan results without inventing remediation or fixed-head evidence", async () => {
    const f = fixture();
    const body = await f.publish({
      version: 1,
      results: [finding("old", "src/legacy.ts")],
    });
    expect(body).toContain("Remediation status not reported");
    expect(body).not.toContain(`/blob/${FIXED}/src/legacy.ts`);
  });
  it("rejects a claimed original revision that disagrees with the trusted pre-model source", async () => {
    const f = fixture();
    const raw = payload();
    raw.securityReport.sourceRevision = FIXED;
    await expect(f.publish(raw)).rejects.toThrow();
    expect(f.updates).toHaveLength(0);
  });
  it("requires a reported patch commit and verification for a patched disposition", async () => {
    const f = fixture();
    const raw = payload();
    raw.securityReport.outcomes[0]!.verification = "";
    await expect(f.publish(raw)).rejects.toThrow();
    expect(f.updates).toHaveLength(0);
  });
});
