import { describe, expect, it } from "bun:test";
import {
  assertDroidRunType,
  DroidRunType,
  parseDroidRunType,
  prValidationSourceForRunType,
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

  it("maps PR review run types to the review validation source", () => {
    expect(prValidationSourceForRunType(DroidRunType.Review)).toBe("review");
    expect(prValidationSourceForRunType(DroidRunType.SecurityReview)).toBe(
      "review",
    );
    expect(prValidationSourceForRunType(DroidRunType.Fill)).toBeUndefined();
    expect(
      prValidationSourceForRunType(DroidRunType.SecurityScan),
    ).toBeUndefined();
    expect(
      prValidationSourceForRunType(DroidRunType.CiSteward),
    ).toBeUndefined();
  });
});
