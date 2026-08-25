#!/usr/bin/env node
// GitHub Comment MCP Server - Minimal server that only provides comment update functionality
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_API_URL } from "../github/api/config";
import { Octokit } from "@octokit/rest";
import { updateDroidComment } from "../github/operations/comments/update-droid-comment";
import { prepareDroidCommentBody } from "../github/operations/comments/common";

// Get repository information from environment variables
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;

if (!REPO_OWNER || !REPO_NAME) {
  console.error(
    "Error: REPO_OWNER and REPO_NAME environment variables are required",
  );
  process.exit(1);
}

const server = new McpServer({
  name: "GitHub Comment Server",
  version: "0.0.1",
});

server.tool(
  "update_droid_comment",
  "Update the Droid comment with progress and results (automatically handles both issue and PR comments)",
  {
    body: z.string().describe("The updated comment content"),
  },
  async ({ body }) => {
    try {
      const githubToken = process.env.GITHUB_TOKEN;
      const droidCommentId = process.env.DROID_COMMENT_ID;
      const eventName = process.env.GITHUB_EVENT_NAME;

      if (!githubToken) {
        throw new Error("GITHUB_TOKEN environment variable is required");
      }
      if (!droidCommentId) {
        throw new Error("DROID_COMMENT_ID environment variable is required");
      }

      const owner = REPO_OWNER;
      const repo = REPO_NAME;
      const commentId = parseInt(droidCommentId, 10);

      const octokit = new Octokit({
        auth: githubToken,
        baseUrl: GITHUB_API_URL,
      });

      const isPullRequestReviewComment =
        eventName === "pull_request_review_comment";

      let sanitizedBody = prepareDroidCommentBody(
        body,
        process.env.DROID_PR_REVIEW_MARKER === "true",
      );

      // CI Steward keeps its lifetime run budget in a marker on this comment.
      // Droid replaces the whole body, so carry the marker forward or every
      // successful run silently erases its own record of having happened.
      // The marker is supplied by the prepare step rather than recovered by
      // re-reading the comment: a single failed read used to drop it, which
      // reset the pull request's lifetime count to zero. sanitizeContent
      // strips HTML comments, so it is always re-appended afterwards.
      const stewardRunId = process.env.STEWARD_RUN_ID ?? "";
      const stewardRunCount = process.env.STEWARD_RUN_COUNT ?? "";
      const stewardRunSha = process.env.STEWARD_RUN_SHA ?? "";
      if (
        !isPullRequestReviewComment &&
        /^\d+$/.test(stewardRunId) &&
        /^\d+$/.test(stewardRunCount) &&
        /^[0-9a-f]{7,40}$/.test(stewardRunSha)
      ) {
        sanitizedBody = `${sanitizedBody}\n\n<!-- ci-steward:run=${stewardRunId} count=${stewardRunCount} sha=${stewardRunSha} -->`;
      }

      const result = await updateDroidComment(octokit, {
        owner,
        repo,
        commentId,
        body: sanitizedBody,
        isPullRequestReviewComment,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(console.error);
