import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";

interface BranchProtectionRule {
  pattern: string;
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
}

interface BranchSettings {
  requiredStatusChecks: { strict: boolean; contexts: string[] } | null;
  enforceAdmins: boolean;
  requireCodeOwnerReviews: boolean;
  dismissStaleReviews: boolean;
  requireLinearHistory: boolean;
  allowForcePushes: boolean;
  allowDeletions: boolean;
}

async function getGhToken(): Promise<string> {
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  }
}

async function getRepoInfo(octokit: Octokit, owner: string, repo: string) {
  const { data } = await octokit.repos.get({ owner, repo });
  return {
    defaultBranch: data.default_branch,
    allowSquashMerge: data.allow_squash_merge ?? true,
    allowMergeCommit: data.allow_merge_commit ?? true,
    allowRebaseMerge: data.allow_rebase_merge ?? true,
  };
}

async function setMergeSettings(
  octokit: Octokit,
  owner: string,
  repo: string,
  allowSquash: boolean,
  allowMerge: boolean,
  allowRebase: boolean,
): Promise<boolean> {
  try {
    await octokit.repos.update({
      owner,
      repo,
      allow_squash_merge: allowSquash,
      allow_merge_commit: allowMerge,
      allow_rebase_merge: allowRebase,
    });
    return true;
  } catch (e) {
    const error = e as { status?: number; message?: string };
    if (error.status === 404) {
      console.error(
        "  ERROR: 404 Not Found - likely missing admin permissions or org restrictions",
      );
      return false;
    }
    throw e;
  }
}

async function configureBranchProtection(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  settings: BranchSettings,
): Promise<boolean> {
  try {
    await octokit.repos.updateBranchProtection({
      owner,
      repo,
      branch,
      required_status_checks: settings.requiredStatusChecks,
      enforce_admins: settings.enforceAdmins,
      required_pull_request_reviews: {
        require_code_owner_reviews: settings.requireCodeOwnerReviews,
        require_last_push_approval: false,
        dismiss_stale_reviews: settings.dismissStaleReviews,
      },
      restrictions: null,
      required_linear_history: settings.requireLinearHistory,
      allow_force_pushes: settings.allowForcePushes,
      allow_deletions: settings.allowDeletions,
    });
    console.log(`  Branch protection configured for '${branch}'`);
    return true;
  } catch (e) {
    const error = e as { status?: number };
    if (error.status === 404) {
      console.log(
        `  Could not configure branch protection (no access or branch not found)`,
      );
      return false;
    }
    if (error.status === 422) {
      console.log(`  Branch protection already exists for '${branch}'`);
      return true;
    }
    throw e;
  }
}

async function main() {
  const token = await getGhToken();
  if (!token) {
    console.error(
      "Error: No GitHub token found. Set GITHUB_TOKEN, GH_TOKEN, or login with `gh auth login`",
    );
    console.error("\nTo configure via GitHub UI instead:");
    console.error("  1. Go to Settings > Branches");
    console.error("  2. Add rule for 'main' - uncheck 'Allow squash merging'");
    console.error("  3. Add rule for 'dev' - allow all merge methods");
    process.exit(1);
  }

  const octokit = new Octokit({ auth: token });

  // Detect repo from git or args
  let owner: string, repo: string;
  const repoArg = process.argv[2];

  if (repoArg?.includes("/")) {
    [owner, repo] = repoArg.split("/");
  } else {
    console.log("Detecting repo from git remote...");
    try {
      const remoteUrl = execSync("git remote get-url origin", {
        encoding: "utf8",
      }).trim();
      const match = remoteUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (match) {
        owner = match[1];
        repo = match[2];
      } else {
        throw new Error("Could not parse git remote URL");
      }
    } catch {
      console.error(
        "Could not detect repo. Specify as: bun run scripts/configure-branch-protection.ts owner/repo",
      );
      process.exit(1);
    }
  }

  console.log(`\n=== Branch Protection Configurator ===`);
  console.log(`Repository: ${owner}/${repo}`);
  console.log();

  // Show current state
  console.log("Current repo settings:");
  const current = await getRepoInfo(octokit, owner, repo);
  console.log(`  Default branch: ${current.defaultBranch}`);
  console.log(
    `  Squash merge: ${current.allowSquashMerge ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Merge commit: ${current.allowMergeCommit ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Rebase merge: ${current.allowRebaseMerge ? "enabled" : "disabled"}`,
  );
  console.log();

  // Define configuration
  const branchRules: BranchProtectionRule[] = [
    {
      pattern: "main",
      allowSquashMerge: false, // Prevent squash into main
      allowMergeCommit: true, // Allow merge commits
      allowRebaseMerge: true, // Allow rebase and merge
    },
    {
      pattern: "dev",
      allowSquashMerge: true, // Allow squash into dev (default)
      allowMergeCommit: true,
      allowRebaseMerge: true,
    },
  ];

  const defaultBranchSettings: BranchSettings = {
    requiredStatusChecks: null,
    enforceAdmins: true,
    requireCodeOwnerReviews: false,
    dismissStaleReviews: false,
    requireLinearHistory: false,
    allowForcePushes: false,
    allowDeletions: false,
  };

  console.log("Applying configuration...");

  // Apply merge settings at repo level
  console.log("\n1. Updating repo merge settings...");
  const success = await setMergeSettings(
    octokit,
    owner,
    repo,
    branchRules.some((r) => r.allowSquashMerge), // Allow if any branch allows
    branchRules.every((r) => r.allowMergeCommit), // Require all branches allow
    branchRules.every((r) => r.allowRebaseMerge), // Require all branches allow
  );

  if (!success) {
    console.log("\n⚠️  Could not update repo settings via API.");
    console.log("   This typically means:");
    console.log("   - Missing admin permissions on the repository");
    console.log("   - Organization-level restrictions on merge settings");
    console.log("   - Token doesn't have 'repo' scope for this repo");
    console.log();
    console.log("Alternative: Configure via GitHub UI:");
    console.log("  1. Go to https://github.com/${owner}/${repo}/settings");
    console.log("  2. Navigate to Settings > Branches");
    console.log("  3. Click 'Add rule' for 'main'");
    console.log("  4. Uncheck 'Allow squash merging'");
    console.log(
      "  5. Add another rule for 'dev' with all merge methods enabled",
    );
    console.log();
    console.log("Or use the gh CLI directly:");
    console.log("  gh repo edit ${owner}/${repo} --disable-squash-merge");
    console.log("  (Note: gh may also fail with 404 if org restricts this)");
    process.exit(1);
  }

  // Apply branch protection rules
  console.log("\n2. Setting up branch protection rules...");
  for (const rule of branchRules) {
    const settings: BranchSettings = {
      ...defaultBranchSettings,
      requiredStatusChecks: null,
    };
    await configureBranchProtection(
      octokit,
      owner,
      repo,
      rule.pattern,
      settings,
    );
  }

  // Show final state
  console.log("\n3. Verifying final settings...");
  const final = await getRepoInfo(octokit, owner, repo);
  console.log(
    `  Squash merge: ${final.allowSquashMerge ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Merge commit: ${final.allowMergeCommit ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Rebase merge: ${final.allowRebaseMerge ? "enabled" : "disabled"}`,
  );

  console.log("\n✓ Configuration complete!");
  console.log("\nBranch rules summary:");
  console.log("  - main: Squash DISABLED (must use merge commit or rebase)");
  console.log("  - dev: Squash ENABLED (default for PRs)");
}

main().catch((error) => {
  console.error("\nScript failed:", error);
  process.exit(1);
});
