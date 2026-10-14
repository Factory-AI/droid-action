import { createLogger } from "../logger";

const log = createLogger("utils/retry");

export type RetryOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  /**
   * Decides whether a failed attempt is worth retrying. Returning false
   * rethrows the error immediately, skipping the backoff and any remaining
   * attempts. Defaults to retrying every error.
   */
  shouldRetry?: (error: Error) => boolean;
};

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 5000,
    maxDelayMs = 20000,
    backoffFactor = 2,
    shouldRetry,
  } = options;

  let delayMs = initialDelayMs;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log.info("Retrying operation", { attempt, maxAttempts });
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.error("Attempt failed", { attempt, error: lastError });

      if (shouldRetry && !shouldRetry(lastError)) {
        log.error("Error is not retryable; giving up", {
          error: lastError,
        });
        throw lastError;
      }

      if (attempt < maxAttempts) {
        log.info("Waiting before next attempt", {
          delaySeconds: delayMs / 1000,
          nextAttempt: attempt + 1,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
      }
    }
  }

  log.error("Operation failed after all attempts", { maxAttempts });
  throw lastError;
}
