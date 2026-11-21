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
   * Runs the step with only the worker in the download directory.
   */
  async function review(
    script: Omit<WorkerScript, "recordPath">,
    options: {
      env?: NodeJS.ProcessEnv;
      workerBytes?: string;
    } = {},
  ): Promise<WorkerRun | undefined> {
    const recordPath = join(dir, "worker-run.json");
    const worker = standInWorker({ ...script, recordPath });
    const workerDir = join(dir, "droid-worker");
    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workerDir, "droid-review.mjs"),
      options.workerBytes ?? worker.source,
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
      { name: "droid-review.mjs", url: "", sha256: worker.sha256 },
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

  it("runs the worker's review on the checkout with the prepared input, the code judge, how the runner reaches the network, and only the Factory credential", async () => {
    // What actions/checkout leaves in the clone's config unless told not to.
    await git(
      checkoutDir,
      "config",
      "http.https://github.com/.extraheader",
      "AUTHORIZATION: basic d29ya2Zsb3c=",
    );

    const ran = await review(
      { report: answered(), exitCode: 0 },
      {
        env: {
          HTTPS_PROXY: "http://proxy.example:3128",
          NODE_EXTRA_CA_CERTS: "/runner/ca.pem",
          // How the step's shell passes a name the runner holds no value for.
          NO_PROXY: "",
        },
      },
    );

    expect(ran?.args.slice(0, 3)).toEqual(["review", "--repo", checkoutDir]);
    expect(ran?.input).toEqual({
      ...input(),
      judge: "code",
    });
    expect(ran?.env).toEqual({
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      DROID_BIN: "/frozen/droid",
      FACTORY_API_KEY: "factory-key",
      HTTPS_PROXY: "http://proxy.example:3128",
      NODE_EXTRA_CA_CERTS: "/runner/ca.pem",
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

    expect(ran?.input).toMatchObject({ judge: "security" });
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
      error_message:
        "The droid-review worker left no report (exit 2): input.settings: unrecognized_keys",
    });
  });

  it("does not start the worker when its digest differs from the pin", async () => {
    const ran = await review(
      { report: answered(), exitCode: 0 },
      { workerBytes: "// not the pinned worker\n" },
    );
    expect(ran).toBeUndefined();
    expect(outputs).toMatchObject({
      conclusion: "failure",
      error_message:
        "The downloaded droid-review.mjs does not have the bytes this version pins",
    });
  });

  it("starts no session when the prepare step left no input", async () => {
    await rm(promptsPath("review_input.json"));

    const ran = await review({ report: answered(), exitCode: 0 });

    expect(ran).toBeUndefined();
    expect(outputs).toMatchObject({
      conclusion: "failure",
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
    });
    expect(String(outputs.error_message)).not.toContain("deploy-key");
  });
});
