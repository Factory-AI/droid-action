import { describe, expect, it } from "bun:test";
import { RiskPlanSchema } from "../../../src/core/risk/types";
import { compilePrRiskVerdictSchema } from "../../../src/core/risk/verdict";
import { planFor } from "./fixtures";

const base = { verdict: true, brief: "- Fine.", details: "Fixed." };

describe("compilePrRiskVerdictSchema", () => {
  const schema = compilePrRiskVerdictSchema({}, { incremental: true });

  it("keeps a full judgment to verdict, brief, details and scores", () => {
    const full = compilePrRiskVerdictSchema({});
    expect(full.safeParse(base).success).toBe(true);
    for (const extra of [
      { resolvedConcerns: [] },
      { checks: [{ command: "bun test", exitCode: 0, covers: [] }] },
    ]) {
      expect(full.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it("accepts the concerns a re-check resolved and the checks it ran", () => {
    const answer = {
      ...base,
      resolvedConcerns: [{ concern: "c1", evidence: "`src/a.ts:12` retries." }],
      checks: [
        {
          command: "bun test test/a.test.ts",
          exitCode: 0,
          covers: ["src/a.ts"],
          // A key the contract does not name, inside one listed check.
          note: "passed",
        },
      ],
    };

    expect(schema.parse(answer)).toEqual({
      ...base,
      resolvedConcerns: answer.resolvedConcerns,
      checks: [
        {
          command: "bun test test/a.test.ts",
          exitCode: 0,
          covers: ["src/a.ts"],
        },
      ],
    });
  });

  it.each([
    [
      "a concern id Factory never serves",
      { resolvedConcerns: [{ concern: "first", evidence: "x" }] },
    ],
    [
      "a check without its exit code",
      { checks: [{ command: "bun test", covers: [] }] },
    ],
    ["a key outside the contract", { resolved: true }],
    [
      // Cut to length, it would run as `true`, without the failing tail.
      "a check command too long to run as written",
      {
        checks: [
          {
            command: `true #${"x".repeat(500)}\nfalse`,
            exitCode: 0,
            covers: [],
          },
        ],
      },
    ],
  ])("rejects %s", (_name, extra) => {
    expect(schema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});

describe("RiskPlanSchema", () => {
  it("keeps a declined prior's outcome and concerns for the judge", () => {
    const prior = {
      verdict: false,
      outcome: "doNotApprove",
      brief: "- `src/a.ts:12` drops the retry.",
      details: "See above.",
      concerns: [{ id: "c1", text: "`src/a.ts:12` drops the retry." }],
    };

    expect(
      RiskPlanSchema.parse({
        ...planFor(),
        incremental: {
          mode: "shadow",
          reason: "prior_concern_targeted",
          priorHeadSha: "e".repeat(40),
          priorBaseSha: "f".repeat(40),
          prior,
        },
      }).incremental?.prior,
    ).toEqual(prior);
  });
});
