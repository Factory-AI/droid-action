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
  SUMMARY_MARKER,
} from "../src/core/review/markers";

const HEAD = "a".repeat(40);
const RUN_ID = "123";
const RUN_ATTEMPT = "2";
const managedKey = (key: string) =>
  /^(REVIEW_|SECURITY_|FAIL_ON_|WORKFLOW_GITHUB_TOKEN$)/.test(key);
let saved: Map<string, string | undefined>;
let directory: string;
beforeEach(async () => {
  saved = new Map(
    [
      ...Object.keys(process.env).filter(managedKey),
      "RUNNER_TEMP",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_STEP_SUMMARY",
      "DROID_BOT_LOGIN",
    ].map((key) => [key, process.env[key]]),
  );
  directory = await mkdtemp(join(tmpdir(), "dispatch-security-receipt-"));
  for (const key of saved.keys()) delete process.env[key];
  Object.assign(process.env, {
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
    REVIEW_CHECK_RUN: "false",
    REVIEW_REACTIONS: "false",
    REVIEW_SUMMARY_SECTIONS: "verdict",
  });
  spyOn(core, "setOutput").mockImplementation(() => {});
});
afterEach(async () => {
  mock.restore();
  for (const key of Object.keys(process.env))
    if (managedKey(key) && !saved.has(key)) delete process.env[key];
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

function bindOwnedSession(kit: any, run: ReviewLifecycleRun) {
  const comment = {
    id: 55,
    body: `${SUMMARY_MARKER}\n${encodeReviewState(run.state)}\n<!-- droid-review-active:v1 head=${HEAD} run=${RUN_ID} attempt=${RUN_ATTEMPT} -->`,
    user: { id: 138933559, login: "factory-droid[bot]", type: "Bot" },
    issue_url: "https://api.github.com/repos/o/r/issues/7",
  };
  let liveHead = HEAD;
  const update = kit.rest.issues.updateComment;
  kit.graphql = async () => ({ viewer: { login: "factory-droid[bot]" } });
  kit.rest.issues.getComment = async (input: unknown) => {
    expect(input).toEqual({ owner: "o", repo: "r", comment_id: 55 });
    return { data: structuredClone(comment) };
  };
  kit.rest.issues.updateComment = async (input: { body: string }) => {
    const response = await update(input);
    comment.body = input.body;
    return response;
  };
  kit.rest.pulls ??= {};
  kit.rest.pulls.get = async (input: unknown) => {
    expect(input).toEqual({ owner: "o", repo: "r", pull_number: 7 });
    return {
      data: {
        title: "Trusted security completion fixture",
        body: "author text",
        head: { sha: liveHead },
        base: { sha: "b".repeat(40) },
      },
    };
  };
  return {
    comment,
    setLiveHead(value: string) {
      liveHead = value;
    },
  };
}

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
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: false,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      bindOwnedSession(kit, run);
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
      expect(comment).toContain(
        `droid-review-completed:v1 head=${HEAD} run=${RUN_ID} attempt=${RUN_ATTEMPT}`,
      );
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
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: true,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      bindOwnedSession(kit, run);
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
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: true,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      bindOwnedSession(kit, run);
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: { state, summary: { security: { enabled: true } } },
      });
      expect(decodeReviewState(comment)).not.toBeNull();
      expect(decodeReviewState(comment)?.securityReviewedHead).toBeUndefined();
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
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
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
      bindOwnedSession(kit, run);
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

  for (const invalid of [
    "missing run",
    "foreign author",
    "current head",
    "foreign PR",
    "foreign run",
    "foreign attempt",
    "unknown attempt",
    "stale session head",
    "quoted session",
  ]) {
    it(`does not publish completion with ${invalid} authority`, async () => {
      process.env.REVIEW_SUMMARY = "comment";
      let written = "";
      const kit: any = {
        rest: {
          issues: {
            updateComment: async ({ body }: { body: string }) => {
              written = body;
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
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        state: { head: HEAD, findings: [] },
        automatic: true,
        securityOnly: true,
        startedAt: new Date().toISOString(),
        steps: [],
      };
      const fixture = bindOwnedSession(kit, run);
      if (invalid === "missing run") delete run.runId;
      if (invalid === "unknown attempt") delete run.runAttempt;
      if (invalid === "foreign author")
        fixture.comment.user = { id: 5, login: "human", type: "User" };
      if (invalid === "current head") fixture.setLiveHead("b".repeat(40));
      if (invalid === "foreign PR")
        fixture.comment.issue_url = "https://api.github.com/repos/o/r/issues/8";
      if (invalid === "foreign run")
        fixture.comment.body = fixture.comment.body.replace(
          "run=123",
          "run=456",
        );
      if (invalid === "foreign attempt")
        fixture.comment.body = fixture.comment.body.replace(
          "attempt=2",
          "attempt=3",
        );
      if (invalid === "stale session head")
        fixture.comment.body = fixture.comment.body.replace(
          `head=${HEAD}`,
          `head=${"b".repeat(40)}`,
        );
      if (invalid === "quoted session")
        fixture.comment.body = `${SUMMARY_MARKER}\n\`\`\`md\n${fixture.comment.body}\n\`\`\``;
      await finishReviewLifecycle({
        octokit: kit,
        run,
        input: { state: "clean" },
      });
      expect(written).toBe("");
    });
  }
});
