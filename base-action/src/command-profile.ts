import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";

export type CommandProfile = {
  cwd: string;
  env: Record<string, string>;
  args: string;
};

/**
 * A fresh CLI profile prevents user/project hooks and MCP startup from leaking
 * into file-only fix/question runs. This is configuration isolation, not an OS
 * sandbox: the process still runs as the job's user.
 */
export async function createCommandProfile(
  mode: "fix" | "question",
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<CommandProfile> {
  const root = await mkdtemp(join(tmpdir(), "droid-command-profile-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const settings = { hooksDisabled: true };
  for (const directory of [home, cwd]) {
    await mkdir(join(directory, ".factory"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, ".factory", "settings.json"),
      JSON.stringify(settings),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, ".factory", "mcp.json"),
      '{"mcpServers":{}}',
      { mode: 0o600 },
    );
  }
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PWD: cwd,
    FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
  };
  // No inherited tokens, hooks, MCP paths, file commands, Node/Bun preload
  // options, or publisher authority. Only runtime/auth/network essentials.
  for (const key of [
    "PATH",
    "FACTORY_API_KEY",
    "FACTORY_API_BASE_URL",
    "FACTORY_API_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  const settingsPath = resolve(cwd, ".factory", "settings.json");
  if (!isAbsolute(settingsPath))
    throw new Error("Command settings path must be absolute");
  return {
    cwd,
    env,
    // All arguments come from code, never user settings or droid_args. The
    // documented hooksDisabled + --settings override also blocks managed hooks.
    args: `--cwd ${JSON.stringify(cwd)} --settings ${JSON.stringify(settingsPath)} --disable-builtin-skills --enabled-tools "Read,Grep,Glob,LS,Edit,Create,ApplyPatch" --tag "droid-${mode}"`,
  };
}
