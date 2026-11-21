#!/usr/bin/env bun

/**
 * The one step that is given the worker token. It downloads the pinned
 * `droid-review` bundle to a file only the job's user can read, and exits
 * before any session starts, so no process that runs pull request code is
 * ever given the token. It does not check the bytes: the step that uses a
 * file does, where it uses it. A download that fails writes nothing and
 * says why, and the step that finds no file it can use is the one that
 * reports the run as failed. So this step always exits 0.
 */

import * as core from "@actions/core";
import { WORKER } from "../core/worker/pins";
import { downloadedPath } from "../core/worker/run";
import { describeFailure, writePrivateFile } from "../core/worker/step";
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
  pin = WORKER,
): Promise<void> {
  try {
    const token = env.WORKER_TOKEN?.trim();
    if (!token) throw new Error("WORKER_TOKEN is empty");
    await writePrivateFile(
      downloadedPath(pin, env),
      await download(pin.url, token),
    );
    console.log(`Downloaded ${pin.name}.`);
  } catch (error) {
    core.warning(
      `${pin.name} was not downloaded with the worker token (${describeFailure(error)}).`,
    );
  }
}

if (import.meta.main) await run();
