import {
  MAX_REVIEW_CONFIG_BYTES,
  REVIEW_CONFIG_PATH,
  ReviewConfigError,
  parseReviewConfigYaml,
  resolveReviewUxConfig,
  type ReviewConfigInputs,
  type ReviewUxConfig,
} from "../../core/review/config";
import { record } from "../../core/review/validated/finding";
import { retryWithBackoff } from "../../utils/retry";

export type ReviewConfigBaseClient = {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: unknown }>;
    };
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
    git: {
      getTree(params: {
        owner: string;
        repo: string;
        tree_sha: string;
      }): Promise<{ data: unknown }>;
    };
  };
};

function status(error: unknown): unknown {
  return error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;
}

/** Fetches a fresh PR base SHA and pins both content and Git mode to it. */
export async function loadReviewUxConfigFromBase(options: {
  client: ReviewConfigBaseClient;
  owner: string;
  repo: string;
  prNumber: number;
  inputs?: ReviewConfigInputs;
  onBaseSha?: (sha: string) => void;
}): Promise<ReviewUxConfig> {
  const { client, owner, repo, prNumber } = options;
  const request = <T>(operation: () => Promise<T>) =>
    retryWithBackoff(operation, {
      initialDelayMs: 200,
      maxDelayMs: 1000,
      shouldRetry: (error) => status(error) !== 404 && status(error) !== 403,
    });
  const response = await request(() =>
    client.rest.pulls.get({ owner, repo, pull_number: prNumber }),
  );
  const base = record(record(response.data)?.base);
  if (typeof base?.sha !== "string" || !/^[a-f\d]{40,64}$/i.test(base.sha)) {
    throw new ReviewConfigError(
      "could not determine the immutable base commit; refusing to read head-branch configuration",
    );
  }
  const baseSha = base.sha;
  options.onBaseSha?.(baseSha);
  let content: { data: unknown };
  try {
    content = await request(() =>
      client.rest.repos.getContent({
        owner,
        repo,
        path: REVIEW_CONFIG_PATH,
        ref: baseSha,
      }),
    );
  } catch (error) {
    if (status(error) !== 404) throw error;
    return resolveReviewUxConfig({ inputs: options.inputs });
  }
  const data = record(content.data);
  if (
    !data ||
    data.type !== "file" ||
    data.encoding !== "base64" ||
    typeof data.content !== "string"
  ) {
    throw new ReviewConfigError("expected a regular UTF-8 configuration file");
  }
  if (typeof data.size === "number" && data.size > MAX_REVIEW_CONFIG_BYTES)
    throw new ReviewConfigError("file exceeds 64 KiB");

  // Contents API reports dereferenced in-repository symlinks as type=file.
  // Only Git object mode at the same immutable base proves this is regular.
  // Walk just the path components, avoiding whole-repository recursive limits
  // and rejecting symlink/submodule parents as well as a nonregular leaf.
  const parts = REVIEW_CONFIG_PATH.split("/");
  let treeSha = baseSha;
  for (const [index, path] of parts.entries()) {
    const tree = record(
      (
        await request(() =>
          client.rest.git.getTree({ owner, repo, tree_sha: treeSha }),
        )
      ).data,
    );
    if (!tree || tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new ReviewConfigError(
        "could not verify the base configuration Git mode",
      );
    }
    const entry = tree.tree.map(record).find((item) => item?.path === path);
    if (index === parts.length - 1) {
      if (
        !entry ||
        entry.type !== "blob" ||
        (entry.mode !== "100644" && entry.mode !== "100755")
      )
        throw new ReviewConfigError(
          "expected a regular UTF-8 configuration file",
        );
    } else {
      if (
        !entry ||
        entry.type !== "tree" ||
        entry.mode !== "040000" ||
        typeof entry.sha !== "string" ||
        !/^[a-f\d]{40,64}$/i.test(entry.sha)
      )
        throw new ReviewConfigError(
          "expected a regular UTF-8 configuration file",
        );
      treeSha = entry.sha;
    }
  }
  const fileConfig = parseReviewConfigYaml(
    Buffer.from(data.content, "base64").toString("utf8"),
  );
  return resolveReviewUxConfig({ fileConfig, inputs: options.inputs });
}
