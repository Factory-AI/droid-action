/**
 * Where the post steps are allowed to write.
 *
 * The state file gitlab-prepare writes sits in a directory the review passes
 * can modify (they run as the same OS user with an Execute tool), so nothing
 * in it may choose the project, the MR, or the note a post step edits. The
 * project and MR come from GitLab's own CI variables; a tracking note ID from
 * state is only a hint that is checked against the MR before it is edited.
 */

import type { GitlabClient } from "../api/client";
import type { GitlabNote } from "../types";
import { DROID_TRACKING_MARKER } from "./tracking-note";
import { hasSummaryMarker } from "../../core/review/markers";

export type PostTarget = {
  projectId: string;
  mrIid: number;
};

export class PostTargetMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostTargetMismatchError";
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return parsed > 0 ? parsed : null;
}

/**
 * Takes the project and MR from `CI_PROJECT_ID` / `CI_MERGE_REQUEST_IID`
 * and refuses to continue when the state file names a different target,
 * since that disagreement can only come from tampering.
 */
export function resolvePostTarget(
  state: { projectId?: unknown; mrIid?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): PostTarget {
  const projectId = env.CI_PROJECT_ID?.trim();
  if (!projectId) {
    throw new PostTargetMismatchError(
      "CI_PROJECT_ID is not set; refusing to post without GitLab's own project ID.",
    );
  }
  const mrIid = parsePositiveInt(env.CI_MERGE_REQUEST_IID);
  if (mrIid === null) {
    throw new PostTargetMismatchError(
      "CI_MERGE_REQUEST_IID is not set; refusing to post outside a merge request pipeline.",
    );
  }

  if (
    state.projectId !== undefined &&
    state.projectId !== null &&
    String(state.projectId) !== projectId
  ) {
    throw new PostTargetMismatchError(
      `State file names project ${JSON.stringify(state.projectId)}, but this pipeline belongs to project ${projectId}; refusing to post.`,
    );
  }
  if (
    state.mrIid !== undefined &&
    state.mrIid !== null &&
    Number(state.mrIid) !== mrIid
  ) {
    throw new PostTargetMismatchError(
      `State file names MR !${JSON.stringify(state.mrIid)}, but this pipeline belongs to MR !${mrIid}; refusing to post.`,
    );
  }

  return { projectId, mrIid };
}

export function isOwnTrackingNote(
  note: Pick<GitlabNote, "body" | "author"> | null | undefined,
  userId: number,
): boolean {
  return Boolean(
    note &&
      note.author?.id === userId &&
      typeof note.body === "string" &&
      (hasSummaryMarker(note.body) ||
        note.body.includes(DROID_TRACKING_MARKER)),
  );
}

/** The tracking note this token's user owns on the MR, if any. */
export function findOwnTrackingNote<
  T extends Pick<GitlabNote, "body" | "author">,
>(notes: T[], userId: number): T | undefined {
  return notes.find((note) => isOwnTrackingNote(note, userId));
}

/**
 * Returns the ID of a tracking note on `target` that the token's user wrote,
 * preferring `hintedNoteId`, or null when there is none. Any note that fails
 * the check (another MR, another author, no marker) is never edited.
 */
export async function resolveOwnTrackingNoteId(
  client: GitlabClient,
  target: PostTarget,
  hintedNoteId: unknown,
): Promise<number | null> {
  const user = await client.getCurrentUser();

  if (
    typeof hintedNoteId === "number" &&
    Number.isInteger(hintedNoteId) &&
    hintedNoteId > 0
  ) {
    try {
      const note = await client.getNote(
        target.projectId,
        target.mrIid,
        hintedNoteId,
      );
      if (note?.id === hintedNoteId && isOwnTrackingNote(note, user.id)) {
        return hintedNoteId;
      }
      console.warn(
        `Note ${hintedNoteId} on MR !${target.mrIid} is not a Droid tracking note written by @${user.username}; not editing it.`,
      );
    } catch (error) {
      console.warn(
        `Could not load note ${hintedNoteId} on MR !${target.mrIid}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const notes = await client.listNotes(target.projectId, target.mrIid);
  return findOwnTrackingNote(notes, user.id)?.id ?? null;
}
