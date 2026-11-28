import { describe, expect, it } from "bun:test";
import shape from "../../fixtures/review-state-long-pr-shape.json";
import {
  decodeReviewState,
  encodeReviewState,
  MAX_CLOSED_STATE_BYTES,
  type ReviewState,
  type ReviewStateFinding,
} from "../../../src/core/review/markers";
import {
  MAX_REVIEW_OUTPUT_BYTES,
  outputBytes,
  renderReviewStateNote,
  renderReviewSummary,
  type ReviewRenderInput,
} from "../../../src/core/review/render";
import {
  contextShortened,
  fitReviewOutput,
} from "../../../src/core/review/render/budget";
import { normalizeFinding } from "../../../src/core/review/validated/finding";
import type { ReviewFinding } from "../../../src/core/review/validated/types";

const HEAD = "3".repeat(40);
const text = (length: number, seed: string) =>
  `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length);
const url = (n: number) =>
  `https://github.com/example/repo/pull/7#discussion_r${4619948510 + n}`;

/** Rebuilds the real long-PR state: same counts, states, field lengths, and thread fields. */
function longPrState(): ReviewState {
  const findings: ReviewStateFinding[] = shape.findings.map((item, i) => {
    const id = `f-${i}-${"x".repeat(Math.max(0, item.id - 3 - String(i).length))}`;
    const finding: ReviewFinding = {
      ...normalizeFinding({
        id,
        title: text(item.title, `Title${i}`),
        severity: item.sev,
        category: item.cat,
        path: text(item.path, `src/p${i}`).replace(/ /g, "_"),
        line: item.line,
        side: item.side,
        body: text(item.body, `Body${i}`),
        outside_diff: item.outside,
      }),
      state: item.state as ReviewFinding["state"],
      isNew: false,
      ...(item.thread
        ? { threadUrl: url(i), threadId: `PRRT_kwDOM5mLFc65K${i}` }
        : {}),
      ...(item.pending === "resolve"
        ? { pendingThreadAction: "resolve" as const, fixedIn: "a".repeat(40) }
        : {}),
    };
    return {
      id,
      sev: item.sev as ReviewStateFinding["sev"],
      state: item.state as ReviewStateFinding["state"],
      finding,
      ...(item.thread
        ? {
            thread: `PRRT_kwDOM5mLFc65K${i}`,
            threadId: `PRRT_kwDOM5mLFc65K${i}`,
            commentId: 4619948510 + i,
            url: url(i),
          }
        : {}),
    };
  });
  return {
    head: "1".repeat(40),
    base: "2".repeat(40),
    diffHash: "d".repeat(64),
    reviewed: Array.from({ length: shape.reviewed }, (_, i) =>
      String(i).repeat(40).slice(0, 40),
    ),
    autoRunCount: shape.autoRunCount,
    findings,
  };
}

/** A later round like the one that failed: 13 new findings, a P1 and a P2 outside the diff. */
function newRound(): ReviewFinding[] {
  return Array.from({ length: 13 }, (_, i) => ({
    ...normalizeFinding({
      id: `f-round-${i}`,
      title:
        i === 0
          ? "Retries drop the original request body"
          : `Round finding ${i}`,
      severity: i === 0 ? "P1" : "P2",
      category: "correctness",
      path: `src/round/${i}.ts`,
      line: 10 + i,
      body: text(600, "Body"),
      why: text(600, "Why"),
      verification: text(400, "Verify"),
      agent_prompt: text(1200, "Prompt"),
      outside_diff: i < 2,
    }),
    state: "open" as const,
    isNew: true,
    ...(i >= 2 ? { threadUrl: url(1000 + i), threadId: 9000 + i } : {}),
  }));
}

function summaryInput(state: ReviewState, findings: ReviewFinding[]) {
  return {
    state: "findings" as const,
    head: HEAD,
    repositoryUrl: "https://github.com/example/repo",
    findings,
    reviewState: {
      ...state,
      head: HEAD,
      reviewed: [...(state.reviewed ?? []), HEAD],
      findings: [
        ...state.findings,
        ...findings.map((finding) => ({
          id: finding.id,
          sev: finding.severity,
          state: "open" as const,
          finding,
        })),
      ],
    },
  };
}

/** Bytes of the closed findings in an encoded state, as the budget counts them. */
function closedBytes(encoded: string): number {
  const json = /droid-review-state:v1 (.*) -->/s.exec(encoded)![1]!;
  const items: Array<{ state: string }> = JSON.parse(json).findings;
  return items
    .filter((item) => item.state !== "open")
    .reduce((sum, item) => sum + outputBytes(JSON.stringify(item)) + 1, 0);
}

describe("review state budget", () => {
  it("matches the real long-PR state it was built from", () => {
    const state = longPrState();
    expect(state.findings).toHaveLength(66);
    expect(state.findings.filter((f) => f.state === "dismissed")).toHaveLength(
      64,
    );
    // Before compaction this state cost about as much as the real comment did.
    expect(
      JSON.stringify({
        ...state,
        findings: state.findings.map((f) => ({
          ...f,
          finding: { ...f.finding, state: f.state },
        })),
      }).length,
    ).toBeGreaterThan(50_000);
  });

  it("fits the long-PR state and a new round without shortening it or losing an open finding", () => {
    const state = longPrState();
    const findings = newRound();
    const summary = renderReviewSummary(summaryInput(state, findings));
    expect(outputBytes(summary)).toBeLessThanOrEqual(MAX_REVIEW_OUTPUT_BYTES);
    expect(summary).not.toContain("shortened to fit the output limit");
    // The P1 outside the diff is published in the summary, with its location.
    expect(summary).toContain("Retries drop the original request body");
    expect(summary).toContain("src/round/0.ts:10");
    const decoded = decodeReviewState(summary)!;
    const ids = new Set(decoded.findings.map((f) => f.id));
    // Every open, pending, or thread-less finding is kept. Only closed
    // findings with a thread, which the next post reloads, may be dropped.
    for (const item of state.findings)
      if (
        item.state === "open" ||
        item.finding?.pendingThreadAction ||
        item.threadId === undefined
      )
        expect(ids.has(item.id)).toBe(true);
    for (const finding of findings) expect(ids.has(finding.id)).toBe(true);
    expect(ids.size).toBeGreaterThan(40);
    expect(decoded.reviewed).toHaveLength(shape.reviewed + 1);
  });
  it("keeps what dedupe, reopening, and later rounds read for closed findings", () => {
    const state = longPrState();
    const decoded = decodeReviewState(encodeReviewState(state))!;
    const dismissed = decoded.findings.find(
      (f) => f.state === "dismissed" && f.threadId !== undefined,
    )!;
    const original = state.findings.find((f) => f.id === dismissed.id)!;
    expect(dismissed).toMatchObject({
      id: original.id,
      sev: original.sev,
      state: "dismissed",
      threadId: original.threadId,
      commentId: original.commentId,
      path: original.finding!.path,
      line: original.finding!.line!,
      title: original.finding!.title,
    });
    expect(dismissed.finding).toMatchObject({
      category: original.finding!.category,
      side: "RIGHT",
      body: "",
    });
    // Pending thread work keeps its full record so it can be retried.
    const pending = decoded.findings.find(
      (f) => f.finding?.pendingThreadAction === "resolve",
    )!;
    expect(pending.finding?.fixedIn).toBe("a".repeat(40));
    expect(pending.finding?.body).toBe(
      state.findings.find((f) => f.finding?.pendingThreadAction)!.finding!.body,
    );
  });

  it("trims only the hidden copy of threaded open findings, and only when the summary would not fit", () => {
    const outside = newRound()[0]!;
    const threaded = { ...newRound()[2]!, body: text(5000, "Body") };
    const reviewState: ReviewState = {
      head: HEAD,
      findings: [
        { id: outside.id, sev: "P1", state: "open", finding: outside },
        {
          id: threaded.id,
          sev: "P2",
          state: "open",
          finding: threaded,
          url: url(1),
        },
      ],
    };
    const roomy = decodeReviewState(encodeReviewState(reviewState))!;
    expect(outputBytes(roomy.findings[1]!.finding!.body)).toBeGreaterThan(2000);

    const input: ReviewRenderInput = {
      state: "findings",
      head: HEAD,
      reviewState,
    };
    const attempted: ReviewRenderInput[] = [];
    // Overflows by 1 KiB with the full copy; the threaded body alone is ~5 KiB.
    const padding = "x".repeat(
      MAX_REVIEW_OUTPUT_BYTES -
        outputBytes(renderReviewStateNote(reviewState)) +
        1024,
    );
    const body = fitReviewOutput(input, (compact) => {
      attempted.push(compact);
      return `${renderReviewStateNote(compact.reviewState)}\n\n${padding}`;
    });
    expect(attempted).toHaveLength(2);
    expect(contextShortened(attempted[1]!, input)).toBe(false);
    expect(body).not.toContain("Some optional review context");
    const decoded = decodeReviewState(body)!;
    expect(decoded.findings[0]!.finding).toMatchObject({
      body: outside.body,
      why: outside.why,
      verification: outside.verification,
      agent_prompt: outside.agent_prompt,
    });
    const copy = decoded.findings[1]!.finding!;
    expect(copy.id).toBe(threaded.id);
    expect(copy.title).toBe(threaded.title);
    expect(outputBytes(copy.body)).toBeLessThan(500);
    expect(outputBytes(copy.agent_prompt)).toBeLessThan(500);
    expect(decoded.findings[1]!.url).toBe(url(1));
  });
  it("drops only closed findings, thread-backed and oldest first, to stay within budget", () => {
    const closed = (i: number, threaded: boolean): ReviewStateFinding => ({
      id: `f-closed-${i}`,
      sev: "P2",
      state: i % 2 ? "dismissed" : "resolved",
      finding: {
        ...normalizeFinding({
          id: `f-closed-${i}`,
          title: text(140, `Closed${i}`),
          severity: "P2",
          path: `src/closed/${i}.ts`,
          line: 1,
          body: text(300, "Body"),
        }),
        state: i % 2 ? "dismissed" : "resolved",
      },
      ...(threaded ? { threadId: `PRRT_${i}`, commentId: 1000 + i } : {}),
    });
    const open = newRound().map((finding) => ({
      id: finding.id,
      sev: finding.severity,
      state: "open" as const,
      finding,
    }));
    const state: ReviewState = {
      head: HEAD,
      reviewed: [HEAD],
      findings: [
        ...Array.from({ length: 5 }, (_, i) => closed(i, false)),
        ...Array.from({ length: 300 }, (_, i) => closed(100 + i, true)),
        ...open,
      ],
    };
    const encoded = encodeReviewState(state);
    const decoded = decodeReviewState(encoded)!;
    const ids = decoded.findings.map((f) => f.id);
    // Every open finding and every thread-less closed finding survives.
    for (const finding of open) expect(ids).toContain(finding.id);
    for (let i = 0; i < 5; i++) expect(ids).toContain(`f-closed-${i}`);
    // Thread-backed closed findings are dropped from the oldest end only.
    const kept = ids
      .filter((id) => /^f-closed-\d{3}$/.test(id))
      .map((id) => Number(id.slice(9)));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(300);
    expect(kept).toEqual(
      Array.from({ length: kept.length }, (_, i) => 400 - kept.length + i),
    );
    expect(closedBytes(encoded)).toBeLessThanOrEqual(MAX_CLOSED_STATE_BYTES);
  });

  it("drops thread-less closed findings only when thread-backed ones are gone", () => {
    const state: ReviewState = {
      head: HEAD,
      findings: Array.from({ length: 400 }, (_, i) => ({
        id: `f-${i}`,
        sev: "P2" as const,
        state: "dismissed" as const,
        finding: normalizeFinding({
          id: `f-${i}`,
          title: text(140, "Closed"),
          severity: "P2",
          path: `src/${i}.ts`,
          body: "x",
        }),
      })),
    };
    const encoded = encodeReviewState(state);
    expect(closedBytes(encoded)).toBeLessThanOrEqual(MAX_CLOSED_STATE_BYTES);
    const ids = decodeReviewState(encoded)!.findings.map((f) => f.id);
    expect(ids.at(-1)).toBe("f-399");
    expect(ids.length).toBeGreaterThan(50);
  });
});

describe("failed summaries never hide findings", () => {
  const findings = (): ReviewFinding[] => [
    ...Array.from({ length: 60 }, (_, i) => ({
      ...normalizeFinding({
        id: `f-p2-${i}`,
        title: `Minor finding ${i}`,
        severity: "P2",
        path: `src/p2/${i}.ts`,
        line: 3,
        body: "Minor.",
        outside_diff: true,
      }),
      state: "open" as const,
    })),
    {
      ...normalizeFinding({
        id: "f-p1",
        title: "Retries drop the original request body",
        severity: "P1",
        path: "src/retry.ts",
        line: 12,
        body: "Serious.",
        outside_diff: true,
      }),
      state: "open" as const,
    },
    {
      ...normalizeFinding({
        id: "f-inline",
        title: "Posted inline already",
        severity: "P1",
        path: "src/inline.ts",
        line: 4,
        body: "Inline.",
      }),
      state: "open" as const,
      threadUrl: url(5),
    },
  ];

  it("lists findings without an inline comment, most severe first, with counts", () => {
    const summary = renderReviewSummary({
      state: "failed",
      head: HEAD,
      error:
        "The review's essential finding identities and state exceed the output limit; no truncated state was published.",
      findings: findings(),
    });
    expect(summary).toContain(
      "The review summary is larger than GitHub allows in one comment.",
    );
    expect(summary).toContain("61 findings without an inline comment");
    expect(summary).toContain("P0: 0 · P1: 1 · P2: 60");
    const rows = summary.split("\n").filter((line) => line.startsWith("- **"));
    expect(rows).toHaveLength(50);
    expect(rows[0]).toContain("**P1**");
    expect(rows[0]).toContain("Retries drop the original request body");
    expect(summary).not.toContain("Posted inline already");
    expect(summary).toContain("11 more not listed");
    expect(summary).not.toContain("Split the change");
  });
});
