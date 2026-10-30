import * as core from "@actions/core";

export function exportRuntimeVariable(name: string, value: string): void {
  process.env[name] = value;
  // Restricted preparers need local values, not job-environment authority.
  // Without a runner file, core falls back to the forbidden set-env command.
  if (process.env.GITHUB_ENV) {
    core.exportVariable(name, value);
  }
}
