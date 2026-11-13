import { z } from "zod";
import {
  postRiskApi,
  RISK_PUBLISH_ENDPOINT,
  type RiskApi,
  type RiskRunIdentity,
} from "./api";
import type { RiskJudgeAttempt } from "./judge";

/**
 * The backend reads the pull request, pages its comments and reviews, and
 * writes up to five times before it answers.
 */
const PUBLISH_TIMEOUT_MS = 90_000;

/**
 * A judge's answer as this client received it. Nothing is decided here: the
 * backend validates the verdict against the judge it resolves itself and
 * applies the thresholds this client never sees.
 */
export type RiskRawAssessment = {
  headSha: string;
  baseSha: string;
  snapshotHash: string;
  assessedAt: string;
  assignment: {
    experiment: string;
    group: string;
    ruleId: string;
    judgeConfig: string;
  };
  skillSha256: string;
  unlistedFiles: number;
  attempts: RiskJudgeAttempt[];
  durationMs: number;
  verdict: Record<string, unknown>;
};

export type RiskPublishRequest = {
  repo: string;
  pr: number;
  expectedHeadSha: string;
  run: RiskRunIdentity;
  rawAssessment?: RiskRawAssessment;
};

const responseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale_head"), headSha: z.string() }),
  z.object({
    status: z.literal("published"),
    publication: z.object({
      comment: z.object({ action: z.string(), id: z.number() }),
      approval: z.object({ action: z.string() }).optional(),
    }),
    outcome: z.string().optional(),
    reason: z.string().optional(),
  }),
]);

export type RiskPublishResponse = z.infer<typeof responseSchema>;

/**
 * Hands one head to the backend, which owns every GitHub write. Without a
 * raw assessment the backend publishes "unavailable" for the head and
 * withdraws any standing approval.
 */
export async function publishRiskAssessment(
  request: RiskPublishRequest,
  api: RiskApi,
): Promise<RiskPublishResponse> {
  return responseSchema.parse(
    await postRiskApi(api, RISK_PUBLISH_ENDPOINT, request, PUBLISH_TIMEOUT_MS),
  );
}
