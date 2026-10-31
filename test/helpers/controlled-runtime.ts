import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export async function privateStartupEnvironment(directory: string) {
  const home = join(directory, "startup-home");
  const temporary = join(directory, "startup-tmp");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(temporary, { recursive: true }),
  ]);
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    RUNNER_TEMP: temporary,
  };
}

/** Restore fixture-only startup paths after the real wrapper's env-i boundary. */
export async function createControlledRuntime(directory: string) {
  const root = await mkdtemp(join(directory, "controlled-runtime-"));
  const env = await privateStartupEnvironment(root);
  const runtime = await realpath(process.execPath);
  const runtimeSha = createHash("sha256")
    .update(await readFile(runtime))
    .digest("hex");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const source = [
    "#!/bin/sh",
    ...Object.entries(env).map(
      ([key, value]) => `export ${key}=${quote(value)}`,
    ),
    `pinned=$(/usr/bin/sha256sum ${quote(runtime)})`,
    `[ "\${pinned%% *}" = ${quote(runtimeSha)} ] || exit 96`,
    `exec ${quote(runtime)} "$@"`,
    "",
  ].join("\n");
  const path = join(root, "runtime");
  await writeFile(path, source, { mode: 0o700 });
  return {
    path,
    sha256: createHash("sha256").update(source).digest("hex"),
    env,
  };
}
