import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import * as pr from "../src/github/data/pr-fetcher";
import * as prompt from "../src/create-prompt";
import * as mcp from "../src/mcp/install-mcp-server";
import * as policy from "../src/utils/model-policy";
import { prepareSecurityScanMode } from "../src/tag/commands/security-scan";
import { createMockContext } from "./mockContext";

const SOURCE = "a".repeat(40);
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  delete process.env.DROID_ARGS;
  spyOn(core, "setOutput").mockImplementation(() => {});
  spyOn(pr, "fetchRepoDefaultBranch").mockResolvedValue("main");
  spyOn(policy, "applyModelPolicyFallback").mockResolvedValue({
    model: "fixture",
  });
});
afterEach(() => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
describe("full scan preparation freezes provenance and the exact report target before model execution", () => {
  for (const failure of ["none", "revision", "author"]) {
    it(`binds an issue-triggered scan (${failure}) without using the issue as its PR`, async () => {
      let revision = failure === "revision" ? "main" : SOURCE;
      const getCommit = mock(
        async (_input: { owner: string; repo: string; ref: string }) => ({
          data: { sha: revision },
        }),
      );
      const kit: any = {
        rest: { repos: { getCommit } },
        graphql: async () => ({
          viewer: { login: failure === "author" ? "" : "factory-droid[bot]" },
        }),
      };
      const context = createMockContext({
        isPR: false,
        entityNumber: 41,
        actor: "human",
      });
      const promptSpy = spyOn(prompt, "createPrompt").mockImplementation(
        async () => {
          expect(getCommit).toHaveBeenCalledTimes(1);
          revision = "b".repeat(40);
        },
      );
      const mcpSpy = spyOn(mcp, "prepareMcpTools").mockResolvedValue("{}");
      const action = prepareSecurityScanMode({
        context,
        octokit: kit,
        githubToken: "test-only",
        scanScope: { type: "full" },
      });
      if (failure !== "none") {
        await expect(action).rejects.toThrow();
        expect(promptSpy).not.toHaveBeenCalled();
        expect(mcpSpy).not.toHaveBeenCalled();
        return;
      }
      const result = await action;
      const target = mcpSpy.mock.calls[0]?.[0].securityReportTarget;
      expect(target).toEqual({
        sourceRevision: SOURCE,
        branch: result.branchInfo.droidBranch ?? "",
        baseBranch: "main",
        author: "factory-droid[bot]",
      });
      expect(getCommit.mock.calls[0]).toEqual([
        {
          owner: context.repository.owner,
          repo: context.repository.repo,
          ref: "main",
        },
      ]);
      expect(mcpSpy.mock.calls[0]?.[0].allowedTools).not.toContain(
        "github_pr___submit_review",
      );
      const generated = promptSpy.mock.calls[0]?.[0].generatePrompt?.({
        repository: "o/r",
      } as any);
      expect(generated).toContain(
        `git checkout -b ${target?.branch} ${SOURCE}`,
      );
      expect(generated).toContain(`"sourceRevision":"${SOURCE}"`);
      expect(generated).not.toContain(revision);
    });
  }
});
