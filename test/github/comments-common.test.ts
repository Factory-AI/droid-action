import { describe, expect, it } from "bun:test";
import {
  appendPrValidationMarker,
  createBranchLink,
  createCommentBody,
  createJobRunLink,
  createPrValidationMarker,
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
    const defaultMarker = createPrValidationMarker(DroidRunType.Default);
    const reviewMarker = createPrValidationMarker(DroidRunType.Review);
    const securityReviewMarker = createPrValidationMarker(
      DroidRunType.SecurityReview,
    );
    const securityScanMarker = createPrValidationMarker(
      DroidRunType.SecurityScan,
    );

    expect(defaultMarker).toBe(
      "<!-- factory-pr-validation: run-type=droid-default -->",
    );
    expect(reviewMarker).toBe(
      "<!-- factory-pr-validation: run-type=droid-review -->",
    );
    expect(securityReviewMarker).toBe(
      "<!-- factory-pr-validation: run-type=droid-security-review -->",
    );
    expect(securityScanMarker).toBe(
      "<!-- factory-pr-validation: run-type=droid-security-scan -->",
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
    expect(createCommentBody(jobLink)).not.toContain("factory-pr-validation");
  });

  it("restores the PR validation marker after sanitizing comment updates", () => {
    const marker = createPrValidationMarker(DroidRunType.SecurityReview);
    const body = prepareDroidCommentBody(
      `Review complete\n\n${marker}`,
      DroidRunType.SecurityReview,
    );

    expect(body).toBe(`Review complete\n\n${marker}`);
    expect(appendPrValidationMarker(body, DroidRunType.SecurityReview)).toBe(
      body,
    );
  });
});
