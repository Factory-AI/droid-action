import { z } from "zod";
import { DroidRunType, resolveTagRunType } from "../run-type";
import { isEntityContext, type GitHubContext } from "./context";
import { extractCommandFromContext } from "./utils/command-parser";

const PermissionLevelSchema = z.enum(["read", "write"]);

// Mirrors what the token-exchange endpoint accepts. Metadata read is always
// added by the endpoint, so it is not listed.
const AppTokenPermissionsSchema = z
  .object({
    actions: PermissionLevelSchema.optional(),
    contents: PermissionLevelSchema.optional(),
    issues: PermissionLevelSchema.optional(),
    pull_requests: PermissionLevelSchema.optional(),
  })
  .strict();

/** Repository permissions a Factory Droid App token can be narrowed to. */
export type AppTokenPermissions = z.infer<typeof AppTokenPermissionsSchema>;

/**
 * The narrowest Factory Droid App token each flow of the full action can run
 * with. Workflows, checks, statuses and every other permission the app holds
 * stay off, so a leaked token reaches no further than the flow it was minted
 * for. Job logs and reruns go through the workflow token, never this one.
 */
export function appTokenPermissionsFor(
  context: GitHubContext,
): AppTokenPermissions {
  if (!isEntityContext(context)) {
    if (context.eventName === "workflow_run" && context.inputs.ciSteward) {
      // The gate lists workflow runs and jobs with this token. Fixes can also
      // be turned on by .github/droid-ci.yml, which is itself read with this
      // token, so contents write cannot wait until the config is known.
      return { actions: "read", contents: "write", pull_requests: "write" };
    }
    return { contents: "read" };
  }

  // A full scan pushes a report branch and opens a pull request for it.
  const parsed = extractCommandFromContext(context);
  const command = parsed?.command ?? null;
  const runType = resolveTagRunType({
    automaticReview:
      parsed?.location === "comment" ? false : context.inputs.automaticReview,
    automaticSecurityReview:
      parsed?.location === "comment"
        ? false
        : context.inputs.automaticSecurityReview,
    command,
  });
  const fullScan = runType === DroidRunType.SecurityScan;
  const fixes = runType === DroidRunType.Fix;
  if (context.isPR) {
    return {
      contents: fullScan || fixes ? "write" : "read",
      pull_requests: "write",
    };
  }
  return fullScan
    ? { contents: "write", issues: "write", pull_requests: "write" }
    : { contents: "read", issues: "write" };
}

/**
 * Reads the permissions a sub-action asks get-token for. Unset keeps the
 * app's full permission set; anything unrecognized fails instead of minting a
 * broader token than the sub-action asked for.
 */
export function parseAppTokenPermissions(
  value: string | undefined,
): AppTokenPermissions | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`APP_TOKEN_PERMISSIONS is not valid JSON: ${raw}`);
  }
  const parsed = AppTokenPermissionsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `APP_TOKEN_PERMISSIONS is not a supported permission set: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data;
}

export function describeAppTokenPermissions(
  permissions: AppTokenPermissions,
): string {
  return Object.entries(permissions)
    .map(([name, level]) => `${name}:${level}`)
    .join(", ");
}
