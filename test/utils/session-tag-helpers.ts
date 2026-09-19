import { parse as parseShellArgs } from "shell-quote";

/**
 * Decodes the `--tag` value from a `droid_args` output string the same way
 * base-action does before spawning the CLI: shell-split, then JSON-parse.
 */
export function parseSessionTagFromDroidArgs(droidArgs: string): unknown {
  const tokens = parseShellArgs(droidArgs).filter(
    (token): token is string => typeof token === "string",
  );
  const tagIndex = tokens.indexOf("--tag");
  if (tagIndex === -1 || tagIndex + 1 >= tokens.length) {
    throw new Error(`No --tag value found in droid_args: ${droidArgs}`);
  }
  return JSON.parse(tokens[tagIndex + 1]!);
}
