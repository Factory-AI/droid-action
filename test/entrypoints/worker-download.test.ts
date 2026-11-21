import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as download } from "../../src/entrypoints/worker-download";
import { serveRelease } from "../core/worker/fixtures";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("worker-download", () => {
  const files = {
    "droid-review.mjs": "console.log('a stand-in for the worker');\n",
  };
  let dir = "";
  let workerDir = "";
  let served: ReturnType<typeof serveRelease>;
  let logged: string[] = [];

  const run = (env: NodeJS.ProcessEnv) =>
    download(
      { WORKER_DIR: workerDir, ...env },
      {
        name: "droid-review.mjs",
        url: served.urlOf("droid-review.mjs"),
        sha256: "",
      },
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-worker-download-test-"));
    workerDir = join(dir, "droid-worker");
    served = serveRelease(files);
    logged = [];
    const keep = (...parts: unknown[]) => {
      logged.push(parts.join(" "));
    };
    spyOn(core, "warning").mockImplementation(keep);
    spyOn(console, "log").mockImplementation(keep);
    spyOn(console, "error").mockImplementation(keep);
  });

  afterEach(async () => {
    mock.restore();
    await served.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves the worker in a file only the job's user can read, and sends the token no further than the address that asks for it", async () => {
    await run({ WORKER_TOKEN: served.token });

    expect(served.requested).toEqual(["droid-review.mjs"]);
    const path = join(workerDir, "droid-review.mjs");
    expect(await readFile(path, "utf8")).toBe(files["droid-review.mjs"]);
    expect((await stat(path)).mode % 0o1000).toBe(0o600);
    expect((await stat(workerDir)).mode % 0o1000).toBe(0o700);
    // GitHub's API redirects the download to storage on another host.
    expect(served.forwarded).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(served.token);
  });

  it.each([
    ["it has no token", " ", "(WORKER_TOKEN is empty)"],
    [
      "its token cannot read the release",
      "a-token-that-cannot-read-it",
      "(status 404)",
    ],
  ])(
    "leaves nothing when %s, and says why without quoting a token",
    async (_refused, token, why) => {
      // Resolves: a failed download is reported by the step that finds no file.
      await run({ WORKER_TOKEN: token });

      expect(await exists(workerDir)).toBe(false);
      expect(core.warning).toHaveBeenCalledTimes(1);
      expect(core.warning).toHaveBeenCalledWith(
        `droid-review.mjs was not downloaded with the worker token ${why}.`,
      );
      expect(logged.join("\n")).not.toContain("token-that");
    },
  );
});
