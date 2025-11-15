#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";

const PLACEHOLDER_REGEX = /@droid\s+fill(?:\s+description)?/gi;
const PLACEHOLDER_LINE_REGEX =
  /^[^\S\r\n]*@droid\s+fill(?:\s+description)?[^\S\r\n]*\r?\n?/gim;

export type UpdateMode = "replace" | "merge";

export interface UpdateDescriptionParams {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  mode: UpdateMode;
  octokit: OctokitLike;
}

export type OctokitLike = {
  rest: {
    pulls: {
      update: (...args: any[]) => Promise<any>;
      get: (...args: any[]) => Promise<any>;
      listReviewComments: (...args: any[]) => Promise<{ data: unknown[] }>;
      createReview: (...args: any[]) => Promise<{ data: { id?: number } }>;
      deleteReviewComment: (...args: any[]) => Promise<unknown>;
      getReviewComment: (
        ...args: any[]
      ) => Promise<{ data: { node_id: string; pull_request_url?: string } }>;
      createReplyForReviewComment: (
        ...args: any[]
      ) => Promise<{ data: unknown }>;
    };
    issues: {
      listComments: (...args: any[]) => Promise<{ data: unknown[] }>;
      deleteComment: (...args: any[]) => Promise<unknown>;
      getComment: (...args: any[]) => Promise<{ data: { node_id: string } }>;
      createComment: (...args: any[]) => Promise<{ data: unknown }>;
    };
  };
  graphql?: (...args: any[]) => Promise<any>;
};

export function cleanDescription(text: string): string {
  const withoutPlaceholderLines = text.replace(PLACEHOLDER_LINE_REGEX, "");

  const withoutInlinePlaceholder = withoutPlaceholderLines.replace(
    PLACEHOLDER_REGEX,
    "",
  );

  let normalized = withoutInlinePlaceholder
    // Collapse sequences of blank lines introduced by removal
    .replace(/\n\s*\n+/g, "\n")
    // Remove trailing blank lines
    .replace(/\n+$/, "");

  normalized = normalized.replace(/\n{3,}/g, "\n\n");

  return normalized.trim();
}

export function extractIssueReferences(text: string): string[] {
  const matches = text.match(
    /(?:close[sd]?|fixe[sd]?|resolve[sd]?)[^#]*#\d+|#\d+/gi,
  );
  return matches ? Array.from(new Set(matches.map((m) => m.trim()))) : [];
}

export function mergeDescriptions(existing: string, generated: string): string {
  const cleanedExisting = cleanDescription(existing);
  const cleanedGenerated = cleanDescription(generated);

  if (!cleanedExisting) {
    return cleanedGenerated;
  }

  if (!cleanedGenerated) {
    return cleanedExisting;
  }

  let finalBody = cleanedGenerated;

  const references = extractIssueReferences(cleanedExisting);
  if (references.length > 0) {
    const missing = references.filter(
      (ref) => !finalBody.toLowerCase().includes(ref.toLowerCase()),
    );

    if (missing.length > 0) {
      const relatedIssuesRegex = /##\s+related issues[\s\S]*?(?=\n##\s|$)/i;
      if (relatedIssuesRegex.test(finalBody)) {
        finalBody = finalBody.replace(relatedIssuesRegex, (section) => {
          const separator = section.endsWith("\n") ? "" : "\n";
          return `${section}${separator}${missing.join("\n")}`;
        });
      } else {
        finalBody = `${finalBody}\n\n## Related Issues\n${missing.join("\n")}`;
      }
    }
  }

  return finalBody;
}

export async function handleUpdatePRDescription({
  owner,
  repo,
  prNumber,
  body,
  mode,
  octokit,
}: UpdateDescriptionParams): Promise<string> {
  let finalBody: string;

  if (mode === "merge") {
    const existing = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    finalBody = mergeDescriptions(existing.data.body ?? "", body);
  } else {
    finalBody = cleanDescription(body);
  }

  if (!finalBody) {
    finalBody = "";
  }

  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: finalBody,
  });

  return finalBody;
}

export async function listReviewAndIssueComments({
  owner,
  repo,
  prNumber,
  perPage = 100,
  octokit,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  perPage?: number;
  octokit: OctokitLike;
}): Promise<{
  issueComments: unknown[];
  reviewComments: unknown[];
}> {
  const [issueComments, reviewComments] = await Promise.all([
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: perPage,
    }),
    octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
    }),
  ]);

  return {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };
}

export async function submitReviewWithComments({
  owner,
  repo,
  prNumber,
  body,
  comments,
  octokit,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  body?: string;
  comments?: Array<{ path: string; position: number; body: string }>;
  octokit: OctokitLike;
}): Promise<number | undefined> {
  const response = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "COMMENT",
    ...(body ? { body } : {}),
    ...(comments && comments.length > 0 ? { comments } : {}),
  });

  return response.data.id;
}

export async function deletePullRequestComment({
  owner,
  repo,
  commentId,
  type,
  octokit,
}: {
  owner: string;
  repo: string;
  commentId: number;
  type: "issue" | "review";
  octokit: OctokitLike;
}): Promise<void> {
  if (type === "review") {
    await octokit.rest.pulls.deleteReviewComment({
      owner,
      repo,
      comment_id: commentId,
    });
    return;
  }

  await octokit.rest.issues.deleteComment({
    owner,
    repo,
    comment_id: commentId,
  });
}

const MINIMIZE_ALLOWED_CLASSIFIERS = [
  "OUTDATED",
  "RESOLVED",
  "SPAM",
  "OFF_TOPIC",
  "DUPLICATE",
  "ABUSE",
] as const;

export type MinimizeClassifier = (typeof MINIMIZE_ALLOWED_CLASSIFIERS)[number];

export async function minimizeComment({
  nodeId,
  classifier,
  octokit,
}: {
  nodeId: string;
  classifier: MinimizeClassifier;
  octokit: OctokitLike;
}): Promise<void> {
  if (!octokit.graphql) {
    throw new Error("Octokit GraphQL client is not available");
  }

  await octokit.graphql(
    `mutation MinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
      minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
        minimizedComment {
          isMinimized
          minimizedReason
        }
      }
    }`,
    {
      subjectId: nodeId,
      classifier,
    },
  );
}

export async function replyToPullRequestComment({
  owner,
  repo,
  prNumber,
  commentId,
  body,
  type,
  octokit,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  body: string;
  type: "issue" | "review";
  octokit: OctokitLike;
}): Promise<void> {
  if (type === "review") {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: commentId,
      body,
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

export async function resolveReviewThread({
  owner,
  repo,
  commentId,
  threadNodeId,
  octokit,
}: {
  owner: string;
  repo: string;
  commentId?: number;
  threadNodeId?: string;
  octokit: OctokitLike;
}): Promise<void> {
  if (!octokit.graphql) {
    throw new Error("Octokit GraphQL client is not available");
  }

  let targetThreadId = threadNodeId;
  const previewHeaders = {
    accept: "application/vnd.github.comfort-fade-preview+json",
  };

  if (!targetThreadId) {
    if (!commentId) {
      throw new Error("Either commentId or threadNodeId must be provided");
    }

    const reviewComment = await octokit.rest.pulls.getReviewComment({
      owner,
      repo,
      comment_id: commentId,
    });

    const commentNodeId = reviewComment.data.node_id;
    if (!commentNodeId) {
      throw new Error("Unable to resolve node ID for review comment");
    }

    const prUrl = reviewComment.data.pull_request_url;
    if (!prUrl) {
      throw new Error("Unable to resolve pull request URL for review comment");
    }

    const prNumber = Number.parseInt(
      prUrl.substring(prUrl.lastIndexOf("/") + 1),
      10,
    );
    if (!Number.isFinite(prNumber)) {
      throw new Error(
        "Unable to resolve pull request number for review comment",
      );
    }

    const threadLookupQuery = await octokit.graphql(
      `query GetReviewThread($owner: String!, $repo: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $prNumber) {
            reviewThreads(first: 100) {
              nodes {
                id
                comments(first: 10) {
                  nodes {
                    id
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner,
        repo,
        prNumber,
        headers: previewHeaders,
      },
    );

    const threads: Array<{
      id?: string;
      comments?: { nodes?: Array<{ id?: string }> };
    }> = threadLookupQuery?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

    for (const thread of threads) {
      const comments = thread?.comments?.nodes ?? [];
      if (
        comments.some((comment) => comment?.id === commentNodeId) &&
        thread?.id
      ) {
        targetThreadId = thread.id;
        break;
      }
    }

    if (!targetThreadId) {
      throw new Error("Unable to resolve thread ID for review comment");
    }
  }

  await octokit.graphql(
    `mutation ResolveReviewThread($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }`,
    {
      threadId: targetThreadId,
      headers: previewHeaders,
    },
  );
}

export interface ServerDependencies {
  owner: string;
  repo: string;
  octokit: OctokitLike;
}

export function createGitHubPRServer({
  owner,
  repo,
  octokit,
}: ServerDependencies) {
  const server = new McpServer({
    name: "GitHub PR Server",
    version: "0.0.1",
  });

  server.tool(
    "update_pr_description",
    "Update the pull request description/body",
    {
      body: z.string().min(1).describe("The new PR description in markdown"),
      mode: z
        .enum(["replace", "merge"])
        .optional()
        .default("replace")
        .describe("Replace entire description or merge with existing"),
      pr_number: z.number().int().describe("PR number to update"),
    },
    async ({ body, mode, pr_number }) => {
      try {
        const updatedBody = await handleUpdatePRDescription({
          owner,
          repo,
          prNumber: pr_number,
          body,
          mode,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `PR #${pr_number} description updated successfully`,
            },
            {
              type: "text",
              text: updatedBody,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_review_comments",
    "List review and issue comments for a PR",
    {
      pr_number: z.number().int().describe("PR number to inspect"),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Results per page (default 100)"),
    },
    async ({ pr_number, per_page }) => {
      try {
        const result = await listReviewAndIssueComments({
          owner,
          repo,
          prNumber: pr_number,
          perPage: per_page,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "resolve_review_thread",
    "Resolve a review thread by comment ID or thread node ID",
    {
      pr_number: z.number().int().describe("PR number containing the thread"),
      comment_id: z
        .number()
        .int()
        .optional()
        .describe("Review comment ID belonging to the thread"),
      thread_node_id: z
        .string()
        .optional()
        .describe("GraphQL node ID of the review thread"),
    },
    async ({ pr_number, comment_id, thread_node_id }) => {
      try {
        const hasCommentId = typeof comment_id === "number";
        const hasThreadId =
          typeof thread_node_id === "string" && thread_node_id.length > 0;

        if (hasCommentId === hasThreadId) {
          throw new Error(
            "Provide either comment_id or thread_node_id, but not both",
          );
        }

        await resolveReviewThread({
          owner,
          repo,
          commentId: comment_id,
          threadNodeId: thread_node_id,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `Review thread for PR #${pr_number} resolved successfully`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "submit_review",
    "Submit a PR review containing inline comments",
    {
      pr_number: z.number().int().describe("PR number to review"),
      body: z.string().describe("Optional summary body").optional(),
      comments: z
        .array(
          z.object({
            path: z.string(),
            position: z.number().int(),
            body: z.string().min(1),
          }),
        )
        .max(30)
        .describe("List of inline comments to include")
        .optional(),
    },
    async ({ pr_number, body, comments }) => {
      try {
        const reviewId = await submitReviewWithComments({
          owner,
          repo,
          prNumber: pr_number,
          body,
          comments,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `Submitted review${reviewId ? ` ${reviewId}` : ""} for PR #${pr_number}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "delete_comment",
    "Delete an issue or review comment",
    {
      pr_number: z
        .number()
        .int()
        .describe("PR number associated with the comment"),
      comment_id: z.number().int().describe("ID of the comment to delete"),
      type: z
        .enum(["issue", "review"])
        .default("issue")
        .describe("Comment type: issue (top-level) or review (inline)"),
    },
    async ({ pr_number, comment_id, type }) => {
      try {
        await deletePullRequestComment({
          owner,
          repo,
          commentId: comment_id,
          type,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `Deleted ${type} comment ${comment_id} on PR #${pr_number}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "minimize_comment",
    "Minimize a comment using GitHub's GraphQL API",
    {
      node_id: z.string().min(1).describe("GraphQL node ID of the comment"),
      classifier: z
        .enum(MINIMIZE_ALLOWED_CLASSIFIERS)
        .default("OUTDATED")
        .describe("Reason for minimization"),
    },
    async ({ node_id, classifier }) => {
      try {
        await minimizeComment({
          nodeId: node_id,
          classifier,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `Minimized comment ${node_id} with classifier ${classifier}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  server.tool(
    "reply_to_comment",
    "Reply to an existing issue or review comment",
    {
      pr_number: z
        .number()
        .int()
        .describe("PR number associated with the comment"),
      comment_id: z.number().int().describe("ID of the comment to reply to"),
      body: z.string().min(1).describe("Reply body"),
      type: z
        .enum(["issue", "review"])
        .default("issue")
        .describe("Comment type: issue (top-level) or review (inline)"),
    },
    async ({ pr_number, comment_id, body, type }) => {
      try {
        await replyToPullRequestComment({
          owner,
          repo,
          prNumber: pr_number,
          commentId: comment_id,
          body,
          type,
          octokit,
        });

        return {
          content: [
            {
              type: "text",
              text: `Posted reply to ${type} comment ${comment_id} on PR #${pr_number}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${message}`,
            },
          ],
          error: message,
          isError: true,
        };
      }
    },
  );

  return server;
}

async function runServer() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo) {
    console.error(
      "Error: REPO_OWNER and REPO_NAME environment variables are required",
    );
    process.exit(1);
  }

  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  const octokit = new Octokit({
    auth: token,
    baseUrl: GITHUB_API_URL,
  });

  const server = createGitHubPRServer({ owner, repo, octokit });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("exit", () => {
    server.close();
  });
}

if (import.meta.main) {
  runServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
