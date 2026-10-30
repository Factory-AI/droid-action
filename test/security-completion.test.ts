import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as core from "@actions/core";
import {
  finishReviewLifecycle,
  type ReviewLifecycleRun,
} from "../src/github/operations/review-lifecycle";
import {
  decodeReviewState,
  encodeReviewState,
} from "../src/core/review/markers";

const HEAD = "a".repeat(40);
let saved: NodeJS.ProcessEnv;
let directory: string;
beforeEach(async () => {
  saved = { ...process.env };
  directory = await mkdtemp(join(tmpdir(), "dispatch-security-receipt-"));
  for (const key of Object.keys(process.env))
    if (/^(REVIEW_|SECURITY_|WORKFLOW_GITHUB_TOKEN)/.test(key))
      delete process.env[key];
  Object.assign(process.env, {
    RUNNER_TEMP: directory,
    REVIEW_CHECK_RUN: "false",
    REVIEW_REACTIONS: "false",
    REVIEW_SUMMARY_SECTIONS: "verdict",
  });
  spyOn(core, "setOutput").mockImplementation(() => {});
});
afterEach(async () => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(directory, { recursive: true, force: true });
});
describe("security completion is durable machine data, not optional UI prose", () => {
  for (const mode of ["model-claim", "trusted-dual"]) {
    it(`${mode}: completion follows trusted run intent rather than model UI metadata`, async () => {
      process.env.REVIEW_SUMMARY = "comment";
      if (mode === "trusted-dual") process.env.SECURITY_REVIEW_ENABLED = "true";
      let comment = "";
      const kit: any = {
        rest: {
          issues: {
            updateComment: async (x: any) => {
              comment = x.body;
              return { data: {} };
            },
          },
        },
      };
      const run: ReviewLifecycleRun = {
        owner: "o",
        repo: "r",
        prNumber: 7,
        commentId: 55,
        head: HEAD,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: false,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: {
          state: "clean",
          ...(mode === "model-claim"
            ? { summary: { security: { enabled: true } } }
            : {}),
        },
      });
      if (mode === "trusted-dual")
        expect(decodeReviewState(comment)?.securityReviewedHead).toBe(HEAD);
      else
        expect(
          decodeReviewState(comment)?.securityReviewedHead,
        ).toBeUndefined();
    });
  }
  for (const mode of ["comment", "description"]) {
    it(`persists successful security completion with ${mode} and details omitted`, async () => {
      process.env.REVIEW_SUMMARY = mode;
      let comment = "";
      const kit: any = {
        rest: {
          issues: {
            updateComment: async (x: any) => {
              comment = x.body;
              return { data: {} };
            },
          },
          pulls: {
            get: async () => ({
              data: {
                body: "author text",
                head: { sha: HEAD },
                base: { sha: "b".repeat(40) },
              },
            }),
            update: async () => ({ data: {} }),
          },
        },
      };
      const run: ReviewLifecycleRun = {
        owner: "o",
        repo: "r",
        prNumber: 7,
        commentId: 55,
        head: HEAD,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: true,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: {
          state: "clean",
          sections: ["verdict"],
          summary: { security: { enabled: true } },
        },
      });
      expect(comment).not.toContain("Security review: ran");
      expect(decodeReviewState(comment)).toEqual(
        expect.objectContaining({ securityReviewedHead: HEAD }),
      );
    });
  }
  for (const state of ["failed", "skipped", "in_progress"] as const) {
    it(`does not stamp a ${state} security run`, async () => {
      process.env.REVIEW_SUMMARY = "comment";
      let comment = "";
      const kit: any = {
        rest: {
          issues: {
            updateComment: async (x: any) => {
              comment = x.body;
              return { data: {} };
            },
          },
        },
      };
      const run: ReviewLifecycleRun = {
        owner: "o",
        repo: "r",
        prNumber: 7,
        commentId: 55,
        head: HEAD,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: true,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: { state, summary: { security: { enabled: true } } },
      });
      expect(
        (decodeReviewState(comment) as any)?.securityReviewedHead,
      ).toBeUndefined();
    });
  }
  it("does not accept a malformed completion revision", () => {
    expect(
      decodeReviewState(
        encodeReviewState({
          head: HEAD,
          findings: [],
          securityReviewedHead: "forged",
        } as any),
      ),
    ).toEqual({ head: HEAD, findings: [] });
  });
  for (const kind of ["ordinary", "aborted", "superseded"]) {
    it(`${kind}: preserves prior same-head success but never invents new security completion`, async () => {
      process.env.REVIEW_SUMMARY = "comment";
      let comment = "";
      const kit: any = {
        rest: {
          issues: {
            updateComment: async (x: any) => {
              comment = x.body;
              return { data: {} };
            },
          },
        },
      };
      const run: ReviewLifecycleRun = {
        owner: "o",
        repo: "r",
        prNumber: 7,
        commentId: 55,
        head: HEAD,
        state: {
          head: HEAD,
          findings: [],
          ...(kind === "ordinary" ? { securityReviewedHead: HEAD } : {}),
        },
        automatic: true,
        securityOnly: kind !== "ordinary",
        startedAt: new Date().toISOString(),
        steps: [],
        superseded: kind === "superseded",
      };
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: { state: "clean" },
        ...(kind === "aborted"
          ? { error: "Candidate generation aborted" }
          : {}),
      });
      if (kind === "ordinary")
        expect(run.state.securityReviewedHead).toBe(HEAD);
      else expect(run.state.securityReviewedHead).toBeUndefined();
      if (kind === "ordinary")
        expect(decodeReviewState(comment)?.securityReviewedHead).toBe(HEAD);
      if (kind === "superseded") expect(comment).toBe("");
    });
  }
});
