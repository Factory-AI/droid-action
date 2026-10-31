import type { GitHubContext } from "../context";
import { extractCommandFromContext, parseDroidCommand } from "./command-parser";

/** A persistent description hint is not a new request on every push. */
export function isManualReviewRequest(
  context: GitHubContext,
  mode: "code" | "security" = "code",
): boolean {
  if (context.eventName !== "pull_request") return true;
  if (
    (mode === "security"
      ? context.inputs.automaticSecurityReview
      : context.inputs.automaticReview) ||
    !["opened", "edited"].includes(context.eventAction ?? "")
  )
    return false;
  const command = extractCommandFromContext(context);
  if (
    command?.location !== "body" ||
    !(
      mode === "security"
        ? ["security", "security-full"]
        : ["default", "review"]
    ).includes(command.command)
  )
    return false;
  if (context.eventAction === "edited") {
    const changes =
      "changes" in context.payload ? context.payload.changes : null;
    if (!changes || typeof changes !== "object" || !("body" in changes))
      return false;
    const body = changes.body;
    if (
      !body ||
      typeof body !== "object" ||
      !("from" in body) ||
      (typeof body.from !== "string" && body.from !== null)
    )
      return false;
    const previous = parseDroidCommand(body.from ?? "");
    if (
      previous?.raw.trim().toLowerCase() === command.raw.trim().toLowerCase() &&
      previous.fullReview === command.fullReview &&
      previous.focus === command.focus
    )
      return false;
  }
  return true;
}
