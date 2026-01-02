import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { retryWithBackoff } from "../../src/utils/retry";

describe("retryWithBackoff", () => {
  let timeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: Parameters<typeof setTimeout>[0]) => {
        if (typeof handler === "function") {
          handler();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
  });

  it("resolves when the operation succeeds on the first attempt", async () => {
    const result = await retryWithBackoff(async () => "success");

    expect(result).toBe("success");
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it("retries failed attempts until the operation succeeds", async () => {
    let attempts = 0;

    const result = await retryWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`failure ${attempts}`);
        }
        return "ok";
      },
      { maxAttempts: 4, initialDelayMs: 10, backoffFactor: 3, maxDelayMs: 90 },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    const delays = timeoutSpy.mock.calls.map(
      (call: Parameters<typeof setTimeout>) => call[1]! as number,
    );
    expect(delays).toEqual([10, 30]);
  });

  it("throws the last error after exhausting all attempts", async () => {
    let attempts = 0;

    await expect(
      retryWithBackoff(
        async () => {
          attempts += 1;
          throw new Error(`still failing ${attempts}`);
        },
        { maxAttempts: 2, initialDelayMs: 5 },
      ),
    ).rejects.toThrow("still failing 2");

    expect(attempts).toBe(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const firstCall = timeoutSpy.mock.calls[0] as Parameters<typeof setTimeout> | undefined;
    expect(firstCall?.[1]).toBe(5);
  });
});
