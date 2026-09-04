/**
 * Shared shapes for sticky review-tracking comments/notes.
 *
 * Both GitHub and GitLab keep a single "sticky" comment per PR/MR that
 * carries the live status of the Droid review pipeline (running →
 * success/failure) plus telemetry. Both platforms deterministically render
 * final review results from the posting-step JSON, while their markdown
 * layouts and update APIs remain platform-specific.
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
 * Populated on platforms that post from CI, where the numbers are known
 * only after the API calls have been made.
 */
export type ReviewPostOutcome = {
  /** Inline comments successfully posted. */
  posted?: number | null;
  /** Approved comments posted through a non-inline platform fallback. */
  fallbackPosted?: number | null;
  /** Approved comments that failed to post (inline discussion + note fallback). */
  failed?: number | null;
  /** Approved comments dropped before the API (malformed/no anchor). */
  skipped?: number | null;
  /** The validator's overall assessment. */
  summaryBody?: string | null;
};

export type ReviewPostFailure = {
  path: string;
  line: number | null;
  error: string;
};

/** Complete JSON contract written by deterministic platform posting steps. */
export type ReviewPostResults = {
  posted: number;
  fallbackPosted: number;
  approved: number;
  rejected: number;
  failed: number;
  skipped: number;
  summaryBody: string | null;
  failures: ReviewPostFailure[];
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
