import { describe, expect, it } from "bun:test";
import {
  createSubmitReviewGuard,
  handleSubmitReview,
} from "../../src/mcp/github-pr-server";

describe("MCP review success requires a real GitHub review", () => {
  const comments = [
    {
      path: "src/example.ts",
      line: 1,
      side: "RIGHT",
      body: "[P1] Confirmed issue",
    },
  ];
  it("body-only calls do not claim success or consume the later genuine submission", async () => {
    let posts = 0;
    const octokit: any = {
      rest: {
        pulls: {
          createReview: async () => {
            posts++;
            return { data: { id: 91 } };
          },
        },
      },
    };
    const guard = createSubmitReviewGuard();
    const submit = (input: { body?: string; comments?: typeof comments }) =>
      handleSubmitReview({
        owner: "o",
        repo: "r",
        prNumber: 7,
        octokit,
        guard,
        ...input,
      });
    for (let i = 0; i < 6; i++) {
      const result = await submit({ body: "Assessment only" });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("The review is posted");
    }
    expect(posts).toBe(0);
    const real = await submit({ comments });
    expect(real.isError).toBe(false);
    expect(real.text).toContain("Submitted review 91");
    expect(posts).toBe(1);
  });
  it("a missing publication ID is not recorded as success", async () => {
    let id: number | undefined;
    const octokit: any = {
      rest: { pulls: { createReview: async () => ({ data: { id } }) } },
    };
    const guard = createSubmitReviewGuard();
    const submit = () =>
      handleSubmitReview({
        owner: "o",
        repo: "r",
        prNumber: 7,
        octokit,
        guard,
        comments,
      });
    await expect(submit()).rejects.toThrow(
      "GitHub did not return a published review ID",
    );
    id = 92;
    expect((await submit()).isError).toBe(false);
  });
});
