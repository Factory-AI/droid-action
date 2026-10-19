import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { BITBUCKET_TRACKING_MARKER } from "../../src/bitbucket/operations/tracking-comment";
import {
  APP_TS_DIFF,
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "./fake-server";

/**
 * Runs bitbucket/droid-review.sh for real, with a stub `droid` on PATH that
 * plays both passes by writing fixture JSON, against a local fake of the
 * Bitbucket Cloud API.
 */

const ROOT = path.resolve(import.meta.dir, "../..");
const REPO = "/2.0/repositories/acme/web-app";

const FAKE_DROID = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "droid 0.0.0-test"; exit 0; fi
for a in "$@"; do [ "$a" = "--list-tools" ] && exit 0; done
{ printf '%s\\0' "$@"; printf '\\n'; } >> "$FAKE_DIR/argv"
if [ -n "\${DROID_BITBUCKET_TOKEN:-}" ]; then echo leaked > "$FAKE_DIR/leak"; fi
prompt=""
while [ $# -gt 0 ]; do [ "$1" = "-f" ] && prompt="$2"; shift; done
dir="$(dirname "$prompt")"
if grep -q "Phase 2 (validator)" "$prompt"; then
  [ "\${FAKE_FAIL_PASS:-}" = "2" ] && { echo "model error" >&2; exit 1; }
  cp "$FAKE_DIR/validated.json" "$dir/review_validated.json"
  echo '{"type":"completion","session_id":"sess-2","numTurns":2,"durationMs":1000}'
else
  [ "\${FAKE_FAIL_PASS:-}" = "1" ] && { echo "model error" >&2; exit 1; }
  echo '{"comments":[{"path":"src/app.ts","line":3,"body":"x"}]}' > "$dir/review_candidates.json"
  echo '{"type":"completion","session_id":"sess-1","numTurns":5,"durationMs":3000}'
fi
`;

let tmp: string;
let server: FakeServer;
let comments: Array<{ id: number; body: string }>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "droid-bb-sh-"));
  await fs.mkdir(path.join(tmp, "bin"));
  await fs.mkdir(path.join(tmp, "home"));
  await fs.mkdir(path.join(tmp, "work"));
  await fs.writeFile(path.join(tmp, "bin", "droid"), FAKE_DROID, {
    mode: 0o755,
  });
  await fs.writeFile(
    path.join(tmp, "validated.json"),
    JSON.stringify({
      version: 1,
      results: [
        {
          status: "approved",
          comment: {
            path: "src/app.ts",
            line: 3,
            side: "RIGHT",
            body: "[P1] c is unused",
          },
        },
      ],
      reviewSummary: { body: "One issue." },
    }),
  );
  comments = [];
  let nextId = 1;
  server = startFakeServer((req, url) => {
    const p = url.pathname;
    if (p === `${REPO}/pullrequests/42`) {
      return json({
        id: 42,
        title: "Add c",
        description: "",
        state: "OPEN",
        draft: false,
        source: {
          branch: { name: "feature/c" },
          commit: { hash: "abcdef123456" },
        },
        destination: {
          branch: { name: "main" },
          commit: { hash: "0123456789ab" },
        },
      });
    }
    if (p === `${REPO}/pullrequests/42/diff`) return new Response(APP_TS_DIFF);
    if (p === `${REPO}/pullrequests/42/comments`) {
      if (req.method === "GET")
        return json({
          values: comments.map((c) => ({ id: c.id, content: { raw: c.body } })),
        });
      const c = { id: nextId++, body: req.body.content.raw };
      comments.push(c);
      return json({ id: c.id, content: { raw: c.body } }, 201);
    }
    const edit = /\/comments\/(\d+)$/.exec(p);
    if (edit && req.method === "PUT") {
      const c = comments.find((x) => x.id === Number(edit[1]))!;
      c.body = req.body.content.raw;
      return json({ id: c.id, content: { raw: c.body } });
    }
    return notFound();
  });
});

afterEach(async () => {
  server.stop();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function runScript(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${path.join(tmp, "bin")}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: path.join(tmp, "home"),
    FAKE_DIR: tmp,
    DROID_WORK_DIR: path.join(tmp, "work"),
    DROID_PROMPT_FILE: path.join(tmp, "prompts", "droid-prompt.txt"),
    DROID_ERROR_FILE: path.join(tmp, "droid-error.txt"),
    BITBUCKET_WORKSPACE: "acme",
    BITBUCKET_REPO_SLUG: "web-app",
    BITBUCKET_PR_ID: "42",
    BITBUCKET_COMMIT: "abcdef123456" + "0".repeat(28),
    BITBUCKET_API_URL: `${server.url}/2.0`,
    FACTORY_API_BASE_URL: server.url,
    FACTORY_API_KEY: "fk-test",
    DROID_BITBUCKET_TOKEN: "bb-secret",
    ...extra,
  };
  const proc = Bun.spawn(
    ["bash", path.join(ROOT, "bitbucket/droid-review.sh")],
    {
      env,
      cwd: path.join(tmp, "work"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: stdout + stderr };
}

async function argvCalls(): Promise<string[][]> {
  const raw = await fs.readFile(path.join(tmp, "argv"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0").filter(Boolean));
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("bitbucket/droid-review.sh", () => {
  it("runs both passes without credentials and posts the review", async () => {
    const { code, output } = await runScript();
    expect(code).toBe(0);
    expect(output).not.toContain("bb-secret");

    const calls = await argvCalls();
    expect(calls).toHaveLength(2);
    const [pass1, pass2] = calls;
    const tools = (argv: string[]) => argv[argv.indexOf("--enabled-tools") + 1];
    expect(tools(pass1!)).toBe(
      "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Task,Skill,FetchUrl",
    );
    expect(tools(pass2!)).toBe(
      "Read,Grep,Glob,LS,Execute,Edit,Create,ApplyPatch,Skill",
    );
    expect(pass1![pass1!.indexOf("--model") + 1]).toBe(
      "openai-latest-balanced",
    );
    expect(JSON.parse(pass1![pass1!.indexOf("--tag") + 1]!)).toMatchObject({
      name: "code-review",
      metadata: {
        pass: "candidates",
        platform: "bitbucket",
        repo: "acme/web-app",
        pr: "42",
      },
    });
    expect(JSON.parse(pass2![pass2!.indexOf("--tag") + 1]!).metadata.pass).toBe(
      "validator",
    );
    expect(await exists(path.join(tmp, "leak"))).toBe(false);

    expect(comments).toHaveLength(2);
    expect(comments[1]!.body).toBe("[P1] c is unused");
    const tracking = comments[0]!.body;
    expect(tracking).toContain(BITBUCKET_TRACKING_MARKER);
    expect(tracking).toContain("Droid finished reviewing this pull request");
    expect(tracking).toContain("One issue.");
    expect(tracking).toContain("_7 turns");
    expect(
      await exists(
        path.join(tmp, "work/.droid-debug/prompts/review_validated.json"),
      ),
    ).toBe(true);
  }, 60_000);

  it("reports a failed pass in the tracking comment and exits non-zero", async () => {
    const { code } = await runScript({ FAKE_FAIL_PASS: "1" });
    expect(code).not.toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Droid encountered an error");
    expect(comments[0]!.body).toContain(
      "droid exec pass 1 (candidates) failed",
    );
  }, 60_000);

  it("exits cleanly without touching Bitbucket outside a pull request", async () => {
    const { code, output } = await runScript({ BITBUCKET_PR_ID: "" });
    expect(code).toBe(0);
    expect(output).toContain(
      "Not a pull request build; skipping Droid review.",
    );
    expect(
      server.requests.filter((r) => r.path.startsWith("/2.0")),
    ).toHaveLength(0);
    expect(await exists(path.join(tmp, "argv"))).toBe(false);
  }, 60_000);

  it("fails with the credential guidance when no token is configured", async () => {
    const { code, output } = await runScript({ DROID_BITBUCKET_TOKEN: "" });
    expect(code).not.toBe(0);
    expect(output).toContain("Missing Bitbucket credentials.");
  }, 60_000);
});
