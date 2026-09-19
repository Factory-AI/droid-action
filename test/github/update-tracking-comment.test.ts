import { describe, expect, it, mock } from "bun:test";
import { updateDroidTrackingComment } from "../../src/github/operations/comments/update-tracking-comment";
import {
  COMBINED_REVIEW_COMMENT_RUN_TYPE,
  createPrCommentMarker,
  type PrCommentKind,
} from "../../src/github/operations/comments/common";
import { DroidRunType } from "../../src/run-type";

const combinedMarker = createPrCommentMarker(
  "issue-comment",
  COMBINED_REVIEW_COMMENT_RUN_TYPE,
);
const params = {
  owner: "o",
  repo: "r",
  commentId: 123,
  isPullRequestReviewComment: false,
};

function storedComment(body: string, kind: PrCommentKind = "issue-comment") {
  let currentBody = body;
  const read = mock(async () => ({ data: { body: currentBody } }));
  const missing = mock(async () => {
    throw Object.assign(new Error("Not found"), { status: 404 });
  });
  const write = mock(async (input: { body: string; comment_id: number }) => {
    expect(input.comment_id).toBe(123);
    currentBody = input.body;
    return {
      data: {
        id: 123,
        html_url: "https://github.com/o/r/pull/1",
        updated_at: "",
      },
    };
  });
  const issues = {
    getComment: kind === "issue-comment" ? read : missing,
    updateComment: write,
  };
  const pulls = {
    getReviewComment: kind === "inline-comment" ? read : missing,
    updateReviewComment: write,
  };
  return {
    client: { rest: { issues, pulls, rest: { issues, pulls } } } as any,
    read,
    write,
    body: () => currentBody,
  };
}

describe("updateDroidTrackingComment", () => {
  it.each([
    [DroidRunType.Review, DroidRunType.SecurityReview],
    [DroidRunType.SecurityReview, DroidRunType.Review],
  ] as const)(
    "combines %s and %s updates on the same comment",
    async (first, second) => {
      const stored = storedComment(
        createPrCommentMarker("issue-comment", first),
      );
      for (const runType of [second, first, second]) {
        await updateDroidTrackingComment(stored.client, {
          ...params,
          body: `Progress from ${runType}`,
          runType,
        });
        expect(stored.body()).toEndWith(combinedMarker);
        expect(
          stored.body().match(/<!-- factory-pr-issue-comment:/g),
        ).toHaveLength(1);
      }
      expect(stored.read).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps the planned combined scope for concurrent review updates", async () => {
    const stored = storedComment(combinedMarker);
    await Promise.all(
      ([DroidRunType.Review, DroidRunType.SecurityReview] as const).map(
        (runType) =>
          updateDroidTrackingComment(stored.client, {
            ...params,
            body: "Progress",
            runType,
          }),
      ),
    );
    expect(stored.write).toHaveBeenCalledTimes(2);
    for (const [payload] of stored.write.mock.calls) {
      expect(payload.body).toEndWith(combinedMarker);
    }
  });

  it("preserves stored classification when the run type is unresolved", async () => {
    const stored = storedComment(combinedMarker);
    await updateDroidTrackingComment(stored.client, {
      ...params,
      body: "Progress",
    });
    expect(stored.body()).toEndWith(combinedMarker);
  });

  it("does not accept a combined marker supplied by the model", async () => {
    const marker = createPrCommentMarker("issue-comment", DroidRunType.Review);
    const stored = storedComment(marker);
    await updateDroidTrackingComment(stored.client, {
      ...params,
      body: `Progress\n\n${combinedMarker}`,
      runType: DroidRunType.Review,
    });
    expect(stored.body()).toBe(`Progress\n\n${marker}`);
  });

  it("uses the actual issue surface when inline tracking fell back", async () => {
    const stored = storedComment(combinedMarker);
    await updateDroidTrackingComment(stored.client, {
      ...params,
      isPullRequestReviewComment: true,
      body: "Progress",
      runType: DroidRunType.SecurityReview,
    });
    expect(stored.body()).toEndWith(combinedMarker);
    expect(stored.body()).not.toContain("factory-pr-inline-comment");
  });

  it("preserves the actual inline surface for tracking replies", async () => {
    const marker = createPrCommentMarker(
      "inline-comment",
      COMBINED_REVIEW_COMMENT_RUN_TYPE,
    );
    const stored = storedComment(marker, "inline-comment");
    await updateDroidTrackingComment(stored.client, {
      ...params,
      isPullRequestReviewComment: true,
      body: "Progress",
      runType: DroidRunType.Review,
    });
    expect(stored.body()).toEndWith(marker);
    expect(stored.body()).not.toContain("factory-pr-issue-comment");
  });

  it("does not write if the existing tracking comment cannot be read", async () => {
    const write = mock(async () => ({ data: { id: 123 } }));
    const fail = async () => {
      throw new Error("Read failed");
    };
    const client = {
      rest: {
        issues: { getComment: fail },
        pulls: { getReviewComment: fail },
        rest: { issues: { updateComment: write } },
      },
    } as any;
    await expect(
      updateDroidTrackingComment(client, {
        ...params,
        body: "Progress",
        runType: DroidRunType.SecurityReview,
      }),
    ).rejects.toThrow("Read failed");
    expect(write).not.toHaveBeenCalled();
  });
});
