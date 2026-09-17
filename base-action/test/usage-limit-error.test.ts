import { describe, expect, test } from "bun:test";
import {
  describeUsageLimitError,
  isUsageLimitError,
} from "../src/utils/usage-limit-error";

const FACTORY_402 =
  '402 {"detail":"You\'ve reached your weekly Droid Core usage limit (resets in 5 days).\\nReload Extra Usage credits or wait for your limits to reset.","status":402,"title":"Payment Required","displayToUser":true,"requestId":"req_123"}';

describe("isUsageLimitError", () => {
  test("matches the raw 402 body droid exec reports on the stream", () => {
    expect(isUsageLimitError(FACTORY_402)).toBe(true);
  });

  test("matches an Error-prefixed 402 and a BYOK provider 402", () => {
    expect(isUsageLimitError(`Error: ${FACTORY_402}`)).toBe(true);
    expect(isUsageLimitError("402 Insufficient Balance")).toBe(true);
  });

  test("matches a 402 body whose status prefix was stripped", () => {
    expect(
      isUsageLimitError(
        '{"detail":"Credit limit reached.","status":402,"displayToUser":true}',
      ),
    ).toBe(true);
  });

  test("matches the usage-limit copy without any status code", () => {
    expect(
      isUsageLimitError(
        "You've reached your 5-hour standard usage limit (resets in 1h 0min).",
      ),
    ).toBe(true);
    expect(
      isUsageLimitError(
        "Your standard model budget is exhausted. You have been switched to kimi-k3 (Droid Core)",
      ),
    ).toBe(true);
  });

  test("ignores other failures", () => {
    expect(
      isUsageLimitError(
        '403 {"detail":"This model is not available due to your organization\'s security settings.","status":403}',
      ),
    ).toBe(false);
    expect(isUsageLimitError("Connection error: ECONNRESET")).toBe(false);
    // A 402 mentioned mid-message (e.g. in reviewed code) is not a status.
    expect(isUsageLimitError("handles HTTP 402 responses gracefully")).toBe(
      false,
    );
    expect(isUsageLimitError("")).toBe(false);
    expect(isUsageLimitError(undefined)).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });
});

describe("describeUsageLimitError", () => {
  test("extracts the detail from a 402 JSON body", () => {
    expect(describeUsageLimitError(FACTORY_402)).toBe(
      "You've reached your weekly Droid Core usage limit (resets in 5 days).\nReload Extra Usage credits or wait for your limits to reset.",
    );
  });

  test("falls back to the raw text when there is no JSON detail", () => {
    expect(describeUsageLimitError("402 Insufficient Balance ")).toBe(
      "402 Insufficient Balance",
    );
    expect(describeUsageLimitError('402 {"status":402}')).toBe(
      '402 {"status":402}',
    );
    expect(describeUsageLimitError("402 {not json")).toBe("402 {not json");
  });
});
