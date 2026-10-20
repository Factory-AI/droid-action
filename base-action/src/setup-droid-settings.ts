import { $ } from "bun";
import { homedir } from "os";
import { readFile, writeFile } from "fs/promises";

export async function setupDroidSettings(
  settingsInput?: string,
  homeDir?: string,
) {
  const home = homeDir ?? homedir();
  const settingsDir = `${home}/.factory/droid`;
  const settingsPath = `${settingsDir}/settings.json`;
  console.log(`Setting up Droid settings at: ${settingsPath}`);

  // Ensure settings directory exists
  console.log(`Creating Droid settings directory...`);
  await $`mkdir -p ${settingsDir}`.quiet();

  let settings: Record<string, unknown> = {};
  try {
    const existingSettings = await $`cat ${settingsPath}`.quiet().text();
    if (existingSettings.trim()) {
      settings = JSON.parse(existingSettings);
      // Only the keys: settings can hold credentials (`env`, MCP headers), and
      // the job log is public on public repositories.
      console.log(
        `Found existing settings with keys: ${Object.keys(settings).join(", ") || "(none)"}`,
      );
    } else {
      console.log(`Settings file exists but is empty`);
    }
  } catch (e) {
    console.log(`No existing settings file found, creating new one`);
  }

  // Handle settings input (either file path or JSON string)
  if (settingsInput && settingsInput.trim()) {
    console.log(`Processing settings input...`);
    let inputSettings: Record<string, unknown> = {};

    // Parse errors can quote the text they failed on, so none of the messages
    // below include one: settings can hold credentials.
    const trimmed = settingsInput.trim();
    if (trimmed.startsWith("{")) {
      try {
        inputSettings = JSON.parse(trimmed);
      } catch {
        throw new Error(
          "Failed to process settings input: it looks like JSON but does not parse",
        );
      }
      console.log(`Parsed settings input as JSON`);
    } else {
      console.log(`Settings input is not JSON, treating it as a file path`);
      let fileContent: string;
      try {
        fileContent = await readFile(trimmed, "utf-8");
      } catch (fileError) {
        console.error(`Failed to read settings file: ${fileError}`);
        throw new Error(`Failed to process settings input: ${fileError}`);
      }
      try {
        inputSettings = JSON.parse(fileContent);
      } catch {
        throw new Error(
          `Failed to process settings input: ${trimmed} is not valid JSON`,
        );
      }
      console.log(`Successfully read and parsed settings from file`);
    }

    // Merge input settings with existing settings
    settings = { ...settings, ...inputSettings };
    console.log(`Merged settings with input settings`);
  }

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
  console.log(`Settings saved successfully`);
}
