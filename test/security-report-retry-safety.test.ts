import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { handleUpdatePRDescription } from "../src/mcp/github-pr-server";
import { DroidRunType } from "../src/run-type";

const SOURCE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HUMAN_BODY = "A human changed this report after the first PATCH failed.";
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, {
    DROID_EXEC_RUN_TYPE: DroidRunType.SecurityScan,
    SECURITY_REPORT_SOURCE_REVISION: SOURCE,
    SECURITY_REPORT_BRANCH: "droid/security-report-2026-10-30",
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

type Mutation = "body" | "head" | "closed" | "applied-response-lost" | "none";
function fixture(mutation: Mutation) {
  const stored = {
    state: "open",
    merged: false,
    body: "Original owned report placeholder",
    user: { login: "factory-droid[bot]", type: "Bot" },
    head: {
      sha: HEAD,
      ref: "droid/security-report-2026-10-30",
      repo: { full_name: "o/r" },
    },
    base: { ref: "main", repo: { full_name: "o/r" } },
  };
  const writes: Array<{ body: string }> = [];
  const firstFailure = Object.assign(
    new Error("Transient PATCH response failure"),
    { status: 503 },
  );
  let reads = 0;
  const octokit: any = {
    rest: {
      pulls: {
        get: async () => {
          reads++;
          return { data: structuredClone(stored) };
        },
        update: async (args: { body: string }) => {
          writes.push(structuredClone(args));
          if (writes.length === 1) {
            if (mutation === "body") stored.body = HUMAN_BODY;
            if (mutation === "head") stored.head.sha = "c".repeat(40);
            if (mutation === "closed") stored.state = "closed";
            if (mutation === "applied-response-lost") stored.body = args.body;
            throw firstFailure;
          }
          stored.body = args.body;
          return { data: {} };
        },
      },
    },
  };
  const body = JSON.stringify({
    version: 1,
    results: [
      {
        status: "approved",
        comment: {
          id: "scan-1",
          title: "Unsafe sink",
          severity: "P1",
          security: true,
          body: "Original evidence",
          path: "src/original.ts",
          line: 4,
          outside_diff: true,
        },
      },
    ],
    securityReport: {
      sourceRevision: SOURCE,
      outcomes: [{ id: "scan-1", disposition: "manual" }],
    },
  });
  return {
    stored,
    writes,
    firstFailure,
    reads: () => reads,
    publish: (mode: "security-report" | "replace" = "security-report") =>
      handleUpdatePRDescription({
        owner: "o",
        repo: "r",
        prNumber: 7,
        body: mode === "replace" ? "Ordinary description" : body,
        mode,
        octokit,
      }),
  };
}

describe("scan description PATCH is single-attempt after its immutable live guard", () => {
  for (const mutation of [
    "body",
    "head",
    "closed",
    "applied-response-lost",
  ] as const) {
    it(`${mutation}: a failed first PATCH never triggers a stale second write or false success`, async () => {
      const f = fixture(mutation);
      let returned: string | undefined;
      let failure: unknown;
      try {
        returned = await f.publish();
      } catch (error) {
        failure = error;
      }
      expect(f.writes).toHaveLength(1);
      expect(returned).toBeUndefined();
      expect(failure).toBe(f.firstFailure);
      expect(f.reads()).toBe(2);
      if (mutation === "body") expect(f.stored.body).toBe(HUMAN_BODY);
      if (mutation === "head") expect(f.stored.head.sha).toBe("c".repeat(40));
      if (mutation === "closed") expect(f.stored.state).toBe("closed");
      if (mutation === "applied-response-lost")
        expect(f.stored.body).toBe(f.writes[0]!.body);
    });
  }
  it("ordinary description tools keep their existing transient retry policy", async () => {
    process.env.DROID_EXEC_RUN_TYPE = DroidRunType.Default;
    const f = fixture("none");
    const body = await f.publish("replace");
    expect(f.writes).toHaveLength(2);
    expect(body).toBe("Ordinary description");
    expect(f.stored.body).toBe(body);
    expect(f.reads()).toBe(0);
  });
});
