import { describe, expect, it } from "bun:test";
import {
  fallbackCommentBody,
  postReview,
  resolveInlineAnchor,
} from "../../src/bitbucket/operations/post-review";
import type {
  BitbucketClient,
  BitbucketInlineAnchor,
} from "../../src/bitbucket/types";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import type { ValidatedReviewComment } from "../../src/core/review/validated/parse";
import { APP_TS_DIFF } from "./fake-server";

const INDEX = buildUnifiedDiffIndex(APP_TS_DIFF);

const comment = (
  o: Partial<ValidatedReviewComment> = {},
): ValidatedReviewComment => ({
  path: "src/app.ts",
  body: "[P1] Finding",
  line: 3,
  startLine: null,
  side: "RIGHT",
  old_path: null,
  old_line: null,
  ...o,
});

describe("resolveInlineAnchor", () => {
  it("classifies added, context and removed lines from the diff", () => {
    expect(
      resolveInlineAnchor(comment({ line: 3, startLine: 2 }), INDEX),
    ).toEqual({
      anchor: {
        path: "src/app.ts",
        oldPath: null,
        line: 3,
        lineType: "ADDED",
        oldLine: null,
        startLine: 2,
      },
    });
    expect(resolveInlineAnchor(comment({ line: 4 }), INDEX)).toMatchObject({
      anchor: { line: 4, lineType: "CONTEXT", oldLine: 3 },
    });
    expect(
      resolveInlineAnchor(
        comment({ side: "LEFT", line: null, old_line: 2 }),
        INDEX,
      ),
    ).toMatchObject({ anchor: { line: 2, lineType: "REMOVED", oldLine: 2 } });
  });

  it("moves a LEFT anchor on an unchanged line to its new-file line", () => {
    expect(
      resolveInlineAnchor(
        comment({ side: "LEFT", line: null, old_line: 3, startLine: 1 }),
        INDEX,
      ),
    ).toEqual({
      anchor: {
        path: "src/app.ts",
        oldPath: null,
        line: 4,
        lineType: "CONTEXT",
        oldLine: 3,
        startLine: null,
      },
    });
  });

  it("explains anchors outside the diff", () => {
    expect(resolveInlineAnchor(comment({ line: 40 }), INDEX)).toEqual({
      reason: "line 40 is not part of the PR diff",
    });
    expect(resolveInlineAnchor(comment({ path: "README.md" }), INDEX)).toEqual({
      reason: "README.md is not part of the PR diff",
    });
    expect(
      resolveInlineAnchor(
        comment({ side: "LEFT", line: null, old_line: 9 }),
        INDEX,
      ),
    ).toEqual({ reason: "old line 9 is not part of the PR diff" });
  });

  it("finds a renamed file by its old path", () => {
    const index = buildUnifiedDiffIndex(
      APP_TS_DIFF.replaceAll("b/src/app.ts", "b/src/main.ts"),
    );
    expect(
      resolveInlineAnchor(
        comment({ path: "src/other.ts", old_path: "src/app.ts" }),
        index,
      ),
    ).toMatchObject({ anchor: { lineType: "ADDED", oldPath: "src/app.ts" } });
  });

  it("guesses by side when no diff index is available", () => {
    expect(resolveInlineAnchor(comment(), null)).toMatchObject({
      anchor: { lineType: "ADDED", line: 3 },
    });
    expect(
      resolveInlineAnchor(
        comment({ side: "LEFT", line: null, old_line: 5 }),
        null,
      ),
    ).toMatchObject({ anchor: { lineType: "REMOVED", line: 5 } });
  });
});

function fakeClient(opts: {
  multiLine: boolean;
  inline?: (anchor: BitbucketInlineAnchor) => void;
  general?: (body: string) => void;
}) {
  const inlineCalls: Array<{ body: string; anchor: BitbucketInlineAnchor }> =
    [];
  const generalCalls: string[] = [];
  const client = {
    variant: opts.multiLine ? "cloud" : "datacenter",
    supportsMultiLineComments: opts.multiLine,
    async createInlineComment(body: string, anchor: BitbucketInlineAnchor) {
      inlineCalls.push({ body, anchor });
      opts.inline?.(anchor);
      return { id: inlineCalls.length } as never;
    },
    async createComment(body: string) {
      generalCalls.push(body);
      opts.general?.(body);
      return { id: 100 } as never;
    },
  } as unknown as BitbucketClient;
  return { client, inlineCalls, generalCalls };
}

describe("postReview", () => {
  it("posts inline, retrying a refused range on its end line", async () => {
    const { client, inlineCalls } = fakeClient({
      multiLine: true,
      inline: (a) => {
        if (a.startLine !== null)
          throw new Error("Bitbucket API 400: bad range");
      },
    });

    const result = await postReview({
      client,
      comments: [comment({ startLine: 2 })],
      index: INDEX,
    });

    expect(result).toEqual({ posted: 1, fallbackPosted: 0, failures: [] });
    expect(inlineCalls.map((c) => c.anchor.startLine)).toEqual([2, null]);
  });

  it("never sends a range to a client without multi-line support", async () => {
    const { client, inlineCalls } = fakeClient({ multiLine: false });
    await postReview({
      client,
      comments: [comment({ startLine: 2 })],
      index: INDEX,
    });
    expect(inlineCalls.map((c) => c.anchor.startLine)).toEqual([null]);
  });

  it("falls back to a regular comment for lines outside the diff without calling inline", async () => {
    const { client, inlineCalls, generalCalls } = fakeClient({
      multiLine: true,
    });
    const result = await postReview({
      client,
      comments: [comment({ line: 40 })],
      index: INDEX,
    });
    expect(result).toEqual({ posted: 0, fallbackPosted: 1, failures: [] });
    expect(inlineCalls).toHaveLength(0);
    expect(generalCalls[0]).toContain("src/app.ts:40");
    expect(generalCalls[0]).toContain("[P1] Finding");
  });

  it("records a failure when inline and fallback both fail", async () => {
    const { client } = fakeClient({
      multiLine: false,
      inline: () => {
        throw new Error("Bitbucket API 400: line not in diff");
      },
      general: () => {
        throw new Error("Bitbucket API 401: Unauthorized");
      },
    });
    const result = await postReview({
      client,
      comments: [comment()],
      index: INDEX,
    });
    expect(result.failures).toEqual([
      {
        path: "src/app.ts",
        line: 3,
        error:
          "Bitbucket API 400: line not in diff; comment fallback failed: Bitbucket API 401: Unauthorized",
      },
    ]);
  });
});

describe("fallbackCommentBody", () => {
  it("names the old path for LEFT comments", () => {
    const body = fallbackCommentBody(
      comment({ side: "LEFT", path: "new.ts", old_path: "old.ts" }),
      7,
    );
    expect(body).toContain("`old.ts:7`");
    expect(body).toContain("could not be posted inline");
  });
});
