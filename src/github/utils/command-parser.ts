/**
 * Command parser for detecting specific @droid commands in GitHub comments and PR bodies
 */

import type { GitHubContext } from "../context";

export type DroidCommand =
  | "fill"
  | "review"
  | "security"
  | "security-full"
  | "default";

export interface ParsedCommand {
  command: DroidCommand;
  raw: string;
  location: "body" | "comment";
  timestamp?: string | null;
}

/**
 * Parses text to detect specific @droid commands
 * @param text The text to parse (comment body or PR description)
 * @returns ParsedCommand if a command is found, null otherwise
 */
export function parseDroidCommand(text: string): ParsedCommand | null {
  if (!text) {
    return null;
  }

  // Check for @droid fill command (case insensitive)
  const fillMatch = text.match(/@droid\s+fill/i);
  if (fillMatch) {
    return {
      command: "fill",
      raw: fillMatch[0],
      location: "body", // Will be set by caller
    };
  }

  // Check for @droid review command (case insensitive)
  // Note: @droid review security will match as just @droid review
  const reviewMatch = text.match(/@droid\s+review/i);
  if (reviewMatch) {
    return {
      command: "review",
      raw: reviewMatch[0],
      location: "body", // Will be set by caller
    };
  }

  // Check for @droid security --full command (case insensitive)
  const securityFullMatch = text.match(/@droid\s+security\s+--full/i);
  if (securityFullMatch) {
    return {
      command: "security-full",
      raw: securityFullMatch[0],
      location: "body", // Will be set by caller
    };
  }

  // Check for @droid security command (case insensitive)
  // Must check after security-full to avoid false matches
  const securityMatch = text.match(/@droid\s+security(?:\s|$|[^-\w])/i);
  if (securityMatch) {
    return {
      command: "security",
      raw: securityMatch[0].trim(),
      location: "body", // Will be set by caller
    };
  }

  // Check for generic @droid mention (default behavior)
  const droidMatch = text.match(/@droid/i);
  if (droidMatch) {
    return {
      command: "default",
      raw: droidMatch[0],
      location: "body", // Will be set by caller
    };
  }

  return null;
}

/**
 * Extracts a droid command from the GitHub context
 * @param context The GitHub context from the event
 * @returns ParsedCommand with location info, or null if no command found
 */
export function extractCommandFromContext(
  context: GitHubContext,
): ParsedCommand | null {
  // Handle missing payload
  if (!context.payload) {
    return null;
  }

  // Check PR body for commands (pull_request events)
  if (
    context.eventName === "pull_request" &&
    "pull_request" in context.payload
  ) {
    const body = context.payload.pull_request.body;
    if (body) {
      const command = parseDroidCommand(body);
      if (command) {
        return { ...command, location: "body" };
      }
    }
  }

  // Check issue body for commands (issues events)
  if (context.eventName === "issues" && "issue" in context.payload) {
    const body = context.payload.issue.body;
    if (body) {
      const command = parseDroidCommand(body);
      if (command) {
        return { ...command, location: "body" };
      }
    }
  }

  // Check comment body for commands (issue_comment events)
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

  // Check review comment body (pull_request_review_comment events)
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

  // Check review body (pull_request_review events)
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
