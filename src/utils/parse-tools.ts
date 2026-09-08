/**
 * Utility functions for parsing tool arguments
 * These functions are used by tag mode commands to parse user-provided tool arguments
 */

const ALLOWED_FLAG_PATTERN =
  /--(?:(?:allowedTools|allowed-tools|enabled-tools|enabledTools))\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/;

export function parseAllowedTools(args: string): string[] {
  if (!args) {
    return [];
  }

  const match = args.match(ALLOWED_FLAG_PATTERN);
  if (!match) {
    return [];
  }

  // Determine which capturing group matched (double quotes, single quotes, or bare)
  const value = match[1] || match[2] || match[3];
  if (!value || value.startsWith("--")) {
    return [];
  }

  return value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export function normalizeDroidArgs(args: string): string {
  if (!args) {
    return "";
  }

  return (
    args
      .replace(/--allowedTools/g, "--enabled-tools")
      .replace(/--allowed-tools/g, "--enabled-tools")
      .replace(/--enabledTools/g, "--enabled-tools")
      .replace(/--disallowedTools/g, "--disabled-tools")
      .replace(/--disabled-tools/g, "--disabled-tools")
      .replace(/--disallowed-tools/g, "--disabled-tools")
      // Strip unsupported MCP inline config flags to avoid CLI errors
      .replace(/--mcp-config\s+(?:"[^"]*"|'[^']*'|[^\s]+)/g, "")
      .trim()
  );
}

/**
 * Removes user-provided tool selection flags from an argument string.
 *
 * File-only review validation owns its exact tool allowlist. Keeping a
 * second `--enabled-tools` flag in custom args could re-enable GitHub
 * mutation tools after the action deliberately removed them.
 */
export function stripToolSelectionArgs(args: string): string {
  return args
    .replace(
      /(?:^|\s)--(?:enabled-tools|disabled-tools)\s+(?:"[^"]*"|'[^']*'|[^\s]+)/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}
