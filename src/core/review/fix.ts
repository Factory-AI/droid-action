import { z } from "zod";
import type { ReviewUxConfig } from "./config";
export { UNTRUSTED_FINDING_PREAMBLE } from "./untrusted-findings";

export type FixMode = ReviewUxConfig["fix_mode"];

export const fixProposalSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            content: z
              .string()
              .max(1024 * 1024)
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type FixProposal = z.infer<typeof fixProposalSchema>;

export function assertFixPath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /^(?:\.git|\.github\/workflows|\.factory)(?:\/|$)/i.test(path) ||
    /(?:^|\/)\.env(?:\.|$)/i.test(path)
  )
    throw new Error("Fix includes an unsafe or privileged file path");
}

export function chooseFixTarget(input: {
  mode: FixMode;
  writable: boolean;
  protected: boolean;
  headBranch: string;
  defaultBranch: string;
  fork: boolean;
}): "commit" | "pr" {
  if (input.mode === "off")
    throw new Error("@droid fix is disabled by fix_mode: off");
  if (!input.writable)
    throw new Error(
      input.fork
        ? "Droid cannot fix this fork: the token has no write access to the fork repository. Ask a maintainer to enable a permitted write route or apply the AI-agent prompt manually."
        : "Droid cannot publish this fix: contents: write access is required.",
    );
  if (input.headBranch === input.defaultBranch) {
    throw new Error(
      "Droid will not publish fixes to a repository's default branch. Use a non-default PR branch.",
    );
  }
  return input.mode === "pr" || input.protected || input.fork ? "pr" : "commit";
}
