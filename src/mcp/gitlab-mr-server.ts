#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GitlabClient } from "../gitlab/api/client";
import type { GitlabPosition } from "../gitlab/types";

export interface GitlabServerDependencies {
  projectId: string;
  client: GitlabClient;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    error: message,
    isError: true,
  };
}

const ReviewCommentSchema = z
  .object({
    path: z
      .string()
      .describe(
        "Path of the file to comment on (use the new_path from the diff)",
      ),
    body: z.string().min(1).describe("Comment text (supports markdown)"),
    line: z
      .number()
      .int()
      .optional()
      .describe(
        "Line number in the new file. Required for side=RIGHT (the default).",
      ),
    side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .default("RIGHT")
      .describe(
        "Side of the diff: RIGHT for new/modified code, LEFT for removed code",
      ),
    old_path: z
      .string()
      .optional()
      .describe("Path in the old file (defaults to path if unset)"),
    old_line: z
      .number()
      .int()
      .optional()
      .describe(
        "Line number in the old file. Required for side=LEFT comments.",
      ),
  })
  .refine(
    (c) => {
      const side = c.side ?? "RIGHT";
      if (side === "LEFT") return typeof c.old_line === "number";
      return typeof c.line === "number";
    },
    {
      message:
        "Inline diff discussions require a line anchor: provide `line` for side=RIGHT comments, or `old_line` for side=LEFT comments.",
    },
  );

type ReviewComment = z.infer<typeof ReviewCommentSchema>;

function buildPosition(
  comment: ReviewComment,
  diffRefs: { base_sha: string; head_sha: string; start_sha: string },
): GitlabPosition {
  const newPath = comment.path;
  const oldPath = comment.old_path ?? comment.path;

  const position: GitlabPosition = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    position_type: "text",
    new_path: newPath,
    old_path: oldPath,
  };

  if (comment.side === "LEFT") {
    if (typeof comment.old_line === "number") {
      position.old_line = comment.old_line;
    } else if (typeof comment.line === "number") {
      position.old_line = comment.line;
    }
  } else {
    if (typeof comment.line === "number") {
      position.new_line = comment.line;
    }
    if (typeof comment.old_line === "number") {
      position.old_line = comment.old_line;
    }
  }

  return position;
}

export function createGitlabMrServer({
  projectId,
  client,
}: GitlabServerDependencies) {
  const server = new McpServer({
    name: "GitLab MR Server",
    version: "0.0.1",
  });

  server.tool(
    "get_mr",
    "Fetch merge request metadata including diff_refs (base/head/start SHAs)",
    {
      mr_iid: z.number().int().describe("Merge request IID to fetch"),
    },
    async ({ mr_iid }) => {
      try {
        const mr = await client.getMr(projectId, mr_iid);
        return textResult(JSON.stringify(mr));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "get_mr_changes",
    "Fetch the file-level diff for a merge request",
    {
      mr_iid: z.number().int().describe("Merge request IID"),
    },
    async ({ mr_iid }) => {
      try {
        const changes = await client.getMrChanges(projectId, mr_iid);
        return textResult(JSON.stringify(changes));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "list_mr_notes",
    "List notes (comments) on a merge request",
    {
      mr_iid: z.number().int().describe("Merge request IID"),
    },
    async ({ mr_iid }) => {
      try {
        const notes = await client.listNotes(projectId, mr_iid);
        return textResult(JSON.stringify(notes));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "create_mr_note",
    "Post a top-level note (summary comment) on a merge request",
    {
      mr_iid: z.number().int().describe("Merge request IID"),
      body: z.string().min(1).describe("Note body in markdown"),
    },
    async ({ mr_iid, body }) => {
      try {
        const note = await client.createNote(projectId, mr_iid, body);
        return textResult(`Created note ${note.id} on MR !${mr_iid}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "update_mr_note",
    "Edit the body of an existing note (used for the sticky tracking comment)",
    {
      mr_iid: z.number().int().describe("Merge request IID"),
      note_id: z.number().int().describe("Note ID to update"),
      body: z.string().min(1).describe("New note body in markdown"),
    },
    async ({ mr_iid, note_id, body }) => {
      try {
        await client.updateNote(projectId, mr_iid, note_id, body);
        return textResult(`Updated note ${note_id} on MR !${mr_iid}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "update_tracking_note",
    "Update the sticky tracking note that gitlab-prepare created at the " +
      "start of the run. Reads the MR IID and note ID from env so the model " +
      "doesn't have to thread them through the prompt. Mirrors the GitHub " +
      "`update_droid_comment` tool.",
    {
      body: z
        .string()
        .min(1)
        .describe("New tracking note body in markdown (replaces existing)"),
    },
    async ({ body }) => {
      try {
        const mrIidEnv =
          process.env.DROID_MR_IID || process.env.CI_MERGE_REQUEST_IID;
        const noteIdEnv = process.env.DROID_TRACKING_NOTE_ID;
        const mrIid = mrIidEnv ? Number(mrIidEnv) : NaN;
        const noteId = noteIdEnv ? Number(noteIdEnv) : NaN;
        if (!Number.isFinite(mrIid) || !Number.isFinite(noteId)) {
          throw new Error(
            "update_tracking_note requires DROID_MR_IID and " +
              "DROID_TRACKING_NOTE_ID environment variables",
          );
        }
        await client.updateNote(projectId, mrIid, noteId, body);
        return textResult(`Updated tracking note ${noteId} on MR !${mrIid}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "update_mr_description",
    "Replace the description/body of a merge request",
    {
      mr_iid: z.number().int().describe("Merge request IID"),
      description: z.string().describe("New description in markdown"),
    },
    async ({ mr_iid, description }) => {
      try {
        await client.updateMrDescription(projectId, mr_iid, description);
        return textResult(`Updated description for MR !${mr_iid}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "submit_review",
    "Post an MR review: optional summary note plus zero or more inline " +
      "discussions anchored to diff positions. Inline comments require the " +
      "MR's current diff_refs (base/head/start SHAs).",
    {
      mr_iid: z.number().int().describe("Merge request IID to review"),
      body: z
        .string()
        .optional()
        .describe("Optional summary note body in markdown"),
      comments: z
        .array(ReviewCommentSchema)
        .optional()
        .describe("Inline review comments"),
    },
    async ({ mr_iid, body, comments }) => {
      try {
        const summary = {
          summaryNoteId: null as number | null,
          discussionsCreated: 0,
          discussionErrors: [] as Array<{ index: number; error: string }>,
        };

        if (body && body.trim().length > 0) {
          const note = await client.createNote(projectId, mr_iid, body);
          summary.summaryNoteId = note.id;
        }

        if (comments && comments.length > 0) {
          const mr = await client.getMr(projectId, mr_iid);
          const diffRefs = mr.diff_refs;
          if (!diffRefs) {
            throw new Error(
              "Merge request is missing diff_refs; cannot anchor inline comments",
            );
          }

          for (let i = 0; i < comments.length; i++) {
            const c = comments[i]!;
            const position = buildPosition(c, diffRefs);
            try {
              await client.createDiscussionOnDiff(
                projectId,
                mr_iid,
                c.body,
                position,
              );
              summary.discussionsCreated += 1;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              summary.discussionErrors.push({ index: i, error: message });
            }
          }
        }

        return textResult(JSON.stringify(summary));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function runServer() {
  const projectId = process.env.CI_PROJECT_ID || process.env.GITLAB_PROJECT_ID;
  const token =
    process.env.GITLAB_TOKEN ||
    process.env.OVERRIDE_GITLAB_TOKEN ||
    process.env.CI_JOB_TOKEN;
  const apiUrl =
    process.env.CI_API_V4_URL ||
    process.env.GITLAB_API_URL ||
    "https://gitlab.com/api/v4";

  if (!projectId) {
    console.error(
      "Error: CI_PROJECT_ID (or GITLAB_PROJECT_ID) environment variable is required",
    );
    process.exit(1);
  }

  if (!token) {
    console.error(
      "Error: GITLAB_TOKEN (or CI_JOB_TOKEN / OVERRIDE_GITLAB_TOKEN) environment variable is required",
    );
    process.exit(1);
  }

  const client = new GitlabClient(token, apiUrl);
  const server = createGitlabMrServer({ projectId, client });

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
