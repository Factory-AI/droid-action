import * as core from "@actions/core";
import type { ParsedGitHubContext } from "../../github/context";
import { isPullRequestReviewCommentEvent } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import type { ParsedCommand } from "../../core/review/triggers/parse-command";
import { reviewConfigFromEnvironment } from "../../core/review/config";
import {
  resolveAllDroidThreads,
  setReviewPaused,
} from "../../github/operations/review-lifecycle";
import { redactCredentials } from "../../utils/redact-credentials";
import { retryWithBackoff } from "../../utils/retry";

export function renderCommandHelp(context: ParsedGitHubContext): string {
  const config = context.inputs.reviewConfig ?? reviewConfigFromEnvironment();
  return `### Droid commands

| Command | What it does |
| --- | --- |
| \`@droid\` or \`@droid review\` | Review new changes (full on the first run) |
| \`@droid review --full\` | Re-review the full PR |
| \`@droid review <focus text>\` | Focus on a particular concern |
| \`@droid security\` or \`@droid review security\` | Review security |
| \`@droid security --full\` | Full repository security report |
| \`@droid resolve\` | Resolve all Droid finding threads |
| \`@droid pause\` / \`@droid resume\` | Pause / resume automatic reviews |
| \`@droid fill\` | Update only Droid's generated description block |
| \`@droid help\` | Show this table and current configuration |

<sub>Depth: ${config.review_depth} · Incremental: ${config.review_incremental} · Auto-resolve: ${config.review_auto_resolve} · Auto-run limit: ${config.review_max_auto_runs || "unlimited"}</sub>`;
}

export async function replyToCommand(
  octokit: Octokits,
  context: ParsedGitHubContext,
  body: string,
): Promise<void> {
  const { owner, repo } = context.repository;
  const safeBody = redactCredentials(body);
  if (isPullRequestReviewCommentEvent(context)) {
    await retryWithBackoff(
      () =>
        octokit.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: context.entityNumber,
          comment_id:
            context.payload.comment.in_reply_to_id ??
            context.payload.comment.id,
          body: safeBody,
        }),
      { initialDelayMs: 1000 },
    );
  } else {
    await retryWithBackoff(
      () =>
        octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: context.entityNumber,
          body: safeBody,
        }),
      { initialDelayMs: 1000 },
    );
  }
}

function completed(reason: string): PrepareResult {
  core.setOutput("run_code_review", "false");
  core.setOutput("run_security_review", "false");
  core.setOutput("command_completed", "true");
  // Existing workflows already skip Exec on this output; no model is needed.
  core.setOutput("steward_skipped", "true");
  return {
    skipped: true,
    reason,
    branchInfo: { baseBranch: "", currentBranch: "" },
    mcpTools: "",
  };
}

export async function prepareConversationCommand(options: {
  context: ParsedGitHubContext;
  octokit: Octokits;
  command: ParsedCommand;
}): Promise<PrepareResult> {
  const { context, octokit, command } = options;
  if (["help", "unknown"].includes(command.command) || !context.isPR) {
    await replyToCommand(octokit, context, renderCommandHelp(context));
    return completed("command_help");
  }
  if (command.command === "pause" || command.command === "resume") {
    await setReviewPaused({
      octokit,
      ...context.repository,
      prNumber: context.entityNumber,
      paused: command.command === "pause",
    });
    await replyToCommand(
      octokit,
      context,
      command.command === "pause"
        ? "Automatic reviews are paused for this PR. Comment `@droid resume` to restart them. Manual reviews still work."
        : "Automatic reviews are enabled again for this PR.",
    );
    return completed("review_control");
  }
  if (command.command === "resolve") {
    const count = await resolveAllDroidThreads({
      octokit,
      ...context.repository,
      prNumber: context.entityNumber,
    });
    await replyToCommand(
      octokit,
      context,
      `Resolved ${count} Droid finding thread${count === 1 ? "" : "s"}.`,
    );
    return completed("threads_resolved");
  }
  await replyToCommand(octokit, context, renderCommandHelp(context));
  return completed("command_help");
}
