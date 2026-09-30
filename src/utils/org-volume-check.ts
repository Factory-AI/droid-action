import type { Octokits } from "../github/api/client";

/**
 * Check if an organization qualifies as "high-volume" for code review.
 * High-volume orgs get increased retry attempts to handle rate limits better.
 *
 * Threshold: >50 eligible reviews/day over the last 7 days.
 * This is determined by checking recent review activity patterns.
 *
 * For now, we use a simpler heuristic: check if the org is on our known
 * high-volume list (Factory's own org, large customers).
 */
export async function isHighVolumeOrg(
  _octokit: Octokits,
  owner: string,
): Promise<boolean> {
  // Known high-volume organizations based on dashboard data
  const KNOWN_HIGH_VOLUME_ORGS = [
    "the-san-francisco-ai-factory", // Factory's own org (5.8% failure rate, 2593 reviews/30d = ~87/day)
    "factory-ai", // Alternative Factory org name
  ];

  const normalizedOwner = owner.toLowerCase();
  if (KNOWN_HIGH_VOLUME_ORGS.includes(normalizedOwner)) {
    return true;
  }

  // Future enhancement: Query actual review volume from GitHub API
  // or from a shared metrics service. For now, explicit list is sufficient
  // to address the immediate Factory org issue.

  return false;
}
