import type { ParsedCommand } from "../review/triggers/parse-command";

export const RUN_MODES = ["auto", "review", "risk", "both"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Empty means the default, `auto`; anything else unknown fails the run. */
export function parseRunMode(value: string | undefined): RunMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "auto";
  const mode = RUN_MODES.find((candidate) => candidate === normalized);
  if (!mode)
    throw new Error(
      `The run input must be auto, review, risk or both, not ${JSON.stringify(value)}.`,
    );
  return mode;
}

export type RunPlanInput = {
  /** automatic_risk_assessment, or its deprecated alias risk_assessment. */
  automaticRisk: boolean;
  run: RunMode;
  eventName: string;
  eventAction?: string;
  isPR: boolean;
  isDraft: boolean;
  /** The parsed command of a comment event. */
  command?: ParsedCommand;
  /** risk_pr_number, which makes a workflow_dispatch a risk request. */
  riskPrNumber?: string;
};

export type RunPlan = {
  /** `auto` keeps today's trigger rules; `manual` skips the event allowlist and draft gate. */
  review: "auto" | "manual" | "off";
  risk: boolean;
  riskManual: boolean;
  /** One line for the log. */
  reason: string;
};

// The events after which the head Factory scored may no longer be the head.
const SCORED_PR_ACTIONS = [
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
];

/**
 * Decides once, from the event, whether this run reviews, assesses risk, or
 * both. Only the review steps' existing trigger rules and the backend's begin
 * decision narrow it further.
 */
export function resolveRunPlan(input: RunPlanInput): RunPlan {
  const prComment = input.eventName === "issue_comment" && input.isPR;
  const command = prComment ? input.command?.command : undefined;

  // Explicit requests run whatever the automatic settings say. Both already
  // passed a write-access check: dispatch needs write access to start, and a
  // comment's actor is checked before the plan is made.
  if (command === "risk")
    return {
      review: "off",
      risk: true,
      riskManual: true,
      reason: "@droid risk comment: risk assessment only, as a manual request",
    };
  if (input.eventName === "workflow_dispatch" && input.riskPrNumber?.trim())
    return {
      review: "off",
      risk: true,
      riskManual: true,
      reason:
        "workflow_dispatch with risk_pr_number: risk assessment only, as a manual request",
    };

  if (!input.automaticRisk)
    return {
      review: "auto",
      risk: false,
      riskManual: false,
      reason: "automatic_risk_assessment is off: review per config, no risk",
    };

  const prEvent =
    input.eventName === "pull_request" ||
    input.eventName === "pull_request_target";
  const scored = prEvent && SCORED_PR_ACTIONS.includes(input.eventAction ?? "");
  const event = `${input.eventName}${input.eventAction ? ` ${input.eventAction}` : ""}${input.isDraft ? " (draft)" : ""}`;

  switch (input.run) {
    case "review":
      return {
        review: "auto",
        risk: false,
        riskManual: false,
        reason: `run: review, ${event}: review per config, no automatic risk`,
      };
    case "risk":
      return {
        review: "off",
        risk: scored,
        riskManual: false,
        reason: `run: risk, ${event}: ${scored ? "risk only" : "nothing to do"}`,
      };
    case "both": {
      // A conversation doesn't change the code, so only a push-like event or
      // an @droid review comment is assessed.
      const assessed = scored || command === "review" || command === "default";
      return {
        review: "manual",
        risk: assessed,
        riskManual: false,
        reason: `run: both, ${event}: ${assessed ? "review, then risk" : "review, no risk"}`,
      };
    }
    case "auto":
      break;
  }

  if (command === "review" || command === "default")
    return {
      review: "manual",
      risk: true,
      riskManual: false,
      reason: "auto, @droid review comment: review, then risk",
    };
  if (prEvent)
    return {
      review: "auto",
      // Drafts are assessed too: begin withdraws approvals of older commits.
      risk: scored,
      riskManual: false,
      reason: `auto, ${event}: ${scored ? "review per config, then risk" : "review per config, no risk"}`,
    };
  return {
    review: "auto",
    risk: false,
    riskManual: false,
    reason: `auto, ${event}: review per config, no risk`,
  };
}
