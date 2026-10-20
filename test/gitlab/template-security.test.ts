import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseAllDocuments } from "yaml";

const root = path.join(import.meta.dir, "..", "..");
const SCRIPT = path.join(root, "gitlab", "install-org-guidelines.sh");

function templateJob(): any {
  const [, jobs] = parseAllDocuments(
    fs.readFileSync(path.join(root, "templates/droid-review.yml"), "utf8"),
  ).map((doc) => doc.toJS());
  return jobs["droid-review"];
}

function scriptLines(job: any): string[] {
  return [...job.before_script, ...job.script, ...job.after_script]
    .flatMap((entry: string) => entry.split("\n"))
    .map((line: string) => line.trim())
    .filter((line: string) => !line.startsWith("#"));
}

describe("droid-review template", () => {
  // The job runs from the MR checkout, where a bunfig.toml preload or a .env
  // file would otherwise run with, or redirect, the job's credentials.
  it("isolates every bun invocation from the MR's bunfig.toml and .env", () => {
    const bunLines = scriptLines(templateJob()).filter((line) =>
      /(^|[\s;&|(!])bun\s/.test(line),
    );
    const runs = bunLines.filter((line) => !/\bbun install\b/.test(line));
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const line of runs) {
      expect(line).toContain(
        "bun --config=/dev/null --env-file=/dev/null run ",
      );
    }
    for (const line of bunLines.filter((l) => /\bbun install\b/.test(l))) {
      expect(line).toContain('cd "$DROID_ACTION_DIR" && bun install');
    }
  });

  it("never reads the error file with a shell cat", () => {
    const lines = scriptLines(templateJob()).join("\n");
    expect(lines).not.toMatch(/cat\s+\/tmp\/droid-error/);
    expect(lines).not.toContain("DROID_ERROR_DETAILS");
  });
});

describe("install-org-guidelines.sh", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "droid-org-guidelines-"));
    const home = path.join(dir, "home");
    const bin = path.join(dir, "bin");
    const cwd = path.join(dir, "checkout");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(cwd);
    const argsLog = path.join(dir, "curl-args");
    // Records its arguments, writes the -o file, and answers HTTP 200.
    fs.writeFileSync(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argsLog}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
echo "# Fetched guidelines" > "$out"
printf 200
`,
      { mode: 0o755 },
    );
    // Fails fast instead of touching the network.
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/git-args"\nexit 1\n`,
      { mode: 0o755 },
    );
    const run = (source: string) =>
      spawnSync("bash", [SCRIPT], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          ORG_GUIDELINES_SOURCE: source,
          CI_SERVER_HOST: "gitlab.example.com",
          CI_JOB_TOKEN: "job-token-secret-value",
        },
      });
    const skill = path.join(
      home,
      ".factory/skills/org-review-guidelines/SKILL.md",
    );
    const curlArgs = () =>
      fs.existsSync(argsLog)
        ? fs.readFileSync(argsLog, "utf8").trim().split("\n")
        : null;
    const gitArgs = () =>
      fs.existsSync(path.join(dir, "git-args"))
        ? fs.readFileSync(path.join(dir, "git-args"), "utf8").trim().split("\n")
        : null;
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    return { dir, cwd, run, skill, curlArgs, gitArgs, cleanup };
  }

  it("refuses plain-http sources without fetching", () => {
    const t = setup();
    try {
      const result = t.run("http://gitlab.example.com/guidelines.md");
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("refusing plain-http");
      expect(t.curlArgs()).toBeNull();
      expect(fs.existsSync(t.skill)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it("sends the job token only to the instance, https-only, without following redirects", () => {
    const t = setup();
    try {
      const result = t.run("https://gitlab.example.com/api/v4/raw");
      expect(result.status).toBe(0);
      const args = t.curlArgs()!;
      expect(args).toContain("JOB-TOKEN: job-token-secret-value");
      expect(args.some((a) => /^-[a-zA-Z]*L/.test(a))).toBe(false);
      expect(args).not.toContain("--location");
      expect(args.join(" ")).toContain("--proto =https");
      expect(fs.readFileSync(t.skill, "utf8")).toContain(
        "# Fetched guidelines",
      );
    } finally {
      t.cleanup();
    }
  });

  it("never sends the job token to another host", () => {
    for (const url of [
      "https://gitlab.example.com.evil.test/raw",
      "https://evil.test/gitlab.example.com/raw",
    ]) {
      const t = setup();
      try {
        t.run(url);
        const args = t.curlArgs()!;
        expect(args.join(" ")).not.toContain("job-token-secret-value");
        expect(args.join(" ")).toContain("--proto-redir =https");
      } finally {
        t.cleanup();
      }
    }
  });

  it("does not read a relative path from the MR checkout", () => {
    const t = setup();
    try {
      fs.writeFileSync(path.join(t.cwd, "guidelines.md"), "# from the MR");
      t.run("guidelines.md");
      expect(fs.existsSync(t.skill)).toBe(false);
      // Treated as a project path instead, cloned without redirects.
      expect(t.gitArgs()).toContain("http.followRedirects=false");
    } finally {
      t.cleanup();
    }
  });

  it("installs an absolute local file", () => {
    const t = setup();
    try {
      const file = path.join(t.dir, "org.md");
      fs.writeFileSync(file, "# Org rules");
      expect(t.run(file).status).toBe(0);
      expect(fs.readFileSync(t.skill, "utf8")).toContain("# Org rules");
    } finally {
      t.cleanup();
    }
  });
});
