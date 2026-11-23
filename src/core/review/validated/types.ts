export type ReviewSeverity = "P0" | "P1" | "P2";

export type FindingLocation = {
  path: string;
  line?: number;
  startLine?: number;
  url?: string;
};

/** Layout-free data produced by the validator. Legacy comments are normalized to this shape. */
export type ReviewFinding = {
  id: string;
  title: string;
  severity: ReviewSeverity;
  category: string;
  security: boolean;
  securitySeverity?: "critical" | "high" | "medium" | "low";
  cwe?: string;
  path: string;
  /** Original path for LEFT-side findings on renamed or deleted files. */
  oldPath?: string;
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  also_at: FindingLocation[];
  body: string;
  why: string;
  verification: string;
  suggestion?: string;
  agent_prompt: string;
  outside_diff: boolean;
  source_guideline?: FindingLocation;
  threadUrl?: string;
  threadId?: string | number;
  state?: "open" | "resolved" | "dismissed";
  isNew?: boolean;
  /** Explicit validator classification, never inferred solely from priority. */
  optionalSuggestion?: boolean;
  fixedIn?: string;
  /** Native thread work is separate from the validator's finding verdict. */
  pendingThreadAction?: "resolve" | "reopen";
};

export type DroppedFinding = {
  index: number;
  path: string | null;
  title?: string;
  reason: string;
};

export type ReviewSummaryData = {
  body?: string;
  whatChanged?: string;
  changes?: Array<{ area: string; files: string[]; summary: string }>;
  risk?: { level: "Low" | "Medium" | "High"; reason: string };
  diagram?: string;
  effort?: { score: number; minutes?: number };
  suggestedReviewers?: string[];
  preMergeChecks?: Array<{ name: string; passed: boolean; reason?: string }>;
  filesReviewed?: number;
  filesSkipped?: Array<{ path: string; reason: string }>;
  /** Preserves the count if only a bounded skipped-file preview can be rendered. */
  filesSkippedCount?: number;
  guidelines?: FindingLocation[];
  security?: {
    enabled: boolean;
    threshold?: string;
    blockOnCritical?: boolean;
    blockOnHigh?: boolean;
  };
};
