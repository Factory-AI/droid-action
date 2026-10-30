import type { ReviewState } from "../markers";
import type { SecurityReportProvenance } from "../security-report";
import type {
  DroppedFinding,
  ReviewFinding,
  ReviewSummaryData,
} from "../validated/types";

export type BadgeMode = "image" | "emoji" | "text";
export type RenderOptions = {
  platform?: "github" | "gitlab";
  badges?: BadgeMode;
  includeCategories?: boolean;
  includeAgentPrompts?: boolean;
  head?: string;
  /** Trusted, platform-generated repository URL, without trailing slash. */
  repositoryUrl?: string;
  base?: string;
  summaryUrl?: string;
  jobUrl?: string;
  configureUrl?: string;
  durationSeconds?: number;
  depth?: string;
  model?: string;
  reasoning?: string;
  commitCount?: number;
  showDroppedFindings?: boolean;
  diagram?: "auto" | "off";
  sections?: string[];
};
export type ReviewRenderInput = RenderOptions & {
  state: "findings" | "clean" | "in_progress" | "failed" | "skipped";
  findings?: ReviewFinding[];
  resolved?: ReviewFinding[];
  summary?: ReviewSummaryData;
  candidatesConsidered?: number;
  postedCount?: number;
  dropped?: DroppedFinding[];
  /** Total preserved when an oversized optional dropped-candidate list is compacted. */
  droppedCount?: number;
  skippedCount?: number;
  blocked?: boolean;
  startedAt?: string;
  previousBody?: string;
  previousHead?: string;
  error?: string;
  skipReason?: string;
  unchangedSuggestions?: number;
  reviewState?: ReviewState;
  /** Full repository scan provenance, separate from ordinary review lifecycle. */
  securityReport?: SecurityReportProvenance;
};
export type CheckRunInput = ReviewRenderInput & {
  phase?: "queued" | "in_progress" | "completed";
  steps?: Array<{
    name: string;
    status: "pending" | "running" | "completed" | "failed";
    durationSeconds?: number;
  }>;
};
