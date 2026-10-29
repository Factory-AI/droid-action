import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeGitlabCommand } from "../../src/gitlab/operations/commands";

const modes: ("answer" | "fill" | "fix")[] = ["answer", "fill", "fix"];
const keys = [
  "PATH",
  "TMPDIR",
  "CI_REPOSITORY_URL",
  "GITLAB_TOKEN",
  "OVERRIDE_GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "FACTORY_API_KEY",
  "DROID_COMMAND_SAFE_SENTINEL",
  "DROID_COMMAND_ENV_PROBE",
];

const fakeCli = [
  "#!/bin/sh",
  "set -eu",
  'url_absent=false; [ "${CI_REPOSITORY_URL+x}" != x ] && url_absent=true',
  'gitlab_absent=false; [ "${GITLAB_TOKEN+x}" != x ] && gitlab_absent=true',
  'override_absent=false; [ "${OVERRIDE_GITLAB_TOKEN+x}" != x ] && override_absent=true',
  'job_absent=false; [ "${CI_JOB_TOKEN+x}" != x ] && job_absent=true',
  'factory_preserved=false; [ "${FACTORY_API_KEY-}" = "factory-auth-sentinel" ] && factory_preserved=true',
  'benign_preserved=false; [ "${DROID_COMMAND_SAFE_SENTINEL-}" = "benign-sentinel" ] && benign_preserved=true',
  `printf '{"urlAbsent":%s,"gitlabAbsent":%s,"overrideAbsent":%s,"jobAbsent":%s,"factoryPreserved":%s,"benignPreserved":%s}\\n' "$url_absent" "$gitlab_absent" "$override_absent" "$job_absent" "$factory_preserved" "$benign_preserved" > "$DROID_COMMAND_ENV_PROBE"`,
  "prompt=",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -f) prompt="$2"; shift 2 ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  '[ -n "$prompt" ]',
  `printf '%s' "safe command output" > "\${prompt%/*}/result.txt"`,
  "",
].join("\n");

describe("GitLab command model-child environment", () => {
  for (const mode of modes)
    it(`withholds publishing credentials but preserves model auth for ${mode}`, async () => {
      const saved = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      );
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "droid-command-env-"),
      );
      try {
        const bin = path.join(directory, "bin");
        const receipt = path.join(directory, "receipt.json");
        await fs.mkdir(bin);
        await fs.writeFile(path.join(bin, "droid"), fakeCli, { mode: 0o755 });
        const parent = {
          PATH: `${bin}${path.delimiter}${saved.PATH ?? ""}`,
          TMPDIR: directory,
          CI_REPOSITORY_URL:
            "https://gitlab-ci-token:job-url-sentinel@gitlab.invalid/group/repo.git",
          GITLAB_TOKEN: "gitlab-token-sentinel",
          OVERRIDE_GITLAB_TOKEN: "override-token-sentinel",
          CI_JOB_TOKEN: "job-token-sentinel",
          FACTORY_API_KEY: "factory-auth-sentinel",
          DROID_COMMAND_SAFE_SENTINEL: "benign-sentinel",
          DROID_COMMAND_ENV_PROBE: receipt,
        };
        Object.assign(process.env, parent);
        expect(
          await executeGitlabCommand("Use only the output file.", mode),
        ).toBe("safe command output");
        expect(JSON.parse(await fs.readFile(receipt, "utf8"))).toEqual({
          urlAbsent: true,
          gitlabAbsent: true,
          overrideAbsent: true,
          jobAbsent: true,
          factoryPreserved: true,
          benignPreserved: true,
        });
        for (const [key, value] of Object.entries(parent))
          expect(process.env[key] === value).toBe(true);
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
});
