import type { GitHubContext } from "../github/context";
import type { Octokits } from "../github/api/client";

export type PrepareResult = {
  commentId?: number;
  branchInfo: {
    baseBranch: string;
    droidBranch?: string;
    currentBranch: string;
  };
  mcpTools: string;
};

export type PrepareOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
};
