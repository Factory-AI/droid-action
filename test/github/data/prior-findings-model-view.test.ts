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
import { createHash } from "crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { computeReviewArtifacts } from "../../../src/github/data/review-artifacts";
import type { Octokits } from "../../../src/github/api/client";
import type { ReviewFinding } from "../../../src/core/review/validated/types";
import * as incremental from "../../../src/core/review/incremental";
import { generateReviewCandidatesPrompt } from "../../../src/create-prompt/templates/review-candidates-prompt";
import { generateReviewValidatorPrompt } from "../../../src/create-prompt/templates/review-validator-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";
import { generateGitlabReviewCandidatesPrompt } from "../../../src/gitlab/prompts/candidates";
import { generateGitlabReviewValidatorPrompt } from "../../../src/gitlab/prompts/validator";
import type { GitlabReviewPromptContext } from "../../../src/gitlab/prompts/types";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,4 +1,4 @@\n-old one\n+new one\n context two\n-old three\n+new three\n context four\n";
const RENAME =
  "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1,0 +2,1 @@\n+restored\n";

type HistoryRow = {
  state: "open" | "resolved" | "dismissed";
  finding: ReviewFinding & { future: unknown };
  url: string;
  threadId: string;
};

function row(
  id: string,
  overrides: Partial<ReviewFinding> = {},
  state: HistoryRow["state"] = "open",
): HistoryRow {
  const threadId = `thread-${id}`;
  const url = `https://example.invalid/review/${id}`;
  return {
    state,
    url,
    threadId,
    finding: {
      id,
      title: `Preserve ${id}`,
      severity: "P1",
      category: "correctness",
      security: false,
      path: "src/a.ts",
      line: 1,
      startLine: null,
      side: "RIGHT",
      also_at: [{ path: "src/elsewhere.ts", line: 19 }],
      body: "Exact body α e\u0301\nhttps://example.invalid/evidence",
      why: "The prior request loses its timeout.",
      verification: "Original source and test evidence.",
      agent_prompt: "Verify current code independently.",
      outside_diff: false,
      source_guideline: { path: "AGENTS.md", startLine: 3, line: 5 },
      threadId,
      threadUrl: url,
      state,
      future: {
        explicitNull: null,
        nested: [0, false, "", null, { evidence: "Keep unknown fields." }],
      },
      ...overrides,
    },
  };
}

type Fixture = {
  name: string;
  rows: HistoryRow[];
  openPositions: number[];
  eligiblePositions: number[];
  diff?: string;
  missingPriorDiff?: boolean;
  firstReview?: boolean;
};

const fixtures: Fixture[] = [
  {
    name: "empty-history",
    rows: [],
    openPositions: [],
    eligiblePositions: [],
  },
  {
    name: "first-review-empty-revision",
    rows: [row("prior")],
    openPositions: [0],
    eligiblePositions: [],
    firstReview: true,
  },
  {
    name: "empty-prior-diff",
    rows: [row("open")],
    openPositions: [0],
    eligiblePositions: [],
    diff: "",
  },
  {
    name: "unavailable-prior-diff",
    rows: [row("open")],
    openPositions: [0],
    eligiblePositions: [],
    missingPriorDiff: true,
  },
  {
    name: "unchanged-context-is-not-eligible",
    rows: [row("context", { line: 2 })],
    openPositions: [0],
    eligiblePositions: [],
  },
  {
    name: "one-eligible",
    rows: [row("one")],
    openPositions: [0],
    eligiblePositions: [0],
  },
  {
    name: "ambiguous-ids-and-history",
    rows: [
      row("same", { line: 2, body: "Unchanged same-ID evidence." }),
      row("same", { body: "Changed same-ID evidence." }),
      row("dismissed", {}, "dismissed"),
      row("resolved", { fixedIn: OLD }, "resolved"),
      row("null", { line: null, outside_diff: true }),
      row("left", { path: "src/new.ts", oldPath: "src/old.ts", side: "LEFT" }),
      row("range", { startLine: 2, line: 4 }),
    ],
    openPositions: [0, 1, 4, 5, 6],
    eligiblePositions: [1, 2, 3, 4],
    diff: DIFF + RENAME,
  },
  {
    name: "repeated-eligible-ids-keep-order",
    rows: [
      row("duplicate", { body: "First eligible occurrence." }),
      row("duplicate", { line: 2, body: "Ineligible middle occurrence." }),
      row("duplicate", { line: 3, body: "Last eligible occurrence." }),
    ],
    openPositions: [0, 1, 2],
    eligiblePositions: [0, 2],
  },
  {
    name: "long-eligible-history",
    rows: Array.from({ length: 32 }, (_, index) =>
      row(`long-${index}`, {
        body: `Complete evidence ${index}: α e\u0301\n`.repeat(96),
      }),
    ),
    openPositions: Array.from({ length: 32 }, (_, index) => index),
    eligiblePositions: Array.from({ length: 32 }, (_, index) => index),
  },
];

const envKeys = [
  "REVIEW_LIFECYCLE_PATH",
  "REVIEW_CONFIG",
  "REVIEW_IGNORE_PATHS",
  "REVIEW_PRIOR_FINDINGS_PATH",
  "REVIEW_CANDIDATES_PATH",
  "REVIEW_VALIDATED_PATH",
  "SECURITY_REVIEW_ENABLED",
];

async function capture(name: string, value: string): Promise<void> {
  const directory = process.env.TASK17_CAPTURE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), value);
}

async function compareBaseline(name: string, value: string): Promise<void> {
  const directory = process.env.TASK17_BASELINE_DIR;
  if (directory) {
    expect(value).toBe(await readFile(join(directory, name), "utf8"));
  }
}

describe("GitHub prior findings model view", () => {
  let directory: string;
  let priorPath: string;
  let saved: Map<string, string | undefined>;

  beforeEach(async () => {
    saved = new Map(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    directory = await mkdtemp(join(tmpdir(), "github-prior-view-"));
    priorPath = join(directory, "droid-prompts/review_prior_findings.json");
    process.env.REVIEW_LIFECYCLE_PATH = join(directory, "lifecycle.json");
    process.env.REVIEW_PRIOR_FINDINGS_PATH = priorPath;
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Live network is forbidden in this fixture.");
    });
    spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("Synthetic unavailable previous tree.");
    });
  });

  afterEach(async () => {
    mock.restore();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function produce(fixture: Fixture, lifecycle = true) {
    const state = {
      head: fixture.firstReview ? "" : OLD,
      findings: fixture.rows,
    };
    const original = JSON.stringify({ head: HEAD, state, full: true });
    if (lifecycle) {
      await writeFile(process.env.REVIEW_LIFECYCLE_PATH!, original);
    }
    spyOn(childProcess, "execSync").mockImplementation(((
      command: string,
    ) => {
      if (command === "git rev-parse --is-shallow-repository")
        return "false\n";
      if (command.startsWith("git fetch origin main:")) return "";
      if (command.startsWith("git cat-file -e ")) return "";
      if (command.startsWith("git merge-base ")) return BASE;
      if (command.startsWith("git --no-pager diff "))
        return fixture.diff ?? DIFF;
      throw new Error(`Unexpected synthetic command: ${command}`);
    }) as typeof childProcess.execSync);
    const octokit = {
      rest: {
        issues: { listComments: async () => ({ data: [] }) },
        pulls: { listReviewComments: async () => ({ data: [] }) },
        repos: {
          compareCommitsWithBasehead: async () => {
            throw new Error("Synthetic unavailable comparison.");
          },
        },
      },
    } as unknown as Octokits;
    const artifacts = await computeReviewArtifacts({
      baseRef: "main",
      tempDir: directory,
      octokit,
      owner: "owner",
      repo: "repo",
      prNumber: 17,
      title: "Synthetic rereview",
      body: "Retain the complete description.",
      headRevision: HEAD,
      incrementalBaseSha:
        fixture.missingPriorDiff || fixture.firstReview ? undefined : OLD,
    });
    if (lifecycle) {
      expect(await readFile(process.env.REVIEW_LIFECYCLE_PATH!, "utf8")).toBe(
        original,
      );
    }
    return artifacts;
  }

  for (const fixture of fixtures) {
    it(`preserves exact evidence and eligible order: ${fixture.name}`, async () => {
      const expectedOpen = fixture.openPositions.map(
        (index) => fixture.rows[index]!.finding,
      );
      const expectedChanged = fixture.eligiblePositions.map(
        (index) => expectedOpen[index]!,
      );
      const expectedLegacy = JSON.stringify(
        {
          head: HEAD,
          reviewedHead: fixture.firstReview ? "" : OLD,
          openFindings: expectedOpen,
          changedFindings: expectedChanged,
          eligibleFixedIds: expectedChanged.map((finding) => finding.id),
        },
        null,
        2,
      );
      await produce(fixture);
      const bytes = await readFile(priorPath, "utf8");
      await capture(`${fixture.name}.json`, bytes);
      const actual = JSON.parse(bytes);
      console.log(
        JSON.stringify({
          fixture: fixture.name,
          bytes: Buffer.byteLength(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          openRecords: actual.openFindings.length,
          repeatedRecords: actual.changedFindings?.length ?? 0,
          indexes: actual.changedFindingIndexes ?? null,
        }),
      );
      expect(actual.openFindings).toEqual(expectedOpen);
      expect(actual.eligibleFixedIds).toEqual(
        expectedChanged.map((finding) => finding.id),
      );
      // The unfixed real producer reaches this assertion with duplicated rows.
      expect(actual.version).toBe(2);
      expect(actual).not.toHaveProperty("changedFindings");
      expect(actual.changedFindingIndexes).toEqual(fixture.eligiblePositions);
      const reconstructed = actual.changedFindingIndexes.map(
        (index: number) => actual.openFindings[index],
      );
      const legacy = JSON.stringify(
        {
          head: actual.head,
          reviewedHead: actual.reviewedHead,
          openFindings: actual.openFindings,
          changedFindings: reconstructed,
          eligibleFixedIds: actual.eligibleFixedIds,
        },
        null,
        2,
      );
      expect(legacy).toBe(expectedLegacy);
      await compareBaseline(`${fixture.name}.json`, legacy);
    });
  }

  it("does not create a prior manifest without a lifecycle", async () => {
    await produce(fixtures[0]!, false);
    await expect(readFile(priorPath, "utf8")).rejects.toThrow();
  });

  it("retains detached same-ID evidence in the legacy fallback", async () => {
    const detached = {
      ...row("same").finding,
      body: "Detached evidence must not be replaced by the same-ID open row.",
    };
    spyOn(incremental, "changedFindingCandidates").mockReturnValue([detached]);
    await produce({
      name: "fallback",
      rows: [row("same")],
      openPositions: [0],
      eligiblePositions: [0],
    });
    const bytes = await readFile(priorPath, "utf8");
    await capture("detached-fallback.json", bytes);
    const actual = JSON.parse(bytes);
    expect(actual).not.toHaveProperty("version");
    expect(actual).not.toHaveProperty("changedFindingIndexes");
    expect(actual.openFindings).toEqual([row("same").finding]);
    expect(actual.changedFindings).toEqual([detached]);
    expect(actual.eligibleFixedIds).toEqual(["same"]);
    await compareBaseline("detached-fallback.json", bytes);
  });

  it("teaches actual GitHub code and security readers the versioned format", async () => {
    const artifacts = await produce(fixtures[5]!);
    const context: PreparedContext = {
      repository: "owner/repo",
      triggerPhrase: "@droid",
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: "17",
        baseBranch: "main",
      },
      prBranchData: { headRefName: "feature", headRefOid: HEAD },
      reviewArtifacts: artifacts,
    };
    const prompts: Array<{ pass: string; prompt: string }> = [];
    for (const security of [false, true]) {
      process.env.SECURITY_REVIEW_ENABLED = String(security);
      for (const [pass, generate] of [
        ["candidate", generateReviewCandidatesPrompt],
        ["validator", generateReviewValidatorPrompt],
      ] as const) {
        const prompt = generate(context);
        const name = `${pass}-${security ? "security" : "code"}.txt`;
        await capture(name, prompt.replaceAll(directory, "$FIXTURE_TEMP"));
        console.log(
          JSON.stringify({ reader: name, bytes: Buffer.byteLength(prompt) }),
        );
        prompts.push({ pass, prompt });
      }
    }
    for (const { pass, prompt } of prompts) {
      expect(prompt).toContain(priorPath);
      expect(prompt).toContain("changedFindingIndexes");
      expect(prompt).toMatch(/zero-based/);
      expect(prompt).toMatch(/version 2/);
      expect(prompt).toMatch(/legacy/i);
      if (pass === "validator") {
        expect(prompt).toContain("eligibleFixedIds");
        expect(prompt).toContain("and absent candidates do NOT prove a fix");
        expect(prompt).toContain("one entry per candidate");
        expect(prompt).toContain("nonempty `evidence`");
      }
    }
  });

  it("keeps actual GitLab prompt bytes and schema separate", async () => {
    const context: GitlabReviewPromptContext = {
      projectPath: "group/project",
      mrIid: 17,
      mrTitle: "Synthetic rereview",
      sourceBranch: "feature",
      targetBranch: "main",
      headSha: HEAD,
      diffPath: "/tmp/task17/pr.diff",
      commentsPath: "/tmp/task17/comments.json",
      descriptionPath: "/tmp/task17/description.txt",
      candidatesPath: "/tmp/task17/candidates.json",
      validatedPath: "/tmp/task17/validated.json",
      priorFindingsPath: "/tmp/task17/gitlab-prior.json",
      includeSuggestions: true,
      securityReviewEnabled: false,
    };
    for (const [name, generate] of [
      ["gitlab-candidate.txt", generateGitlabReviewCandidatesPrompt],
      ["gitlab-validator.txt", generateGitlabReviewValidatorPrompt],
    ] as const) {
      const prompt = generate(context);
      await capture(name, prompt);
      await compareBaseline(name, prompt);
      expect(prompt).not.toContain("changedFindingIndexes");
      if (name.includes("validator")) {
        expect(prompt).toContain("`openFindings` and `changedFindings`");
      }
    }
  });
});
