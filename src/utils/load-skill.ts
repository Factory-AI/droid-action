import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { resolve, join } from "path";

const MONO_REPO = "Factory-AI/factory-mono";
const MONO_BRANCH = "feat/review-builtin-skill";

const SHARED_BEGIN = "<!-- BEGIN_SHARED_METHODOLOGY -->";
const SHARED_END = "<!-- END_SHARED_METHODOLOGY -->";

/**
 * Format skill content for inclusion in a CI prompt.
 * Extracts only the shared methodology (between markers) so CI-specific
 * instructions in the template remain authoritative for execution behavior.
 */
export function formatSkillSection(skillContent: string | undefined): string {
  if (!skillContent) return "";
  const methodology = extractSharedMethodology(skillContent);
  return `
<code_review_methodology>
${methodology}
</code_review_methodology>
`;
}

/**
 * Extract the shared methodology section from a skill's content.
 * Looks for BEGIN_SHARED_METHODOLOGY / END_SHARED_METHODOLOGY markers.
 * Returns the full content if markers are not found.
 */
export function extractSharedMethodology(content: string): string {
  const beginIdx = content.indexOf(SHARED_BEGIN);
  const endIdx = content.indexOf(SHARED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return content;
  }
  return content.slice(beginIdx + SHARED_BEGIN.length, endIdx).trim();
}

/**
 * Load a skill from the local core plugin cache.
 * The Droid CLI installs the core plugin to:
 *   ~/.factory/plugins/cache/factory-plugins/core/<hash>/skills/<name>/SKILL.md
 */
async function loadSkillFromCache(
  skillName: string,
): Promise<string | undefined> {
  const home = process.env.HOME || homedir();
  const cacheDir = resolve(home, ".factory/plugins/cache/factory-plugins/core");

  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return undefined;
  }

  for (const hash of entries) {
    const skillPath = join(cacheDir, hash, "skills", skillName, "SKILL.md");
    try {
      const content = await readFile(skillPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) continue;
      console.log(
        `Loaded skill ${skillName} from ${skillPath} (${trimmed.length} bytes)`,
      );
      return trimmed;
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Fetch a skill from the factory-mono GitHub repo via the API.
 * Uses GITHUB_TOKEN for authentication (required for private repos).
 * Used as fallback when the local plugin cache is not available (e.g. CI).
 */
async function loadSkillFromGitHub(
  skillName: string,
): Promise<string | undefined> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const url = `https://api.github.com/repos/${MONO_REPO}/contents/apps/cli/builtin-skills/${skillName}/SKILL.md?ref=${MONO_BRANCH}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.raw",
    "User-Agent": "droid-action",
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return undefined;
    const content = await response.text();
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    console.log(
      `Loaded skill ${skillName} from GitHub (${trimmed.length} bytes)`,
    );
    return trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Load a skill by name. Tries the local plugin cache first,
 * then falls back to fetching from the factory-mono GitHub repo.
 * Throws if the skill cannot be loaded from either source.
 */
export async function loadSkill(skillName: string): Promise<string> {
  const cached = await loadSkillFromCache(skillName);
  if (cached) return cached;

  const remote = await loadSkillFromGitHub(skillName);
  if (remote) return remote;

  throw new Error(
    `Required skill "${skillName}" not found in local plugin cache or on GitHub (${MONO_REPO}).`,
  );
}
