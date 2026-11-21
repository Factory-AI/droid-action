import { describe, expect, it } from "bun:test";
import {
  parseRunMode,
  resolveRunPlan,
  RUN_MODES,
  type RunPlan,
  type RunPlanInput,
} from "../src/core/risk/run-plan";
import {
  parseDroidCommand,
  type ParsedCommand,
} from "../src/core/review/triggers/parse-command";

function command(text: string): ParsedCommand {
  const parsed = parseDroidCommand(text);
  if (!parsed) throw new Error(`${text} does not parse as a command`);
  return { ...parsed, location: "comment" };
}

const pr = (
  action: string,
  extra: Partial<RunPlanInput> = {},
): Omit<RunPlanInput, "automaticRisk" | "run"> => ({
  eventName: "pull_request",
  eventAction: action,
  isPR: true,
  isDraft: false,
  ...extra,
});
const prComment = (
  text: string,
  extra: Partial<RunPlanInput> = {},
): Omit<RunPlanInput, "automaticRisk" | "run"> => ({
  eventName: "issue_comment",
  eventAction: "created",
  isPR: true,
  isDraft: false,
  command: command(text),
  ...extra,
});
const dispatch = (
  riskPrNumber?: string,
): Omit<RunPlanInput, "automaticRisk" | "run"> => ({
  eventName: "workflow_dispatch",
  isPR: false,
  isDraft: false,
  riskPrNumber,
});
const other = (
  eventName: string,
): Omit<RunPlanInput, "automaticRisk" | "run"> => ({
  eventName,
  isPR: false,
  isDraft: false,
});

type Expected = Omit<RunPlan, "reason">;
const REVIEW_THEN_RISK: Expected = {
  review: "auto",
  risk: true,
  riskManual: false,
};
const REVIEW_ONLY: Expected = {
  review: "auto",
  risk: false,
  riskManual: false,
};
const MANUAL_RISK: Expected = { review: "off", risk: true, riskManual: true };
const MANUAL_REVIEW_THEN_RISK: Expected = {
  review: "manual",
  risk: true,
  riskManual: false,
};

function plan(
  automaticRisk: boolean,
  run: RunPlanInput["run"],
  event: Omit<RunPlanInput, "automaticRisk" | "run">,
): RunPlan {
  return resolveRunPlan({ automaticRisk, run, ...event });
}

describe("resolveRunPlan with automatic_risk_assessment and run: auto", () => {
  it.each<[string, Omit<RunPlanInput, "automaticRisk" | "run">, Expected]>([
    ["opened", pr("opened"), REVIEW_THEN_RISK],
    ["reopened", pr("reopened"), REVIEW_THEN_RISK],
    ["ready_for_review", pr("ready_for_review"), REVIEW_THEN_RISK],
    ["synchronize", pr("synchronize"), REVIEW_THEN_RISK],
    [
      "pull_request_target synchronize",
      pr("synchronize", { eventName: "pull_request_target" }),
      REVIEW_THEN_RISK,
    ],
    // The review's draft gate still skips the review; begin withdraws stale approvals.
    ["draft opened", pr("opened", { isDraft: true }), REVIEW_THEN_RISK],
    [
      "draft synchronize",
      pr("synchronize", { isDraft: true }),
      REVIEW_THEN_RISK,
    ],
    ["closed", pr("closed"), REVIEW_ONLY],
    ["edited", pr("edited"), REVIEW_ONLY],
    ["draft edited", pr("edited", { isDraft: true }), REVIEW_ONLY],
    ["@droid risk on a PR", prComment("@droid risk"), MANUAL_RISK],
    [
      "@droid review on a PR",
      prComment("@droid review"),
      MANUAL_REVIEW_THEN_RISK,
    ],
    [
      "@droid review --full on a PR",
      prComment("@droid review --full"),
      MANUAL_REVIEW_THEN_RISK,
    ],
    ["bare @droid on a PR", prComment("@droid"), MANUAL_REVIEW_THEN_RISK],
    ["@droid fix on a PR", prComment("@droid fix"), REVIEW_ONLY],
    ["@droid fill on a PR", prComment("@droid fill"), REVIEW_ONLY],
    ["@droid pause on a PR", prComment("@droid pause"), REVIEW_ONLY],
    ["@droid help on a PR", prComment("@droid help"), REVIEW_ONLY],
    ["@droid security on a PR", prComment("@droid security"), REVIEW_ONLY],
    ["a question on a PR", prComment("@droid why is this here"), REVIEW_ONLY],
    [
      "@droid risk on an issue",
      prComment("@droid risk", { isPR: false }),
      REVIEW_ONLY,
    ],
    [
      "@droid review on an issue",
      prComment("@droid review", { isPR: false }),
      REVIEW_ONLY,
    ],
    [
      "@droid risk in a review thread",
      prComment("@droid risk", { eventName: "pull_request_review_comment" }),
      REVIEW_ONLY,
    ],
    ["workflow_dispatch with a PR number", dispatch("42"), MANUAL_RISK],
    ["workflow_dispatch without a PR number", dispatch(""), REVIEW_ONLY],
    ["workflow_dispatch with a blank PR number", dispatch("  "), REVIEW_ONLY],
    ["workflow_run", other("workflow_run"), REVIEW_ONLY],
    ["schedule", other("schedule"), REVIEW_ONLY],
  ])("%s", (_name, event, expected) => {
    expect(plan(true, "auto", event)).toMatchObject(expected);
  });
});

describe("resolveRunPlan with automatic_risk_assessment and an explicit run", () => {
  it.each<
    [
      RunPlanInput["run"],
      string,
      Omit<RunPlanInput, "automaticRisk" | "run">,
      Expected,
    ]
  >([
    ["review", "opened", pr("opened"), REVIEW_ONLY],
    ["review", "synchronize", pr("synchronize"), REVIEW_ONLY],
    ["review", "@droid review", prComment("@droid review"), REVIEW_ONLY],
    [
      "risk",
      "opened",
      pr("opened"),
      { review: "off", risk: true, riskManual: false },
    ],
    [
      "risk",
      "draft synchronize",
      pr("synchronize", { isDraft: true }),
      { review: "off", risk: true, riskManual: false },
    ],
    [
      "risk",
      "closed",
      pr("closed"),
      { review: "off", risk: false, riskManual: false },
    ],
    [
      "risk",
      "@droid review",
      prComment("@droid review"),
      { review: "off", risk: false, riskManual: false },
    ],
    ["both", "opened", pr("opened"), MANUAL_REVIEW_THEN_RISK],
    ["both", "synchronize", pr("synchronize"), MANUAL_REVIEW_THEN_RISK],
    ["both", "closed", pr("closed"), MANUAL_REVIEW_THEN_RISK],
    [
      "both",
      "@droid review",
      prComment("@droid review"),
      MANUAL_REVIEW_THEN_RISK,
    ],
    [
      "both",
      "schedule",
      other("schedule"),
      { review: "manual", risk: false, riskManual: false },
    ],
  ])("run: %s on %s", (run, _name, event, expected) => {
    expect(plan(true, run, event)).toMatchObject(expected);
  });
});

describe("manual requests", () => {
  const requests: Array<[string, Omit<RunPlanInput, "automaticRisk" | "run">]> =
    [
      ["@droid risk on a PR", prComment("@droid risk")],
      ["@DROID RISK. on a PR", prComment("@DROID RISK.")],
      ["workflow_dispatch with a PR number", dispatch("17")],
    ];
  const cases = requests.flatMap(([name, event]) =>
    RUN_MODES.flatMap((run) =>
      [true, false].map(
        (automaticRisk) => [name, run, automaticRisk, event] as const,
      ),
    ),
  );
  it.each(cases)(
    "%s with run: %s and automatic_risk_assessment %p is a manual risk-only run",
    (_name, run, automaticRisk, event) => {
      expect(plan(automaticRisk, run, event)).toMatchObject(MANUAL_RISK);
    },
  );
});

describe("without automatic_risk_assessment", () => {
  it.each([...RUN_MODES])(
    "run: %s reviews by today's rules and assesses nothing",
    (run) => {
      for (const event of [
        pr("opened"),
        pr("synchronize", { isDraft: true }),
        prComment("@droid review"),
        dispatch(""),
      ])
        expect(plan(false, run, event)).toMatchObject(REVIEW_ONLY);
    },
  );
});

// Every combination of the inputs the plan reads.
const EVENTS: Array<Omit<RunPlanInput, "automaticRisk" | "run">> = [];
for (const eventName of [
  "pull_request",
  "pull_request_target",
  "issue_comment",
  "pull_request_review_comment",
  "pull_request_review",
  "issues",
  "workflow_dispatch",
  "workflow_run",
  "schedule",
  "repository_dispatch",
])
  for (const eventAction of [
    undefined,
    "opened",
    "reopened",
    "ready_for_review",
    "synchronize",
    "closed",
    "edited",
    "created",
  ])
    for (const isPR of [true, false])
      for (const isDraft of [true, false])
        for (const text of [
          undefined,
          "@droid risk",
          "@droid review",
          "@droid",
          "@droid fix",
          "@droid riskx",
        ])
          for (const riskPrNumber of [undefined, "", "5"])
            EVENTS.push({
              eventName,
              eventAction,
              isPR,
              isDraft,
              command: text ? command(text) : undefined,
              riskPrNumber,
            });

describe("properties over every input combination", () => {
  it("covers the combinations", () => {
    expect(EVENTS.length).toBeGreaterThan(1000);
  });

  it("makes risk manual only for a dispatch with a PR number or an @droid risk comment on a PR", () => {
    for (const event of EVENTS)
      for (const run of RUN_MODES)
        for (const automaticRisk of [true, false]) {
          const requested =
            (event.eventName === "workflow_dispatch" && !!event.riskPrNumber) ||
            (event.eventName === "issue_comment" &&
              event.isPR &&
              event.command?.command === "risk");
          const result = plan(automaticRisk, run, event);
          expect({
            event,
            run,
            automaticRisk,
            manual: result.riskManual,
          }).toEqual({ event, run, automaticRisk, manual: requested });
          if (result.riskManual) expect(result.risk).toBe(true);
        }
  });

  it("keeps today's review-only behavior without the flag or a manual request", () => {
    for (const event of EVENTS) {
      const requested =
        (event.eventName === "workflow_dispatch" && !!event.riskPrNumber) ||
        (event.eventName === "issue_comment" &&
          event.isPR &&
          event.command?.command === "risk");
      if (requested) continue;
      for (const run of RUN_MODES)
        expect({ event, run, plan: plan(false, run, event) }).toMatchObject({
          event,
          run,
          plan: REVIEW_ONLY,
        });
    }
  });

  it("never reviews on a manual risk request", () => {
    for (const event of EVENTS)
      for (const run of RUN_MODES)
        for (const automaticRisk of [true, false]) {
          const result = plan(automaticRisk, run, event);
          if (result.riskManual) expect(result.review).toBe("off");
        }
  });

  it("gives a reason for the log", () => {
    for (const event of EVENTS.slice(0, 200))
      expect(plan(true, "auto", event).reason).not.toBe("");
  });
});

describe("parseRunMode", () => {
  it.each([
    [undefined, "auto"],
    ["", "auto"],
    ["  ", "auto"],
    ["auto", "auto"],
    ["review", "review"],
    ["Risk", "risk"],
    [" BOTH ", "both"],
  ])("reads %p as %s", (value, mode) => {
    expect(parseRunMode(value)).toBe(mode as RunPlanInput["run"]);
  });

  it.each(["risks", "true", "review,risk"])("refuses %p", (value) => {
    expect(() => parseRunMode(value)).toThrow(
      "The run input must be auto, review, risk or both",
    );
  });
});
