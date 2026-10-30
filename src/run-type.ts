import * as core from "@actions/core";
import { exportRuntimeVariable } from "./utils/runtime-env";
import type { DroidCommand } from "./core/review/triggers/parse-command";

export enum DroidRunType {
  Default = "droid-default",
  Review = "droid-review",
  SecurityReview = "droid-security-review",
  Fill = "droid-fill",
  SecurityScan = "droid-security-scan",
  CiSteward = "ci-steward",
  Fix = "droid-fix",
  Question = "droid-question",
  Help = "droid-help",
  Control = "droid-control",
}

export type PrValidationRunType =
  | DroidRunType.Default
  | DroidRunType.Review
  | DroidRunType.SecurityReview
  | DroidRunType.SecurityScan;

export function setDroidRunType(runType: DroidRunType): void {
  exportRuntimeVariable("DROID_EXEC_RUN_TYPE", runType);
  core.setOutput("droid_exec_run_type", runType);
}

export function assertDroidRunType(
  runType: DroidRunType | null,
  expected: DroidRunType | null | readonly (DroidRunType | null)[],
): void {
  const expectedRunTypes = Array.isArray(expected) ? expected : [expected];
  if (!expectedRunTypes.includes(runType)) {
    throw new Error(
      `Expected run type ${expectedRunTypes.join(" or ")}, received ${runType}`,
    );
  }
}

export function parseDroidRunType(
  value: string | undefined,
): DroidRunType | undefined {
  return Object.values(DroidRunType).includes(value as DroidRunType)
    ? (value as DroidRunType)
    : undefined;
}

export function getPrValidationRunType(
  runType: DroidRunType | null | undefined,
): PrValidationRunType | undefined {
  return runType === DroidRunType.Default ||
    runType === DroidRunType.Review ||
    runType === DroidRunType.SecurityReview ||
    runType === DroidRunType.SecurityScan
    ? runType
    : undefined;
}

export function parsePrValidationRunType(
  value: string | undefined,
): PrValidationRunType | undefined {
  return getPrValidationRunType(parseDroidRunType(value));
}

export function resolveTagRunType({
  automaticReview,
  automaticSecurityReview,
  command,
}: {
  automaticReview: boolean;
  automaticSecurityReview: boolean;
  command: DroidCommand | null;
}): DroidRunType | null {
  if (automaticReview) {
    return DroidRunType.Review;
  }
  if (automaticSecurityReview) {
    return DroidRunType.SecurityReview;
  }

  switch (command) {
    case "fix":
      return DroidRunType.Fix;
    case "question":
      return DroidRunType.Question;
    case "help":
    case "unknown":
      return DroidRunType.Help;
    case "resolve":
    case "pause":
    case "resume":
      return DroidRunType.Control;
    case "fill":
      return DroidRunType.Fill;
    case "security":
      return DroidRunType.SecurityReview;
    case "security-full":
      return DroidRunType.SecurityScan;
    case "review":
      return DroidRunType.Review;
    case "default":
      return DroidRunType.Default;
    case null:
      return null;
  }
}
