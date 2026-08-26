import { describe, expect, it } from "bun:test";
import {
  assertDroidRunType,
  DroidRunType,
  getPrValidationRunType,
  parseDroidRunType,
  resolveTagRunType,
} from "../src/run-type";

describe("DroidRunType", () => {
  it.each([
    [true, true, null, DroidRunType.Review],
    [true, false, null, DroidRunType.Review],
    [false, true, null, DroidRunType.SecurityReview],
    [false, false, "review", DroidRunType.Review],
    [false, false, "default", DroidRunType.Review],
    [false, false, null, DroidRunType.Review],
    [false, false, "security", DroidRunType.SecurityReview],
    [false, false, "security-full", DroidRunType.SecurityScan],
    [false, false, "fill", DroidRunType.Fill],
  ] as const)(
    "resolves automaticReview=%s automaticSecurityReview=%s command=%s",
    (automaticReview, automaticSecurityReview, command, expected) => {
      expect(
        resolveTagRunType({
          automaticReview,
          automaticSecurityReview,
          command,
        }),
      ).toBe(expected);
    },
  );

  it("parses only known run types", () => {
    expect(parseDroidRunType(DroidRunType.Review)).toBe(DroidRunType.Review);
    expect(parseDroidRunType("unknown")).toBeUndefined();
  });

  it("rejects a run type passed to the wrong mode", () => {
    expect(() =>
      assertDroidRunType(DroidRunType.Fill, DroidRunType.Review),
    ).toThrow("Expected run type droid-review, received droid-fill");
  });

  it("selects the run types that produce PR validation markers", () => {
    expect(getPrValidationRunType(DroidRunType.Review)).toBe(
      DroidRunType.Review,
    );
    expect(getPrValidationRunType(DroidRunType.SecurityReview)).toBe(
      DroidRunType.SecurityReview,
    );
    expect(getPrValidationRunType(DroidRunType.SecurityScan)).toBe(
      DroidRunType.SecurityScan,
    );
    expect(getPrValidationRunType(DroidRunType.Fill)).toBeUndefined();
    expect(getPrValidationRunType(DroidRunType.CiSteward)).toBeUndefined();
  });
});
