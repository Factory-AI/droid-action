import * as core from "@actions/core";

export function collectActionInputsPresence(): void {
  const inputDefaults: Record<string, string> = {
    trigger_phrase: "@droid",
    assignee_trigger: "",
    label_trigger: "droid",
    base_branch: "",
    branch_prefix: "droid/",
    allowed_bots: "",
    mode: "tag",
    model: "",
    fallback_model: "",
    allowed_tools: "",
    disallowed_tools: "",
    custom_instructions: "",
    direct_prompt: "",
    override_prompt: "",
    additional_permissions: "",
    settings: "",
    factory_api_key: "",
    github_token: "",
    droid_args: "",
    max_turns: "",
    use_sticky_comment: "false",
    experimental_allowed_domains: "",
    track_progress: "false",
    automatic_review: "false",
    automatic_security_review: "false",
    security_model: "",
    security_severity_threshold: "medium",
    security_block_on_critical: "true",
    security_block_on_high: "false",
    security_notify_team: "",
  };

  const allInputsJson = process.env.ALL_INPUTS;
  if (!allInputsJson) {
    console.log("ALL_INPUTS environment variable not found");
    core.setOutput("action_inputs_present", JSON.stringify({}));
    return;
  }

  let allInputs: Record<string, string>;
  try {
    allInputs = JSON.parse(allInputsJson);
  } catch (e) {
    console.error("Failed to parse ALL_INPUTS JSON:", e);
    core.setOutput("action_inputs_present", JSON.stringify({}));
    return;
  }

  const presentInputs: Record<string, boolean> = {};

  for (const [name, defaultValue] of Object.entries(inputDefaults)) {
    const actualValue = allInputs[name] || "";

    const isSet = actualValue !== defaultValue;
    presentInputs[name] = isSet;
  }

  core.setOutput("action_inputs_present", JSON.stringify(presentInputs));
}
