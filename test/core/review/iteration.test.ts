import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as childProcess from "child_process";
import { mkdtemp, mkdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  FOLLOWUP_DROP_REASONS,
  followupBarApplies,
  followupDropReason,
  parseReviewIterationContext,
  priorFindingSummaries,
  renderReviewIterationSection,
  reviewIterationContext,
  reviewRound,
  type ReviewIterationContext,
} from "../../../src/core/review/iteration";
import { changedReviewLines } from "../../../src/core/review/incremental";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import type { ReviewState } from "../../../src/core/review/markers";
import { generateCandidatesPrompt } from "../../../src/core/review/prompts/candidates";
import { generateValidatorPrompt } from "../../../src/core/review/prompts/validator";
import type { ReviewPromptContext } from "../../../src/core/review/prompts/types";
import { renderReviewSummary } from "../../../src/core/review/render";
import { GITHUB_TERMINOLOGY } from "../../../src/create-prompt/terminology";
import { computeReviewArtifacts } from "../../../src/github/data/review-artifacts";
import { saveReviewLifecycle } from "../../../src/github/operations/review-lifecycle";
import type { Octokits } from "../../../src/github/api/client";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const OLDER = "e".repeat(40);
const BASE = "c".repeat(40);

const finding = (overrides: Record<string, unknown> = {}) =>
  normalizeFinding({
    id: "f-new",
    title: "Retries never stop",
    severity: "P1",
    category: "correctness",
    path: "src/x.ts",
    line: 2,
    body: "The retry loop has no exit.",
    ...overrides,
  });

function iteration(
  overrides: Partial<ReviewIterationContext> = {},
): ReviewIterationContext {
  return {
    round: 2,
    reviewedHeads: 1,
    full: false,
    skill: false,
    followupThreshold: "P1",
    followupBar: true,
    priorFindings: [
      {
        id: "f-old",
        title: "Timeout is ignored",
        severity: "P1",
        category: "correctness",
        security: false,
        location: "src/x.ts:1",
        resolution: "replied",
        reply: "This is intentional; the caller sets the timeout.",
      },
    ],
    ...overrides,
  };
}

function promptContext(
  reviewIteration?: ReviewIterationContext,
): ReviewPromptContext {
  return {
    terminology: GITHUB_TERMINOLOGY,
    postingMode: "file",
    entityNumber: 7,
    repoOrProject: "o/r",
    headRef: "feature",
    headSha: HEAD,
    baseRef: "main",
    diffPath: "/tmp/pr.diff",
    commentsPath: "/tmp/comments.json",
    descriptionPath: "/tmp/description.txt",
    candidatesPath: "/tmp/candidates.json",
    validatedPath: "/tmp/validated.json",
    includeSuggestions: true,
    securityReviewEnabled: false,
    reviewIteration,
  };
}

describe("review round", () => {
  it("counts distinct earlier heads and treats missing history as round 1", () => {
    expect(reviewRound(undefined, HEAD)).toBe(1);
    expect(reviewRound({}, HEAD)).toBe(1);
    expect(reviewRound({ reviewed: [] }, HEAD)).toBe(1);
    expect(reviewRound({ reviewed: [OLD] }, HEAD)).toBe(2);
    expect(reviewRound({ reviewed: [OLDER, OLD, OLD] }, HEAD)).toBe(3);
    // Re-reviewing the same head does not advance the round.
    expect(reviewRound({ reviewed: [OLD, HEAD] }, HEAD)).toBe(2);
  });

  it("applies the follow-up bar from round 2 except for --full runs and a P2 threshold", () => {
    expect(followupBarApplies({ round: 1, threshold: "P1" })).toBe(false);
    expect(followupBarApplies({ round: 2, threshold: "P1" })).toBe(true);
    expect(followupBarApplies({ round: 5, threshold: "P0" })).toBe(true);
    expect(followupBarApplies({ round: 2, full: true, threshold: "P1" })).toBe(
      false,
    );
    expect(followupBarApplies({ round: 2, threshold: "P2" })).toBe(false);
    expect(followupBarApplies({ round: 2, skill: true, threshold: "P1" })).toBe(
      false,
    );
  });

  it("keeps the round count across a --full run", () => {
    const state: ReviewState = { head: OLD, reviewed: [OLD], findings: [] };
    const full = reviewIterationContext({
      state,
      head: HEAD,
      full: true,
      threshold: "P1",
    });
    expect(full).toMatchObject({ round: 2, full: true, followupBar: false });
    expect(
      reviewIterationContext({
        state,
        head: HEAD,
        skill: true,
        threshold: "P1",
      }),
    ).toMatchObject({ round: 2, skill: true, followupBar: false });
    const next = reviewIterationContext({
      state: { ...state, head: HEAD, reviewed: [OLD, HEAD] },
      head: "d".repeat(40),
      threshold: "P1",
    });
    expect(next).toMatchObject({ round: 3, full: false, followupBar: true });
  });
});

describe("follow-up drop reasons", () => {
  const added = changedReviewLines(
    "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,3 @@\n context\n+added\n context\n",
  );

  it("drops non-security findings below the threshold and keeps security findings", () => {
    expect(
      followupDropReason(finding({ severity: "P2" }), { threshold: "P1" }),
    ).toBe(FOLLOWUP_DROP_REASONS.severity);
    expect(
      followupDropReason(finding({ severity: "P1" }), { threshold: "P0" }),
    ).toBe(FOLLOWUP_DROP_REASONS.severity);
    expect(
      followupDropReason(
        finding({ severity: "P2", security: true, securitySeverity: "low" }),
        { threshold: "P1" },
      ),
    ).toBeUndefined();
    expect(
      followupDropReason(finding({ severity: "P1" }), { threshold: "P1" }),
    ).toBeUndefined();
  });

  it("drops maintainability and guideline findings only on lines added since the last review", () => {
    const options = { threshold: "P1" as const, addedSinceLastReview: added };
    expect(
      followupDropReason(finding({ category: "maintainability" }), options),
    ).toBe(FOLLOWUP_DROP_REASONS.maintainability);
    expect(
      followupDropReason(
        finding({ source_guideline: { path: "AGENTS.md", line: 3 } }),
        options,
      ),
    ).toBe(FOLLOWUP_DROP_REASONS.maintainability);
    expect(
      followupDropReason(
        finding({ category: "maintainability", line: 1 }),
        options,
      ),
    ).toBeUndefined();
    expect(
      followupDropReason(
        finding({ category: "maintainability", side: "LEFT" }),
        options,
      ),
    ).toBeUndefined();
    expect(
      followupDropReason(
        finding({ category: "maintainability", security: true }),
        options,
      ),
    ).toBeUndefined();
    expect(followupDropReason(finding(), options)).toBeUndefined();
    expect(
      followupDropReason(finding({ category: "maintainability" }), {
        threshold: "P1",
      }),
    ).toBeUndefined();
  });
});

describe("prior finding resolutions", () => {
  const state = (): ReviewState => ({
    head: OLD,
    reviewed: [OLD],
    findings: [
      {
        id: "f-fixed",
        sev: "P1",
        state: "resolved",
        finding: finding({ id: "f-fixed" }),
      },
      {
        id: "f-dismissed",
        sev: "P2",
        state: "dismissed",
        title: "Name is vague",
        path: "src/y.ts",
        line: 4,
      },
      {
        id: "f-replied",
        sev: "P1",
        state: "open",
        commentId: 81,
        finding: finding({ id: "f-replied" }),
      },
      {
        id: "f-droid-only",
        sev: "P1",
        state: "open",
        commentId: 91,
        finding: finding({ id: "f-droid-only" }),
      },
    ],
  });
  const droid = { login: "factory-droid[bot]" };
  const human = { login: "alice" };

  it("maps state to fixed, dismissed, replied, and open", () => {
    const summaries = priorFindingSummaries(state(), [
      { id: 81, user: droid, body: "finding" },
      { id: 82, in_reply_to_id: 81, user: human, body: "First reply" },
      {
        id: 83,
        in_reply_to_id: 81,
        user: human,
        body: `Declined:\n${"x".repeat(400)}`,
      },
      { id: 91, user: droid, body: "finding" },
      { id: 92, in_reply_to_id: 91, user: droid, body: "Fixed in abc" },
    ]);
    expect(summaries.map((s) => [s.id, s.resolution])).toEqual([
      ["f-fixed", "fixed"],
      ["f-dismissed", "dismissed"],
      ["f-replied", "replied"],
      ["f-droid-only", "open"],
    ]);
    const replied = summaries[2]!;
    expect(replied.reply!.startsWith("Declined: xxx")).toBe(true);
    expect(replied.reply!.length).toBe(300);
    expect(summaries[1]).toMatchObject({
      title: "Name is vague",
      severity: "P2",
      location: "src/y.ts:4",
    });
  });

  it("does not mark a finding replied when its thread root is unknown", () => {
    const summaries = priorFindingSummaries(state(), [
      { id: 82, in_reply_to_id: 81, user: human, body: "Reply" },
    ]);
    expect(summaries[2]!.resolution).toBe("open");
  });

  it("accepts only a well-formed stored iteration block", () => {
    expect(parseReviewIterationContext(iteration())).toEqual(iteration());
    expect(
      parseReviewIterationContext({ ...iteration(), round: "2" }),
    ).toBeUndefined();
    expect(
      parseReviewIterationContext({
        ...iteration(),
        priorFindings: [
          { ...iteration().priorFindings[0], resolution: "approved" },
        ],
      }),
    ).toBeUndefined();
    expect(parseReviewIterationContext(undefined)).toBeUndefined();
  });
});

describe("iteration prompt section", () => {
  it("renders nothing on round 1", () => {
    expect(renderReviewIterationSection(undefined, "candidates")).toBe("");
    expect(
      renderReviewIterationSection(
        iteration({ round: 1, reviewedHeads: 0 }),
        "candidates",
      ),
    ).toBe("");
    const prompt = generateCandidatesPrompt(
      promptContext(iteration({ round: 1, reviewedHeads: 0 })),
    );
    expect(prompt).not.toContain("### Review round");
  });

  it("lists earlier findings with all five rules on a later round", () => {
    const prompt = generateCandidatesPrompt(promptContext(iteration()));
    expect(prompt).toContain("### Review round 2");
    expect(prompt).toContain('"id": "f-old"');
    expect(prompt).toContain('"resolution": "replied"');
    expect(prompt).toContain("the caller sets the timeout");
    expect(prompt).toContain(
      "1. Report only P0/P1 findings and security findings.",
    );
    expect(prompt).toContain("2. Review the new code for defects");
    expect(prompt).toContain("3. Do not contradict earlier rounds");
    expect(prompt).toContain(
      "4. Do not re-raise a fixed, dismissed, or replied finding",
    );
    expect(prompt).toContain("5. Reuse the exact earlier ID");
    expect(prompt).not.toContain("Reject any candidate");
    expect(
      renderReviewIterationSection(
        iteration({ followupThreshold: "P0" }),
        "candidates",
      ),
    ).toContain("1. Report only P0 findings and security findings.");
  });

  it("tells the validator to reject candidates that break rules 1 to 4", () => {
    const prompt = generateValidatorPrompt(promptContext(iteration()));
    expect(prompt).toContain("### Review round 2");
    expect(prompt).toContain("Reject any candidate that breaks rules 1 to 4");
  });

  for (const [name, overrides, label] of [
    ["--full", { full: true }, "requested full review"],
    ["/<skill>", { skill: true }, "requested skill review"],
  ] as const) {
    it(`drops the strict-bar rules on a ${name} run but keeps the consistency rules`, () => {
      const oneOff = iteration({ ...overrides, followupBar: false });
      for (const prompt of [
        generateCandidatesPrompt(promptContext(oneOff)),
        generateValidatorPrompt(promptContext(oneOff)),
      ]) {
        expect(prompt).toContain("### Review round 2");
        expect(prompt).toContain(label);
        expect(prompt).toContain('"id": "f-old"');
        expect(prompt).not.toContain("Report only");
        expect(prompt).not.toContain("do not report duplication");
        expect(prompt).toContain("1. Do not contradict earlier rounds");
        expect(prompt).toContain(
          "2. Do not re-raise a fixed, dismissed, or replied finding",
        );
        expect(prompt).toContain("3. Reuse the exact earlier ID");
      }
      expect(generateValidatorPrompt(promptContext(oneOff))).toContain(
        "Reject any candidate that breaks rules 1 and 2",
      );
    });
  }
  it("caps the listed findings at 40 with open and replied findings first", () => {
    const priorFindings = Array.from({ length: 45 }, (_, i) => ({
      ...iteration().priorFindings[0]!,
      id: `f-${i}`,
      resolution: (i < 44 ? "fixed" : "open") as "fixed" | "open",
      reply: undefined,
    }));
    const section = renderReviewIterationSection(
      iteration({ priorFindings }),
      "candidates",
    );
    expect(section).toContain('"id": "f-44"');
    expect(section).not.toContain('"id": "f-39"');
    expect(section).toContain("5 more earlier findings");
  });
});

describe("summary footer", () => {
  const render = (input: Record<string, unknown>) =>
    renderReviewSummary({ state: "clean", head: HEAD, findings: [], ...input });

  it("names the round and the follow-up bar after the first round", () => {
    expect(
      render({ iteration: { round: 1, full: false, followupThreshold: "P1" } }),
    ).toContain("<sub>Review round 1.</sub>");
    const later = render({
      iteration: { round: 3, full: false, followupThreshold: "P1" },
    });
    expect(later).toContain(
      "Review round 3. After the first round, Droid reports only P0/P1 and security findings",
    );
    expect(later).toContain("review_followup_severity_threshold");
    expect(
      render({ iteration: { round: 3, full: false, followupThreshold: "P2" } }),
    ).toContain("<sub>Review round 3.</sub>");
    expect(
      render({ iteration: { round: 2, full: true, followupThreshold: "P1" } }),
    ).toContain("This full review used the first-round bar");
    expect(
      render({
        iteration: {
          round: 2,
          full: false,
          skill: true,
          followupThreshold: "P1",
        },
      }),
    ).toContain("This skill review used the first-round bar");
    expect(render({})).not.toContain("Review round");
  });
});

describe("iteration artifacts", () => {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), "review-iteration-"));
    await mkdir(join(directory, "droid-prompts"));
    for (const key of Object.keys(process.env))
      if (/^REVIEW_/.test(key)) delete process.env[key];
    process.env.REVIEW_LIFECYCLE_PATH = join(directory, "lifecycle.json");
    spyOn(childProcess, "execSync").mockImplementation(((command: string) => {
      if (command.includes("--is-shallow-repository")) return "false\n";
      if (command.includes("merge-base")) return BASE;
      if (command.includes("--no-pager diff"))
        return "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
      return "";
    }) as typeof childProcess.execSync);
  });
  afterEach(async () => {
    mock.restore();
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  });

  async function compute(full: boolean) {
    await saveReviewLifecycle({
      owner: "o",
      repo: "r",
      prNumber: 7,
      commentId: 40,
      head: HEAD,
      state: {
        head: OLD,
        reviewed: [OLDER, OLD],
        findings: [
          {
            id: "f-known",
            sev: "P1",
            state: "open",
            commentId: 81,
            finding: finding({ id: "f-known" }),
          },
        ],
      },
      automatic: true,
      securityOnly: false,
      startedAt: new Date().toISOString(),
      steps: [],
      full,
      incrementalBaseSha: OLD,
    });
    const octokit = {
      rest: {
        issues: { listComments: async () => ({ data: [] }) },
        pulls: {
          listReviewComments: async () => ({
            data: [
              {
                id: 81,
                user: { login: "factory-droid[bot]" },
                body: "finding",
              },
              {
                id: 82,
                in_reply_to_id: 81,
                user: { login: "alice" },
                body: "Won't fix: by design.",
              },
            ],
          }),
        },
      },
    } as unknown as Octokits;
    return computeReviewArtifacts({
      baseRef: "main",
      tempDir: directory,
      octokit,
      owner: "o",
      repo: "r",
      prNumber: 7,
      title: "PR",
      body: "",
      headRevision: HEAD,
      incrementalBaseSha: OLD,
    });
  }

  it("computes the round and replies from trusted state and stores them for the validator", async () => {
    const artifacts = await compute(false);
    expect(artifacts.iteration).toMatchObject({
      round: 3,
      reviewedHeads: 2,
      full: false,
      followupThreshold: "P1",
      followupBar: true,
      priorFindings: [
        {
          id: "f-known",
          resolution: "replied",
          reply: "Won't fix: by design.",
        },
      ],
    });
    const manifest = JSON.parse(
      await readFile(
        join(directory, "droid-prompts/review_prior_findings.json"),
        "utf8",
      ),
    );
    expect(parseReviewIterationContext(manifest.iteration)).toEqual(
      artifacts.iteration!,
    );
  });

  it("marks a --full run as using the first-round bar without resetting the round", async () => {
    const artifacts = await compute(true);
    expect(artifacts.iteration).toMatchObject({
      round: 3,
      full: true,
      followupBar: false,
    });
  });
});
