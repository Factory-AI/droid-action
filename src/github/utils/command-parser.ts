/**
 * Command parser for detecting specific @droid commands in GitHub
 * comments and PR bodies. The pure string-parsing portion is platform-
 * agnostic and lives in `src/core/review/triggers/parse-command.ts`;
 * this file owns the GitHub-payload-aware context extraction.
 */

import type { GitHubContext } from "../context";
import {
  parseDroidCommand,
  type DroidCommand,
  type ParsedCommand,
} from "../../core/review/triggers/parse-command";

export type { DroidCommand, ParsedCommand };
export { parseDroidCommand };

/**
 * Extracts a droid command from the GitHub context
 * @param context The GitHub context from the event
 * @returns ParsedCommand with location info, or null if no command found
 */
export function extractCommandFromContext(
  context: GitHubContext,
): ParsedCommand | null {
  if (!context.payload) {
    return null;
  }

  if (
    context.eventName === "pull_request" &&
    "pull_request" in context.payload
  ) {
    const body = context.payload.pull_request.body;
    if (body) {
      const command = parseDroidCommand(body);
      if (command) {
        // PR prose is reviewed data, not authorization to mutate branches or state.
        if (["resolve", "pause", "resume"].includes(command.command)) {
          return { ...command, command: "unknown", location: "body" };
        }
        return { ...command, location: "body" };
      }
    }
  }

  if (context.eventName === "issues" && "issue" in context.payload) {
    const body = context.payload.issue.body;
    if (body) {
      const command = parseDroidCommand(body);
      if (command) {
        if (["resolve", "pause", "resume"].includes(command.command)) {
          return { ...command, command: "unknown", location: "body" };
        }
        return { ...command, location: "body" };
      }
    }
  }

  if (context.eventName === "issue_comment" && "comment" in context.payload) {
    const comment = context.payload.comment;
    if (comment.body) {
      const command = parseDroidCommand(comment.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: comment.created_at,
        };
      }
    }
  }

  if (
    context.eventName === "pull_request_review_comment" &&
    "comment" in context.payload
  ) {
    const comment = context.payload.comment;
    if (comment.body) {
      const command = parseDroidCommand(comment.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: comment.created_at,
        };
      }
    }
  }

  if (
    context.eventName === "pull_request_review" &&
    "review" in context.payload
  ) {
    const review = context.payload.review;
    if (review.body) {
      const command = parseDroidCommand(review.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: review.submitted_at,
        };
      }
    }
  }

  return null;
}
