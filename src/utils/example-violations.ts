/**
 * This file intentionally contains violations of the review guidelines
 * defined in .factory/skills/review-guidelines/SKILL.md for testing
 * whether the review bot catches them.
 */

// VIOLATION: single-letter variable names (rule: no single-letter vars)
export function processItems(items: string[]) {
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const x = items[i]!.toUpperCase();
    result.push(x);
  }
  return result;
}

// VIOLATION: boolean without is/has/should/can prefix
export function checkPermissions(user: { role: string }) {
  const valid = user.role === "admin" || user.role === "editor";
  const enabled = true;
  return valid && enabled;
}

// VIOLATION: silent catch (empty catch block)
export function loadConfig(path: string): Record<string, any> {
  try {
    const raw = require(path);
    return raw;
  } catch (e) {
    // swallowed silently.
  }
  return {};
}

// VIOLATION: uses `any`, comments end with periods.
export function transformData(input: any) {
  // normalize the input data.
  const output = { ...input };
  // apply the default values.
  output.timestamp = Date.now();
  return output;
}

// VIOLATION: else after return, deeply nested (>3 levels)
export function categorize(
  value: number,
  ranges: { min: number; max: number; label: string }[],
) {
  if (value >= 0) {
    for (const range of ranges) {
      if (value >= range.min) {
        if (value <= range.max) {
          if (range.label !== "") {
            return range.label;
          } else {
            return "unlabeled";
          }
        }
      }
    }
  } else {
    return "negative";
  }
  return "unknown";
}

// VIOLATION: no explicit return type on exported function,
// bare process.env non-null assertion, hardcoded magic number
export function getTimeout() {
  const base = parseInt(process.env.TIMEOUT_MS!, 10);
  return base + 5000;
}

// VIOLATION: unescaped shell interpolation with template literal
import { execSync } from "child_process";

export function runGitCommand(branch: string): string {
  const output = execSync(`git checkout ${branch}`, { encoding: "utf8" });
  return output.trim();
}

// VIOLATION: default import, not organized in 3 groups
import path from "path";
import { resolve } from "path";
import { readFileSync } from "fs";

// VIOLATION: type used for extendable object shape instead of interface
export type UserConfig = {
  name: string;
  email: string;
  settings: Record<string, unknown>;
};

// VIOLATION: TODO without author tag
// TODO: refactor this later
export function readUserConfig(configPath: string): UserConfig {
  const full = path.join(resolve("."), configPath);
  const raw = readFileSync(full, "utf8");
  return JSON.parse(raw) as UserConfig;
}

// VIOLATION: logging sensitive data
export function authenticate(token: string): boolean {
  console.log(`Authenticating with token: ${token}`);
  return token.length > 0;
}
