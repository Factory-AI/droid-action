#!/usr/bin/env bun

/**
 * The one step of a review that starts a model session. It reads the input
 * the prepare step left, takes the credentials a checkout persisted out of
 * the job's checkout, and runs `droid-review review` there with the judge
 * the download step left, when the worker's bytes and the judge's are the
 * ones this version pins. It is given no GitHub token and no download token:
 * both passes run pull request code beneath it. An answer about the prepared
 * commits is left where the publishing step reads it. Every other ending is
 * a failed review with a sentence saying why. It always exits 0, so the
 * steps after it read its outputs.
 */

import * as core from "@actions/core";
import { readFile } from "node:fs/promises";
import {
  ReviewReportSchema,
  modelFallbackNote,
  reviewInputPath,
  reviewOutcome,
  reviewReportPath,
  reviewWorkerBounds,
  validatedReviewPath,
  type ReviewOutcome,
  type ReviewWorkerInput,
} from "../core/review/worker";
import { removeCheckoutCredentials } from "../core/worker/checkout";
import { REVIEW_JUDGES, WORKER, type Pin } from "../core/worker/pins";
import { readDownloaded, runWorker } from "../core/worker/run";
import {
  StepError,
  ambientEnvironment,
  describeFailure,
  requiredEnv,
  writePrivateJson,
} from "../core/worker/step";

async function review(
  env: NodeJS.ProcessEnv,
  pins: { worker: Pin; judges: Record<"code" | "security", Pin> },
): Promise<ReviewOutcome & { note?: string }> {
  const securityOnly = env.REVIEW_SECURITY_ONLY === "true";
  const input: ReviewWorkerInput = await readFile(
    reviewInputPath(env),
    "utf8",
  ).then(JSON.parse, () => {
    throw new StepError(
      "review_input_unreadable",
      "The review's input from the prepare step could not be read",
    );
  });
  const worker = await readDownloaded(pins.worker, env);
  // Parsed to be handed on whole. Nothing here reads a field of the judge.
  const judge: unknown = JSON.parse(
    (
      await readDownloaded(pins.judges[securityOnly ? "security" : "code"], env)
    ).toString("utf8"),
  );
  const repoDir = requiredEnv("GITHUB_WORKSPACE", env);
  await removeCheckoutCredentials(repoDir);
  const report = await runWorker({
    product: "review",
    worker,
    repoDir,
    input: { ...input, judge },
    // The worker's whole environment. Its passes run pull request code, so
    // of the job's credentials they get the Factory one and no other.
    env: {
      ...ambientEnvironment(env),
      DROID_BIN: requiredEnv("DROID_BIN", env),
      FACTORY_API_KEY: requiredEnv("FACTORY_API_KEY", env),
    },
    bounds: reviewWorkerBounds(),
    report: ReviewReportSchema,
    keepReportAt: reviewReportPath(env),
  });
  const outcome = reviewOutcome(report, {
    head: requiredEnv("REVIEW_HEAD_SHA", env),
    base: requiredEnv("REVIEW_BASE_SHA", env),
  });
  return {
    ...outcome,
    note: modelFallbackNote({
      asked: input.model,
      ran: outcome.model,
      securityOnly,
    }),
  };
}

export async function run(
  env: NodeJS.ProcessEnv = process.env,
  pins: { worker: Pin; judges: Record<"code" | "security", Pin> } = {
    worker: WORKER,
    judges: REVIEW_JUDGES,
  },
): Promise<void> {
  let ending: ReviewOutcome & { note?: string };
  try {
    ending = await review(env, pins);
  } catch (error) {
    ending = { error: describeFailure(error) };
  }
  if ("answer" in ending) {
    await writePrivateJson(validatedReviewPath(env), ending.answer);
    console.log("The review answered.");
  } else {
    core.warning(`The review did not answer: ${ending.error}`);
    core.setOutput("error_message", ending.error);
  }
  core.setOutput("conclusion", "answer" in ending ? "success" : "failure");
  // What ran, which is what the summary names.
  core.setOutput("review_model", ending.model ?? "");
  core.setOutput("review_reasoning_effort", ending.reasoningEffort ?? "");
  core.setOutput("model_fallback_note", ending.note ?? "");
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(`Review failed: ${describeFailure(error)}`);
    process.exit(1);
  });
}
