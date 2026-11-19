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
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/entrypoints/review-run";
import {
  checkoutWithPullRequest,
  git,
  standInWorker,
  type WorkerRun,
  type WorkerScript,
} from "../core/worker/fixtures";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Stand-ins for the judges: the step hands one on and reads no field of it. */
const JUDGES = {
  code: JSON.stringify({ standIn: "code judge" }),
  security: JSON.stringify({ standIn: "security judge" }),
};

describe("review-run entrypoint", () => {
  let dir = "";
  let checkoutDir = "";
  let head = "";
  let base = "";
  let outputs: Record<string, unknown> = {};
  let warnings: string[] = [];

  const promptsPath = (name: string) =>
    join(dir, "runner", "droid-prompts", name);
  const input = () => ({ repo: "acme/app", prNumber: 7, model: "model-a" });
  const answered = (answer: unknown = { results: [] }) => ({
    status: "answered",
    revision: { base, head, mergeBase: base },
    sessions: [
      {
        id: "s1",
        model: "model-a",
        reasoningEffort: "high",
        status: "answered",
      },
      { id: "s2", model: "model-a", status: "answered" },
    ],
    answer,
  });

  /**
   * Runs the step with a stand-in worker and stand-in judges where the
   * download step leaves the real ones, and returns how the worker was run.
   */
  async function review(
    script: Omit<WorkerScript, "recordPath">,
    options: {
      env?: NodeJS.ProcessEnv;
      left?: { worker?: string; code?: string; security?: string };
    } = {},
  ): Promise<WorkerRun | undefined> {
    const recordPath = join(dir, "worker-run.json");
    const worker = standInWorker({ ...script, recordPath });
    const workerDir = join(dir, "droid-worker");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "droid-review.mjs"),
      options.left?.worker ?? worker.source,
    );
    await writeFile(
      join(workerDir, "review-judge.json"),
      options.left?.code ?? JUDGES.code,
    );
    await writeFile(
      join(workerDir, "security-review-judge.json"),
      options.left?.security ?? JUDGES.security,
    );
    await run(
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RUNNER_TEMP: join(dir, "runner"),
        GITHUB_WORKSPACE: checkoutDir,
        WORKER_DIR: workerDir,
        DROID_BIN: "/frozen/droid",
        FACTORY_API_KEY: "factory-key",
        REVIEW_HEAD_SHA: head,
        REVIEW_BASE_SHA: base,
        // What the job around the step holds, none of it the worker's.
        GITHUB_TOKEN: "app-token",
        GH_TOKEN: "read-token",
        WORKFLOW_GITHUB_TOKEN: "workflow-token",
        DEFAULT_WORKFLOW_TOKEN: "workflow-token",
        OVERRIDE_GITHUB_TOKEN: "caller-token",
        WORKER_TOKEN: "download-token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid",
        ACTIONS_RUNTIME_TOKEN: "runtime-token",
        ...options.env,
      },
      {
        worker: { name: "droid-review.mjs", url: "", sha256: worker.sha256 },
        judges: {
          code: {
            name: "review-judge.json",
            url: "",
            sha256: sha256(JUDGES.code),
          },
          security: {
            name: "security-review-judge.json",
            url: "",
            sha256: sha256(JUDGES.security),
          },
        },
      },
    );
    return (await exists(recordPath))
      ? JSON.parse(await readFile(recordPath, "utf8"))
      : undefined;
  }

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "review-run-test-")));
    const repo = await checkoutWithPullRequest(dir);
    checkoutDir = repo.checkoutDir;
    head = repo.headSha;
    base = repo.baseSha;
    await mkdir(promptsPath(""), { recursive: true });
    await writeFile(promptsPath("review_input.json"), JSON.stringify(input()));
    outputs = {};
    warnings = [];
    spyOn(core, "setOutput").mockImplementation((name, value) => {
      outputs[name] = value;
    });
    spyOn(core, "warning").mockImplementation((message) => {
      warnings.push(String(message));
    });
    spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the worker's review on the checkout with the prepared input, the code judge, and only the Factory credential", async () => {
    // What actions/checkout leaves in the clone's config unless told not to.
    await git(
      checkoutDir,
      "config",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: basic d29ya2Zsb3c=",
    );

    const ran = await review({ report: answered(), exitCode: 0 });

    expect(ran?.args.slice(0, 3)).toEqual(["review", "--repo", checkoutDir]);
    expect(ran?.input).toEqual({
      ...input(),
      judge: { standIn: "code judge" },
    });
    expect(ran?.env).toEqual({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      DROID_BIN: "/frozen/droid",
      FACTORY_API_KEY: "factory-key",
    });
    expect(ran?.repoConfig).not.toContain("extraheader");
  });

  it("leaves the answer for the publishing step, the report for the debug artifacts, and says what ran", async () => {
    const answer = { results: [{ status: "rejected" }], reviewSummary: {} };

    await review({ report: answered(answer), exitCode: 0 });

    expect(
      JSON.parse(await readFile(promptsPath("review_validated.json"), "utf8")),
    ).toEqual(answer);
    const reportPath = promptsPath("review_report.json");
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(
      answered(answer),
    );
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(outputs).toEqual({
      conclusion: "success",
      status: "answered",
      review_model: "model-a",
      review_reasoning_effort: "high",
      model_fallback_note: "",
    });
    expect(warnings).toEqual([]);
  });

  it("leaves the answer where the workflow asked for it", async () => {
    const asked = join(dir, "elsewhere", "validated.json");

    await review(
      { report: answered({ results: [] }), exitCode: 0 },
      { env: { REVIEW_VALIDATED_PATH: asked } },
    );

    expect(JSON.parse(await readFile(asked, "utf8"))).toEqual({ results: [] });
    expect(await exists(promptsPath("review_validated.json"))).toBe(false);
  });

  it("runs a security-only review with the security judge", async () => {
    const ran = await review(
      { report: answered(), exitCode: 0 },
      { env: { REVIEW_SECURITY_ONLY: "true" } },
    );

    expect(ran?.input).toMatchObject({ judge: { standIn: "security judge" } });
  });

  it("notes a review that ran on another model than the workflow named", async () => {
    const report = answered();
    report.sessions[0]!.model = "model-b";

    await review({ report, exitCode: 0 });

    expect(outputs.review_model).toBe("model-b");
    expect(outputs.model_fallback_note).toStartWith(
      "The code review ran on `model-b`, not the `model-a` the workflow asked for.",
    );
  });

  it("fails the review, publishing nothing, when a pass does not answer", async () => {
    await review({
      report: {
        status: "interrupted",
        by: "deadline",
        revision: { base, head, mergeBase: base },
        sessions: [{ id: "s1", model: "model-a", status: "interrupted" }],
      },
      exitCode: 1,
    });

    expect(outputs).toEqual({
      conclusion: "failure",
      status: "interrupted",
      error_message: "The candidates pass was stopped (`deadline`).",
      review_model: "model-a",
      review_reasoning_effort: "",
      model_fallback_note: "",
    });
    expect(await exists(promptsPath("review_validated.json"))).toBe(false);
    expect(warnings).toEqual([
      "The review did not answer: The candidates pass was stopped (`deadline`).",
    ]);
  });

  it("publishes no answer about commits other than the prepared ones", async () => {
    const report = answered();
    report.revision.head = base;

    await review({ report, exitCode: 0 });

    expect(outputs).toMatchObject({
      conclusion: "failure",
      status: "no_report",
      error_message:
        "The review worker's report is not about the prepared commits",
    });
    expect(await exists(promptsPath("review_validated.json"))).toBe(false);
  });

  it("fails the review when the worker leaves no report, quoting what the worker said", async () => {
    await review({
      exitCode: 2,
      stderr: "input.settings: unrecognized_keys\n",
    });

    expect(outputs).toMatchObject({
      conclusion: "failure",
      status: "no_report",
      error_message:
        "The droid-review worker left no report (exit 2): input.settings: unrecognized_keys",
    });
  });

  it.each([
    [
      "worker",
      { worker: "// not the pinned worker\n" },
      {},
      "The downloaded droid-review.mjs does not have the bytes this version pins",
    ],
    [
      "judge",
      { code: '{"standIn":"another judge"}' },
      {},
      "The downloaded review-judge.json does not have the bytes this version pins",
    ],
    [
      "security judge",
      { security: '{"standIn":"another judge"}' },
      { REVIEW_SECURITY_ONLY: "true" },
      "The downloaded security-review-judge.json does not have the bytes this version pins",
    ],
  ])(
    "starts no session with a %s whose bytes are not the pinned ones",
    async (_name, left, env, message) => {
      const ran = await review(
        { report: answered(), exitCode: 0 },
        { left, env },
      );

      expect(ran).toBeUndefined();
      expect(outputs).toMatchObject({
        conclusion: "failure",
        status: "no_report",
        error_message: message,
      });
    },
  );

  it("starts no session when the prepare step left no input", async () => {
    await rm(promptsPath("review_input.json"));

    const ran = await review({ report: answered(), exitCode: 0 });

    expect(ran).toBeUndefined();
    expect(outputs).toMatchObject({
      conclusion: "failure",
      status: "no_report",
      error_message:
        "The review's input from the prepare step could not be read",
    });
  });

  it("starts no session in a checkout that keeps an SSH key", async () => {
    await git(
      checkoutDir,
      "config",
      "core.sshCommand",
      "ssh -i /tmp/deploy-key",
    );

    const ran = await review({ report: answered(), exitCode: 0 });

    expect(ran).toBeUndefined();
    expect(outputs).toMatchObject({
      conclusion: "failure",
      status: "no_report",
    });
    expect(String(outputs.error_message)).not.toContain("deploy-key");
  });
});
