import { describe, expect, it } from "bun:test";
import {
  appendPrCommentMarker,
  createBranchLink,
  createCommentBody,
  createJobRunLink,
  createPrCommentMarker,
  parsePrCommentKind,
  prepareDroidCommentBody,
} from "../../src/github/operations/comments/common";
import { GITHUB_SERVER_URL } from "../../src/github/api/config";
import { DroidRunType } from "../../src/run-type";

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

  it("adds the run type marker to PR validation tracking comments", () => {
    const jobLink = createJobRunLink("factory", "droid", "run-102");
    const defaultMarker = createPrCommentMarker(
      "issue-comment",
      DroidRunType.Default,
    );
    const reviewMarker = createPrCommentMarker(
      "issue-comment",
      DroidRunType.Review,
    );
    const securityReviewMarker = createPrCommentMarker(
      "issue-comment",
      DroidRunType.SecurityReview,
    );
    const securityScanMarker = createPrCommentMarker(
      "issue-comment",
      DroidRunType.SecurityScan,
    );

    expect(defaultMarker).toBe(
      "<!-- factory-pr-issue-comment: run-type=droid-default -->",
    );
    expect(reviewMarker).toBe(
      "<!-- factory-pr-issue-comment: run-type=droid-review -->",
    );
    expect(securityReviewMarker).toBe(
      "<!-- factory-pr-issue-comment: run-type=droid-security-review -->",
    );
    expect(securityScanMarker).toBe(
      "<!-- factory-pr-issue-comment: run-type=droid-security-scan -->",
    );
    expect(
      createCommentBody(jobLink, "", "default", DroidRunType.Default),
    ).toEndWith(defaultMarker);
    expect(
      createCommentBody(jobLink, "", "default", DroidRunType.Review),
    ).toEndWith(reviewMarker);
    expect(
      createCommentBody(jobLink, "", "security", DroidRunType.SecurityReview),
    ).toEndWith(securityReviewMarker);
    expect(
      createCommentBody(jobLink, "", "security", DroidRunType.SecurityScan),
    ).toEndWith(securityScanMarker);
    expect(createCommentBody(jobLink)).not.toContain("factory-pr-");
  });

  it("restores the PR validation marker after sanitizing comment updates", () => {
    const marker = createPrCommentMarker(
      "issue-comment",
      DroidRunType.SecurityReview,
    );
    const body = prepareDroidCommentBody(
      `Review complete\n\n${marker}`,
      DroidRunType.SecurityReview,
    );

    expect(body).toBe(`Review complete\n\n${marker}`);
    expect(
      appendPrCommentMarker(body, "issue-comment", DroidRunType.SecurityReview),
    ).toBe(body);
  });

  it("creates a distinct marker for inline review comments", () => {
    const marker = createPrCommentMarker(
      "inline-comment",
      DroidRunType.SecurityReview,
    );

    expect(marker).toBe(
      "<!-- factory-pr-inline-comment: run-type=droid-security-review -->",
    );
    expect(
      prepareDroidCommentBody(
        `[P1] [security] Finding\n\nDetails\n\n${marker}`,
        DroidRunType.SecurityReview,
        "inline-comment",
      ),
    ).toBe(`[P1] [security] Finding\n\nDetails\n\n${marker}`);
  });

  it("parses only known PR comment kinds", () => {
    expect(parsePrCommentKind("issue-comment")).toBe("issue-comment");
    expect(parsePrCommentKind("inline-comment")).toBe("inline-comment");
    expect(parsePrCommentKind("review")).toBeUndefined();
  });
});
