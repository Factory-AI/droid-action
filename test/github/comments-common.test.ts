import { describe, expect, it } from "bun:test";
import {
  DROID_PR_REVIEW_MARKER,
  appendPrReviewMarker,
  createBranchLink,
  createCommentBody,
  createJobRunLink,
  prepareDroidCommentBody,
} from "../../src/github/operations/comments/common";
import { GITHUB_SERVER_URL } from "../../src/github/api/config";

describe("comments common helpers", () => {
  it("creates a job run link using the configured GitHub server", () => {
    const link = createJobRunLink("factory", "droid", "12345");

    expect(link).toBe(
      `[View job run](${GITHUB_SERVER_URL}/factory/droid/actions/runs/12345)`,
    );
  });

  it("creates an optional branch link that starts on a new line", () => {
    const branchLink = createBranchLink("factory", "droid", "feature/refactor");

    expect(branchLink).toBe(
      `\n[View branch](${GITHUB_SERVER_URL}/factory/droid/tree/feature/refactor)`,
    );
  });

  it("builds the initial comment body with spinner, job link, and optional branch", () => {
    const jobLink = createJobRunLink("factory", "droid", "run-789");
    const branchLink = createBranchLink("factory", "droid", "cleanup");

    const body = createCommentBody(jobLink, branchLink);

    expect(body).toContain("Droid is working…");
    expect(body).toContain(jobLink);
    expect(body).toContain(branchLink);
    expect(body.startsWith("Droid is working…")).toBe(true);
  });

  it("builds a comment body without a branch link when omitted", () => {
    const jobLink = createJobRunLink("factory", "droid", "run-101");
    const body = createCommentBody(jobLink);

    expect(body).toContain(jobLink);
    expect(body).not.toContain("View branch");
  });

  it("adds the hidden marker to PR review tracking comments", () => {
    const jobLink = createJobRunLink("factory", "droid", "run-102");

    expect(createCommentBody(jobLink, "", "review")).toEndWith(
      DROID_PR_REVIEW_MARKER,
    );
    expect(createCommentBody(jobLink, "", "security")).toEndWith(
      DROID_PR_REVIEW_MARKER,
    );
    expect(createCommentBody(jobLink, "", "security_scan")).not.toContain(
      DROID_PR_REVIEW_MARKER,
    );
    expect(createCommentBody(jobLink)).not.toContain(DROID_PR_REVIEW_MARKER);
  });

  it("restores the PR review marker after sanitizing comment updates", () => {
    const body = prepareDroidCommentBody(
      `Review complete\n\n${DROID_PR_REVIEW_MARKER}`,
      true,
    );

    expect(body).toBe(`Review complete\n\n${DROID_PR_REVIEW_MARKER}`);
    expect(appendPrReviewMarker(body)).toBe(body);
  });
});
