/**
 * api-version sent on every Azure DevOps REST call. 6.0 is GA on Azure
 * DevOps Services and on Azure DevOps Server 2020 and newer, and every
 * endpoint the review runtime uses (pull requests, iterations, iteration
 * changes, threads) is GA at that version.
 */
export const AZURE_DEVOPS_DEFAULT_API_VERSION = "6.0";

export function azureDevopsApiVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env.AZURE_DEVOPS_API_VERSION?.trim();
  return value ? value : AZURE_DEVOPS_DEFAULT_API_VERSION;
}

/** Collection URIs come with and without a trailing slash; store without. */
export function normalizeCollectionUri(uri: string): string {
  return uri.trim().replace(/\/+$/, "");
}

export type AzureDevopsHosting = "services" | "server";

/** dev.azure.com and *.visualstudio.com are Services; anything else is Server. */
export function detectHosting(collectionUri: string): AzureDevopsHosting {
  let host: string;
  try {
    host = new URL(collectionUri).hostname.toLowerCase();
  } catch {
    return "server";
  }
  return host === "dev.azure.com" || host.endsWith(".visualstudio.com")
    ? "services"
    : "server";
}
