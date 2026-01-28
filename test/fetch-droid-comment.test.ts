import { describe, test, expect, jest, beforeEach } from "bun:test";
import type { Octokits } from "../src/github/api/client";
import {
  fetchDroidComment,
  type FetchDroidCommentParams,
} from "../src/github/operations/comments/fetch-droid-comment";

describe("fetchDroidComment", () => {
  let mockOctokit: Octokits;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        issues: {
          getComment: jest.fn(),
        },
        pulls: {
          getReviewComment: jest.fn(),
        },
      },
    } as unknown as Octokits;
  });

  test("should fetch issue comment successfully when event is not PR review comment", async () => {
    const mockIssueComment = {
      data: {
        id: 123456,
        body: "Test issue comment",
        html_url:
          "https://github.com/owner/repo/issues/1#issuecomment-123456",
      },
    };

    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest
      .fn()
      .mockResolvedValue(mockIssueComment);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 123456,
      isPullRequestReviewCommentEvent: false,
    };

    const result = await fetchDroidComment(mockOctokit, params);

    expect(mockOctokit.rest.issues.getComment).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      comment_id: 123456,
    });
    expect(result.comment.body).toBe("Test issue comment");
    expect(result.isPRReviewComment).toBe(false);
  });

  test("should fetch PR review comment successfully when event is PR review comment", async () => {
    const mockPRReviewComment = {
      data: {
        id: 789012,
        body: "Test PR review comment",
        html_url:
          "https://github.com/owner/repo/pull/1#discussion_r789012",
      },
    };

    // @ts-expect-error Mock implementation
    mockOctokit.rest.pulls.getReviewComment = jest
      .fn()
      .mockResolvedValue(mockPRReviewComment);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 789012,
      isPullRequestReviewCommentEvent: true,
    };

    const result = await fetchDroidComment(mockOctokit, params);

    expect(mockOctokit.rest.pulls.getReviewComment).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      comment_id: 789012,
    });
    expect(result.comment.body).toBe("Test PR review comment");
    expect(result.isPRReviewComment).toBe(true);
  });

  test("should fallback to PR review comment API when issue comment API returns 404 (non-PR-review-comment event)", async () => {
    // This is the key test case: event is pull_request (not pull_request_review_comment)
    // but the comment ID is actually a PR review comment ID
    const mockError = new Error("Not Found") as Error & { status: number };
    mockError.status = 404;

    const mockPRReviewComment = {
      data: {
        id: 3812927863,
        body: "Test PR review comment fetched via fallback",
        html_url:
          "https://github.com/owner/repo/pull/8179#discussion_r3812927863",
      },
    };

    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest.fn().mockRejectedValue(mockError);
    // @ts-expect-error Mock implementation
    mockOctokit.rest.pulls.getReviewComment = jest
      .fn()
      .mockResolvedValue(mockPRReviewComment);

    const params: FetchDroidCommentParams = {
      owner: "trywingman",
      repo: "stringsai",
      commentId: 3812927863,
      isPullRequestReviewCommentEvent: false, // Event is pull_request, not pull_request_review_comment
    };

    const result = await fetchDroidComment(mockOctokit, params);

    // Should have tried issue comment API first
    expect(mockOctokit.rest.issues.getComment).toHaveBeenCalledWith({
      owner: "trywingman",
      repo: "stringsai",
      comment_id: 3812927863,
    });

    // Then should have fallen back to PR review comment API
    expect(mockOctokit.rest.pulls.getReviewComment).toHaveBeenCalledWith({
      owner: "trywingman",
      repo: "stringsai",
      comment_id: 3812927863,
    });

    expect(result.comment.body).toBe(
      "Test PR review comment fetched via fallback",
    );
    expect(result.isPRReviewComment).toBe(true);
  });

  test("should fallback to issue comment API when PR review comment API fails for PR review comment event", async () => {
    const mockError = new Error("Not Found") as Error & { status: number };
    mockError.status = 404;

    const mockIssueComment = {
      data: {
        id: 456789,
        body: "Test issue comment fetched via fallback",
        html_url:
          "https://github.com/owner/repo/issues/1#issuecomment-456789",
      },
    };

    // @ts-expect-error Mock implementation
    mockOctokit.rest.pulls.getReviewComment = jest
      .fn()
      .mockRejectedValue(mockError);
    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest
      .fn()
      .mockResolvedValue(mockIssueComment);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 456789,
      isPullRequestReviewCommentEvent: true,
    };

    const result = await fetchDroidComment(mockOctokit, params);

    // Should have tried PR review comment API first
    expect(mockOctokit.rest.pulls.getReviewComment).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      comment_id: 456789,
    });

    // Then should have fallen back to issue comment API
    expect(mockOctokit.rest.issues.getComment).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      comment_id: 456789,
    });

    expect(result.comment.body).toBe(
      "Test issue comment fetched via fallback",
    );
    expect(result.isPRReviewComment).toBe(false);
  });

  test("should throw error when both APIs fail for non-PR-review-comment event", async () => {
    const issueError = new Error("Issue comment not found") as Error & {
      status: number;
    };
    issueError.status = 404;

    const prReviewError = new Error("PR review comment not found") as Error & {
      status: number;
    };
    prReviewError.status = 404;

    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest
      .fn()
      .mockRejectedValue(issueError);
    // @ts-expect-error Mock implementation
    mockOctokit.rest.pulls.getReviewComment = jest
      .fn()
      .mockRejectedValue(prReviewError);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 999999,
      isPullRequestReviewCommentEvent: false,
    };

    // Should throw the original issue error after both APIs fail
    await expect(fetchDroidComment(mockOctokit, params)).rejects.toThrow(
      "Issue comment not found",
    );

    expect(mockOctokit.rest.issues.getComment).toHaveBeenCalled();
    expect(mockOctokit.rest.pulls.getReviewComment).toHaveBeenCalled();
  });

  test("should throw error when both APIs fail for PR review comment event", async () => {
    const prReviewError = new Error("PR review comment not found") as Error & {
      status: number;
    };
    prReviewError.status = 404;

    const issueError = new Error("Issue comment not found") as Error & {
      status: number;
    };
    issueError.status = 404;

    // @ts-expect-error Mock implementation
    mockOctokit.rest.pulls.getReviewComment = jest
      .fn()
      .mockRejectedValue(prReviewError);
    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest
      .fn()
      .mockRejectedValue(issueError);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 888888,
      isPullRequestReviewCommentEvent: true,
    };

    // Should throw the issue error (from the fallback attempt)
    await expect(fetchDroidComment(mockOctokit, params)).rejects.toThrow(
      "Issue comment not found",
    );

    expect(mockOctokit.rest.pulls.getReviewComment).toHaveBeenCalled();
    expect(mockOctokit.rest.issues.getComment).toHaveBeenCalled();
  });

  test("should handle null body in comment", async () => {
    const mockIssueComment = {
      data: {
        id: 111222,
        body: null,
        html_url:
          "https://github.com/owner/repo/issues/1#issuecomment-111222",
      },
    };

    // @ts-expect-error Mock implementation
    mockOctokit.rest.issues.getComment = jest
      .fn()
      .mockResolvedValue(mockIssueComment);

    const params: FetchDroidCommentParams = {
      owner: "testowner",
      repo: "testrepo",
      commentId: 111222,
      isPullRequestReviewCommentEvent: false,
    };

    const result = await fetchDroidComment(mockOctokit, params);

    expect(result.comment.body).toBeNull();
    expect(result.isPRReviewComment).toBe(false);
  });
});
