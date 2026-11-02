import { describe, expect, it } from "bun:test";
import { SECURITY_SEVERITY_RANK } from "../../../src/core/review/validated/finding";

describe("rich validated review schema", () => {
  it("shares the exact publisher security-level ordering without changing priority policy", () => {
    expect(SECURITY_SEVERITY_RANK).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    });
    expect(
      SECURITY_SEVERITY_RANK.critical < SECURITY_SEVERITY_RANK.high &&
        SECURITY_SEVERITY_RANK.high < SECURITY_SEVERITY_RANK.medium &&
        SECURITY_SEVERITY_RANK.medium < SECURITY_SEVERITY_RANK.low,
    ).toBe(true);
  });
});
