/**
 * Shared shapes for sticky review-tracking comments/notes.
 *
 * Both GitHub and GitLab keep a single "sticky" comment per PR/MR that
 * carries the live status of the Droid review pipeline (running →
 * success/failure) plus telemetry. The body-building mechanics differ
 * between platforms today — GitHub updates it from inside the agent via
 * the github-comment-server MCP tool, while GitLab builds the whole body
 * in TypeScript and writes it from CI — so we only share the contract
 * (state machine + telemetry shape) here, not the renderer itself.
 */

export type ReviewTrackingState = "running" | "success" | "failure";

export type ReviewTrackingTelemetry = {
  totalNumTurns?: number | null;
  totalDurationMs?: number | null;
  totalCostUsd?: number | null;
  pass1SessionId?: string | null;
  pass2SessionId?: string | null;
};

/**
 * Outcome of the posting step, rendered into the sticky comment/note.
 *
 * Populated on platforms that post from CI (GitLab), where the numbers are
 * known only after the API calls have been made.
 */
export type ReviewPostOutcome = {
  /** Inline comments successfully posted. */
  posted?: number | null;
  /** Approved comments the API refused to anchor. */
  failed?: number | null;
  /** Approved comments dropped before the API (malformed/no anchor). */
  skipped?: number | null;
  /** The validator's overall assessment. */
  summaryBody?: string | null;
};

export interface ReviewTrackingFields {
  state: ReviewTrackingState;
  pipelineUrl?: string | null;
  jobUrl?: string | null;
  triggerUsername?: string | null;
  errorDetails?: string | null;
  securityReviewRan?: boolean;
  telemetry?: ReviewTrackingTelemetry | null;
  review?: ReviewPostOutcome | null;
}
