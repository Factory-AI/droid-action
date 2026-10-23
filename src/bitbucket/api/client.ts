import { BitbucketCloudClient } from "./cloud";
import { BitbucketDataCenterClient } from "./datacenter";
import type { BitbucketAuth } from "./http";
import type { BitbucketClient } from "../types";

/** Repository coordinates, as persisted in the prepare state file. */
export type BitbucketTarget =
  | {
      variant: "cloud";
      apiUrl: string;
      workspace: string;
      repoSlug: string;
      prId: number;
    }
  | {
      variant: "datacenter";
      serverUrl: string;
      projectKey: string;
      repoSlug: string;
      prId: number;
    };

export function createBitbucketClient(
  target: BitbucketTarget,
  auth: BitbucketAuth,
  options: { retryDelayMs?: number } = {},
): BitbucketClient {
  if (target.variant === "cloud") {
    return new BitbucketCloudClient({ ...target, auth, ...options });
  }
  return new BitbucketDataCenterClient({ ...target, auth, ...options });
}
