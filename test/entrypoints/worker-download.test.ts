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
    "review-judge.json": '{"a stand-in":"for the code judge"}\n',
    "security-review-judge.json": '{"a stand-in":"for the security judge"}\n',
  };
  let dir = "";
  let workerDir = "";
  let served: ReturnType<typeof serveRelease>;
  let logged: string[] = [];

  const pin = (name: keyof typeof files) => ({
    name,
    url: served.urlOf(name),
    sha256: "",
  });
  const run = (env: NodeJS.ProcessEnv) =>
    download(
      { WORKER_DIR: workerDir, ...env },
      {
        worker: pin("droid-review.mjs"),
        judges: {
          code: pin("review-judge.json"),
          security: pin("security-review-judge.json"),
        },
      },
    );
  const left = (name: keyof typeof files) => join(workerDir, name);

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

    const path = left("droid-review.mjs");
    expect(await readFile(path, "utf8")).toBe(files["droid-review.mjs"]);
    expect((await stat(path)).mode % 0o1000).toBe(0o600);
    expect((await stat(workerDir)).mode % 0o1000).toBe(0o700);
    // A job that runs no review is given no judge.
    expect(await exists(left("review-judge.json"))).toBe(false);
    expect(await exists(left("security-review-judge.json"))).toBe(false);
    // GitHub's API redirects the download to storage on another host.
    expect(served.forwarded).toEqual([]);
    expect(core.warning).not.toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(served.token);
  });

  it.each([
    ["code", "review-judge.json", "security-review-judge.json"],
    ["security", "security-review-judge.json", "review-judge.json"],
  ] as const)(
    "leaves the %s judge beside the worker for a review of that kind, and not the other",
    async (kind, wanted, other) => {
      await run({ WORKER_TOKEN: served.token, REVIEW_JUDGE: kind });

      expect(await readFile(left(wanted), "utf8")).toBe(files[wanted]);
      expect((await stat(left(wanted))).mode % 0o1000).toBe(0o600);
      expect(await exists(left("droid-review.mjs"))).toBe(true);
      expect(await exists(left(other))).toBe(false);
    },
  );

  it.each([
    ["it has no token", " ", "(WORKER_TOKEN is empty)"],
    [
      "its token cannot read the release",
      "a-token-that-cannot-read-it",
      "(status 404)",
    ],
  ])(
    "leaves nothing when %s, and says why for each file without quoting a token",
    async (_refused, token, why) => {
      // Resolves: a failed download is reported by the step that finds no file.
      await run({ WORKER_TOKEN: token, REVIEW_JUDGE: "code" });

      expect(await exists(workerDir)).toBe(false);
      expect(core.warning).toHaveBeenCalledTimes(2);
      expect(core.warning).toHaveBeenCalledWith(
        `droid-review.mjs was not downloaded with the worker token ${why}.`,
      );
      expect(core.warning).toHaveBeenCalledWith(
        `review-judge.json was not downloaded with the worker token ${why}.`,
      );
      expect(logged.join("\n")).not.toContain("token-that");
    },
  );
});
