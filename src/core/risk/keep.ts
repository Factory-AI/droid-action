import { gitOutput } from "./evidence";
import { describeFailure } from "./plan";
import {
  RISK_BEGIN_MAX_BODY_BYTES,
  type RiskBeginRequest,
  type RiskKeepOffer,
} from "./types";

/**
 * The changes between the head Factory approved and the live head, exactly
 * as git prints them. Factory checks every hunk against the line counts in
 * its header, so the output is not trimmed. Only the two commits' trees are
 * needed: a shallow checkout fetches them one commit deep, and a full one is
 * left full. Output past what a begin request can carry fails the command
 * instead of being buffered.
 */
async function diffSinceScoredHead(
  offer: RiskKeepOffer,
  repo: { cwd: string; githubToken?: string },
): Promise<string> {
  const shallow =
    (await gitOutput(["rev-parse", "--is-shallow-repository"], repo)).trim() ===
    "true";
  await gitOutput(
    [
      "fetch",
      "--no-tags",
      ...(shallow ? ["--depth=1"] : []),
      "origin",
      offer.scoredHeadSha,
      offer.headSha,
    ],
    repo,
  );
  return gitOutput(
    [
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      offer.scoredHeadSha,
      offer.headSha,
    ],
    repo,
    RISK_BEGIN_MAX_BODY_BYTES,
  );
}

/**
 * The begin request that answers Factory's offer to keep a verdict:
 * `request` with what changed since the head Factory approved. When the
 * checkout cannot say what changed, or the answer would be larger than
 * Factory reads, this is `request` as given, which Factory judges in full.
 */
export async function answerKeepOffer(
  request: RiskBeginRequest,
  offer: RiskKeepOffer,
  checkout: { repoDir?: string; githubToken?: string },
): Promise<RiskBeginRequest> {
  const { headSha, scoredHeadSha } = offer;
  if (!checkout.repoDir) {
    console.log(
      "This job has no checkout to compare the two heads in, so the pull request is assessed in full.",
    );
    return request;
  }
  let diff: string;
  try {
    diff = await diffSinceScoredHead(offer, {
      cwd: checkout.repoDir,
      githubToken: checkout.githubToken,
    });
  } catch (error) {
    console.log(
      `Could not read what changed since ${scoredHeadSha}, so the pull request is assessed in full: ${describeFailure(error)}`,
    );
    return request;
  }
  const answer: RiskBeginRequest = {
    ...request,
    keep: { changes: { headSha, scoredHeadSha, diff } },
  };
  if (Buffer.byteLength(JSON.stringify(answer)) > RISK_BEGIN_MAX_BODY_BYTES) {
    console.log(
      `The changes since ${scoredHeadSha} are too large to keep a verdict across, so the pull request is assessed in full.`,
    );
    return request;
  }
  return answer;
}
