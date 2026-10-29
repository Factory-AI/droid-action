import { retryWithBackoff } from "../../utils/retry";
import { redactCredentials } from "../../utils/redact-credentials";

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
