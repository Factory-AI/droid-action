import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droidRiskCall } from "../../../src/core/risk/droid-risk";

let dir = "";

/** A stand-in for the Droid CLI that records how it was run and answers `answer`. */
async function fakeDroid(answer: string, exit = 0): Promise<string> {
  const path = join(dir, "droid");
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/argv"
env > "${dir}/env"
pwd > "${dir}/cwd"
cat > "${dir}/stdin"
printf '%s\\n' '${answer}'
exit ${exit}
`,
  );
  await chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "droid-risk-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("droidRiskCall", () => {
  it("runs `droid risk <step>` with the request on stdin and returns its answer", async () => {
    const droidBinary = await fakeDroid(
      '{"status":200,"body":{"action":"skip"}}',
    );
    const call = droidRiskCall({
      droidBinary,
      apiKey: "factory-key",
      env: {
        HOME: "/home/runner",
        GITHUB_TOKEN: "workflow-token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request",
        FACTORY_API_BASE_URL: "https://dev.api.factory.ai",
      },
    });

    const answer = await call("begin", {
      request: { repo: "acme/app" },
      oidcToken: "oidc-jwt",
    });

    expect(answer).toEqual({ status: 200, body: { action: "skip" } });
    expect((await readFile(join(dir, "argv"), "utf8")).split("\n")).toEqual([
      "risk",
      "begin",
      "",
    ]);
    expect(JSON.parse(await readFile(join(dir, "stdin"), "utf8"))).toEqual({
      request: { repo: "acme/app" },
      oidcToken: "oidc-jwt",
    });
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain("FACTORY_API_KEY=factory-key");
    expect(env).toContain("HOME=/home/runner");
    expect(env).toContain("FACTORY_API_BASE_URL=https://dev.api.factory.ai");
    expect(env).not.toContain("workflow-token");
    expect(env).not.toContain("oidc-request");
    expect((await readFile(join(dir, "cwd"), "utf8")).trim()).not.toBe(
      process.cwd(),
    );
  });

  it("returns the CLI's error answer", async () => {
    const droidBinary = await fakeDroid(
      '{"error":"untrusted_api_url","message":"Refusing"}',
      1,
    );

    await expect(
      droidRiskCall({ droidBinary, apiKey: "k" })("settle", { request: {} }),
    ).resolves.toEqual({ error: "untrusted_api_url", message: "Refusing" });
  });

  it("names a CLI that does not know the command", async () => {
    const droidBinary = await fakeDroid("error: unknown command 'risk'", 1);

    await expect(
      droidRiskCall({ droidBinary, apiKey: "k" })("begin", { request: {} }),
    ).rejects.toMatchObject({ reason: "droid_risk_unavailable" });
  });

  it("names a CLI that is not there", async () => {
    await expect(
      droidRiskCall({ droidBinary: join(dir, "missing"), apiKey: "k" })(
        "begin",
        { request: {} },
      ),
    ).rejects.toMatchObject({ reason: "droid_unavailable" });
  });
  it("reads a CLI it stopped at the deadline as a request that got no answer, even when the CLI exits 143 itself", async () => {
    const path = join(dir, "droid");
    await writeFile(
      path,
      `#!/bin/sh
trap 'exit 143' TERM
cat > /dev/null
while :; do sleep 0.05; done
`,
    );
    await chmod(path, 0o755);

    await expect(
      droidRiskCall({ droidBinary: path, apiKey: "k", timeoutMs: 200 })(
        "begin",
        { request: {} },
      ),
    ).resolves.toEqual({ error: "request_failed" });
  });

  it("returns a begin answer larger than 1 MiB whole", async () => {
    const instructions = "x".repeat(1536 * 1024);
    const answerPath = join(dir, "answer.json");
    await writeFile(
      answerPath,
      JSON.stringify({ status: 200, body: { action: "judge", instructions } }),
    );
    const path = join(dir, "droid");
    await writeFile(
      path,
      `#!/bin/sh
cat > /dev/null
cat "${answerPath}"
`,
    );
    await chmod(path, 0o755);

    const answer = await droidRiskCall({ droidBinary: path, apiKey: "k" })(
      "begin",
      { request: {} },
    );

    expect(answer).toEqual({
      status: 200,
      body: { action: "judge", instructions },
    });
  });

  it("reports an answer past the output bound instead of reading the CLI as outdated", async () => {
    const path = join(dir, "droid");
    await writeFile(
      path,
      `#!/bin/sh
cat > /dev/null
head -c 17000000 /dev/zero
`,
    );
    await chmod(path, 0o755);

    await expect(
      droidRiskCall({ droidBinary: path, apiKey: "k" })("begin", {
        request: {},
      }),
    ).rejects.toMatchObject({ reason: "droid_risk_output_too_large" });
  });
});
