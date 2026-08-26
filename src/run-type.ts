import * as core from "@actions/core";
import type { DroidCommand } from "./core/review/triggers/parse-command";
import type { PrValidationSource } from "./github/operations/comments/common";

export enum DroidRunType {
  Review = "droid-review",
  SecurityReview = "droid-security-review",
  Fill = "droid-fill",
  SecurityScan = "droid-security-scan",
  CiSteward = "ci-steward",
}

export function setDroidRunType(runType: DroidRunType): void {
  core.exportVariable("DROID_EXEC_RUN_TYPE", runType);
}

export function assertDroidRunType(
  runType: DroidRunType,
  expected: DroidRunType,
): void {
  if (runType !== expected) {
    throw new Error(`Expected run type ${expected}, received ${runType}`);
  }
}

export function parseDroidRunType(
  value: string | undefined,
): DroidRunType | undefined {
  return Object.values(DroidRunType).includes(value as DroidRunType)
    ? (value as DroidRunType)
    : undefined;
}

export function prValidationSourceForRunType(
  runType: DroidRunType | undefined,
): PrValidationSource | undefined {
  return runType === DroidRunType.Review ||
    runType === DroidRunType.SecurityReview
    ? "review"
    : undefined;
}

export function resolveTagRunType({
  automaticReview,
  automaticSecurityReview,
  command,
}: {
  automaticReview: boolean;
  automaticSecurityReview: boolean;
  command: DroidCommand | null;
}): DroidRunType {
  if (automaticReview) {
    return DroidRunType.Review;
  }
  if (automaticSecurityReview) {
    return DroidRunType.SecurityReview;
  }

  switch (command) {
    case "fill":
      return DroidRunType.Fill;
    case "security":
      return DroidRunType.SecurityReview;
    case "security-full":
      return DroidRunType.SecurityScan;
    case "review":
    case "default":
    case null:
      return DroidRunType.Review;
  }
}
