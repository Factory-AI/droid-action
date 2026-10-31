#!/usr/bin/env bun
import { timingSafeEqual } from "node:crypto";
import { GitlabClient } from "../src/gitlab/api/client";
import { parseDroidCommand } from "../src/core/review/triggers/parse-command";
import { hasGitlabWriteAccess } from "../src/gitlab/operations/review-ux";
import { assertGitlabFixRef } from "../src/gitlab/operations/commands";
import { record } from "../src/core/review/validated/finding";
import { z } from "zod";

const pipelineDelegationsSchema = z
  .array(
    z
      .object({
        authorId: z.number().int().positive().safe(),
        sourceBranches: z
          .array(
            z.string().refine((branch) => {
              try {
                // Reuse ref syntax validation; this is not a pipeline head.
                assertGitlabFixRef(branch, "0".repeat(40));
                return true;
              } catch {
                return false;
              }
            }),
          )
          .min(1),
      })
      .strict(),
  )
  .min(1);

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

async function copyResponse(response: Response): Promise<Response> {
  return new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}

/** An opt-in bridge, not a claim that GitLab note hooks start CI natively. */
export function createNotePipelineBridge(options: {
  client: GitlabClient;
  projectId: number;
  webhookSecret: string;
  pipelineDelegations: unknown;
  trigger: (input: {
    ref: string;
    mrIid: number;
    noteId: number;
  }) => Promise<void>;
}): (request: Request) => Promise<Response> {
  const { client, projectId, webhookSecret, trigger } = options;
  if (!Number.isSafeInteger(projectId) || projectId <= 0)
    throw new Error("The bridge requires a positive configured project ID");
  const policy = pipelineDelegationsSchema.safeParse(
    options.pipelineDelegations,
  );
  if (!policy.success)
    throw new Error(
      "GITLAB_BRIDGE_PIPELINE_DELEGATIONS must be a nonempty list of positive safe author IDs and exact valid source-branch lists",
    );
  const delegations = policy.data;
  const completed = new Set<number>();
  const inFlight = new Map<number, Promise<Response>>();
  return async (request) => {
    const supplied = Buffer.from(request.headers.get("x-gitlab-token") ?? "");
    const expected = Buffer.from(webhookSecret);
    if (
      !expected.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return Response.json({ error: "Unauthorized webhook" }, { status: 401 });
    if (
      request.method !== "POST" ||
      request.headers.get("x-gitlab-event") !== "Note Hook"
    )
      return Response.json({ skipped: "Not a note event" });
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024 * 1024)
      return Response.json({ error: "Webhook too large" }, { status: 413 });
    let payload: Record<string, unknown> | null;
    try {
      payload = record(JSON.parse(text));
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const attributes = record(payload?.object_attributes);
    const project = record(payload?.project);
    const mergeRequest = record(payload?.merge_request);
    const noteId = positive(attributes?.id);
    const mrIid = positive(mergeRequest?.iid);
    if (
      payload?.object_kind !== "note" ||
      project?.id !== projectId ||
      attributes?.noteable_type !== "MergeRequest" ||
      attributes?.system === true ||
      (attributes?.action && attributes.action !== "create") ||
      !noteId ||
      !mrIid
    )
      return Response.json({ skipped: "Not a new note on an allowed MR" });
    if (completed.has(noteId))
      return Response.json({ skipped: "Note already dispatched" });
    const pending = inFlight.get(noteId);
    if (pending) return copyResponse(await pending);
    const dispatch = (async () => {
      try {
        // The webhook body is merely an addressing hint. Fetch the live note,
        // actual author, and current MR branch before triggering anything.
        const [note, mr, user] = await Promise.all([
          client.getNote(projectId, mrIid, noteId),
          client.getMr(projectId, mrIid),
          client.getCurrentUser(),
        ]);
        if (note.author.id === user.id || !parseDroidCommand(note.body))
          return Response.json({ skipped: "No human Droid command" });
        if (
          !hasGitlabWriteAccess(
            await client.getMember(projectId, note.author.id),
          )
        )
          return Response.json(
            {
              error:
                "Droid commands require an active project Developer, Maintainer, or Owner",
            },
            { status: 403 },
          );
        if (mr.state !== "opened")
          return Response.json({ skipped: "MR is not open" });
        if (mr.project_id !== projectId || mr.iid !== mrIid)
          return Response.json(
            { error: "The live MR does not belong to this bridge target" },
            { status: 403 },
          );
        assertGitlabFixRef(mr.source_branch, mr.diff_refs.head_sha);
        if (
          !delegations.some(
            (entry) =>
              entry.authorId === note.author.id &&
              entry.sourceBranches.includes(mr.source_branch),
          )
        )
          return Response.json(
            {
              error:
                "The operator has not delegated pipeline authority to this author and source branch",
            },
            { status: 403 },
          );
        if (
          mr.source_project_id !== projectId ||
          mr.target_project_id !== projectId
        ) {
          await client.createNote(
            projectId,
            mrIid,
            "Droid could not start this command: a fork's source branch is not a pipeline ref in the target project. Run the review in an explicitly trusted fork pipeline with correctly scoped credentials, or apply the finding's AI-agent prompt manually. The bridge does not run fork code with target-project secrets.",
          );
          completed.add(noteId);
          return Response.json({
            skipped:
              "Fork command pipeline requires an explicitly configured trusted route",
          });
        }
        await trigger({ ref: mr.source_branch, mrIid, noteId });
        completed.add(noteId);
        return Response.json({ dispatched: true });
      } catch {
        return Response.json(
          {
            error:
              "GitLab could not dispatch the command; check bridge credentials and retry",
          },
          { status: 502 },
        );
      }
    })();
    inFlight.set(noteId, dispatch);
    try {
      return copyResponse(await dispatch);
    } finally {
      inFlight.delete(noteId);
    }
  };
}

if (import.meta.main) {
  const {
    GITLAB_BRIDGE_WEBHOOK_SECRET: webhookSecret,
    GITLAB_BRIDGE_API_TOKEN: token,
    GITLAB_PIPELINE_TRIGGER_TOKEN: triggerToken,
    GITLAB_BRIDGE_PIPELINE_DELEGATIONS: rawDelegations,
  } = process.env;
  const projectId = Number(process.env.GITLAB_BRIDGE_PROJECT_ID);
  if (
    !webhookSecret ||
    !token ||
    !triggerToken ||
    !rawDelegations ||
    !Number.isSafeInteger(projectId) ||
    projectId <= 0
  )
    throw new Error(
      "Set GITLAB_BRIDGE_WEBHOOK_SECRET, GITLAB_BRIDGE_API_TOKEN, GITLAB_PIPELINE_TRIGGER_TOKEN, GITLAB_BRIDGE_PROJECT_ID, and GITLAB_BRIDGE_PIPELINE_DELEGATIONS",
    );
  let pipelineDelegations: unknown;
  try {
    pipelineDelegations = JSON.parse(rawDelegations);
  } catch {
    throw new Error("GITLAB_BRIDGE_PIPELINE_DELEGATIONS must be valid JSON");
  }
  const apiUrl = new URL(
    process.env.GITLAB_BRIDGE_API_URL || "https://gitlab.com/api/v4",
  );
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  )
    throw new Error(
      "Bridge API URL must be a credential-free HTTPS GitLab API base URL",
    );
  const client = new GitlabClient(token, apiUrl.href);
  const fetch = createNotePipelineBridge({
    client,
    projectId,
    webhookSecret,
    pipelineDelegations,
    trigger: async ({ ref, mrIid, noteId }) => {
      const body = new URLSearchParams({
        token: triggerToken,
        ref,
        "variables[CI_MERGE_REQUEST_IID]": String(mrIid),
        "variables[DROID_TRIGGER_NOTE_ID]": String(noteId),
      });
      const result = await globalThis.fetch(
        `${apiUrl.href.replace(/\/$/, "")}/projects/${projectId}/trigger/pipeline`,
        { method: "POST", body, redirect: "error" },
      );
      if (!result.ok) throw new Error("GitLab rejected pipeline trigger");
    },
  });
  Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.GITLAB_BRIDGE_PORT || "8787"),
    fetch,
  });
  console.log(
    "GitLab note bridge is listening on loopback; expose it only through an authenticated TLS proxy",
  );
}
