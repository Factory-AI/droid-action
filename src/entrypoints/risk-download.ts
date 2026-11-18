#!/usr/bin/env bun

/**
 * The one step of the risk action that is given the worker token. It
 * downloads the `droid-review` worker this version names to a file only the
 * job's user can read, and exits before the judge starts, so no process
 * that runs pull request code is ever given the token. It does not check
 * the bytes: the assess step does, where it runs them. A download that
 * fails writes nothing and says why, and the assess step, finding no worker
 * it can run, is the one that reports the run as failed. So this step
 * always exits 0.
 */

import * as core from "@actions/core";
import {
  describeFailure,
  riskWorkerPath,
  writePrivateFile,
} from "../core/risk/plan";
import { RISK_WORKER } from "../core/risk/types";
import { retryWithBackoff } from "../utils/retry";

const DOWNLOAD_TIMEOUT_MS = 60_000;

class DownloadStatusError extends Error {
  constructor(readonly status: number) {
    super(`status ${status}`);
  }
}

function download(url: string, token: string): Promise<Buffer> {
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        // GitHub answers a release asset's address with the asset's bytes
        // only when asked for them this way, by redirecting to storage on
        // another host. `fetch` follows a redirect to another origin
        // without the Authorization header, so the token goes to GitHub's
        // API and no further.
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/octet-stream",
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new DownloadStatusError(response.status);
      return Buffer.from(await response.arrayBuffer());
    },
    {
      shouldRetry: (error) =>
        !(error instanceof DownloadStatusError) || error.status >= 500,
    },
  );
}

export async function run(
  env: NodeJS.ProcessEnv = process.env,
  url: string = RISK_WORKER.url,
): Promise<void> {
  try {
    const token = env.RISK_WORKER_TOKEN?.trim();
    if (!token) throw new Error("RISK_WORKER_TOKEN is empty");
    await writePrivateFile(riskWorkerPath(env), await download(url, token));
    console.log("Downloaded the PR risk worker.");
  } catch (error) {
    core.warning(
      `The PR risk worker was not downloaded with its token (${describeFailure(error)}).`,
    );
  }
}

if (import.meta.main) await run();
