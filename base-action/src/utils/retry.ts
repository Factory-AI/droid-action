export type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: Error) => boolean;
};

/**
 * Retry an async operation with exponential backoff.
 * Used for transient failures (Droid Exec, MCP registration, network calls).
 *
 * Mirrors `src/utils/retry.ts`; base-action is published standalone and cannot
 * import from the parent `src/`, so the helper is duplicated here rather than
 * shared.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 5000,
    maxDelayMs = 20000,
    backoffFactor = 2,
    shouldRetry = () => true,
  } = options;

  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Attempt ${attempt} of ${maxAttempts}...`);
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Attempt ${attempt} failed:`, lastError.message);

      if (!shouldRetry(lastError)) {
        console.log("Failure is not retryable; stopping.");
        throw lastError;
      }

      if (attempt < maxAttempts) {
        console.log(`Retrying in ${delayMs / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  console.error(`Operation failed after ${maxAttempts} attempts`);
  throw lastError;
}
