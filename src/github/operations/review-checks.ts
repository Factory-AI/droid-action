import type { Octokits } from "../api/client";
import type {
  ReviewFinding,
  ReviewSeverity,
} from "../../core/review/validated/types";
import { retryWithBackoff } from "../../utils/retry";
import { redactCredentials } from "../../utils/redact-credentials";

export type ReviewCheckConclusion = "success" | "neutral" | "failure";
export type ReviewCheckPolicy = {
  failOnSeverity?: string;
  securityBlockOnCritical?: boolean;
  securityBlockOnHigh?: boolean;
};

export function reviewCheckConclusion(
  findings: ReviewFinding[],
  policy: ReviewCheckPolicy = {},
  failed = false,
): ReviewCheckConclusion {
  if (failed) return "neutral";
  const rank: Record<ReviewSeverity, number> = { P0: 0, P1: 1, P2: 2 };
  const threshold = policy.failOnSeverity?.toUpperCase();
  const open = findings.filter(
    (finding) => finding.state !== "resolved" && finding.state !== "dismissed",
  );
  const blocking = open.some((finding) => {
    if (
      (threshold === "P0" || threshold === "P1" || threshold === "P2") &&
      rank[finding.severity] <= rank[threshold]
    )
      return true;
    if (!finding.security) return false;
    const securitySeverity = finding.securitySeverity;
    return (
      (policy.securityBlockOnCritical !== false &&
        securitySeverity === "critical") ||
      (policy.securityBlockOnHigh === true &&
        (securitySeverity === "critical" || securitySeverity === "high"))
    );
  });
  return blocking ? "failure" : open.length > 0 ? "neutral" : "success";
}

export function isPermissionError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

/** A shared per-run callback deduplicates warnings across checks, reactions, and threads. */
export async function optionalGitHubOperation<T>(
  operation: () => Promise<T>,
  warn: (message: string) => void,
): Promise<T | undefined> {
  try {
    return await retryWithBackoff(
      async () => {
        try {
          return await operation();
        } catch (error) {
          const safeError = new Error(
            redactCredentials(
              error instanceof Error ? error.message : String(error),
            ),
          );
          if (error && typeof error === "object" && "status" in error)
            Object.assign(safeError, { status: error.status });
          throw safeError;
        }
      },
      {
        maxAttempts: 3,
        initialDelayMs: 250,
        maxDelayMs: 1000,
        shouldRetry: (error) => !isPermissionError(error),
      },
    );
  } catch {
    warn(
      "Droid could not update all review metadata. Check token permissions (checks: write and pull-requests: write). The review result is unchanged.",
    );
    return undefined;
  }
}

export async function createReviewCheck(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  head: string;
  securityOnly?: boolean;
  enabled?: boolean;
  jobUrl?: string;
  warn: (message: string) => void;
}): Promise<number | undefined> {
  if (options.enabled === false) return undefined;
  const response = await optionalGitHubOperation(
    () =>
      options.octokit.rest.checks.create({
        owner: options.owner,
        repo: options.repo,
        name: options.securityOnly ? "Droid Security Review" : "Droid Review",
        head_sha: options.head,
        status: "queued",
        ...(options.jobUrl ? { details_url: options.jobUrl } : {}),
        output: {
          title: "Queued…",
          summary: "Droid is waiting to gather PR context.",
        },
      }),
    options.warn,
  );
  return response?.data.id;
}

export async function updateReviewCheck(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  checkId?: number;
  status: "in_progress" | "completed";
  conclusion?: ReviewCheckConclusion;
  title: string;
  summary: string;
  text?: string;
  warn: (message: string) => void;
}): Promise<void> {
  if (!options.checkId) return;
  await optionalGitHubOperation(
    () =>
      options.octokit.rest.checks.update({
        owner: options.owner,
        repo: options.repo,
        check_run_id: options.checkId!,
        status: options.status,
        ...(options.status === "completed"
          ? {
              conclusion: options.conclusion ?? "neutral",
              completed_at: new Date().toISOString(),
            }
          : {}),
        output: {
          title: options.title,
          summary: options.summary || "Droid Review",
          ...(options.text ? { text: options.text } : {}),
        },
      }),
    options.warn,
  );
}
