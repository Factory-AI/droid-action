/**
 * Model id the Droid CLI itself reports for the session, read from
 * `droid exec --output-format stream-json` output. This is session-level
 * evidence of what the CLI ran — never a verified provider backend, and
 * absent when the CLI does not report one.
 */

/**
 * Bounded identifier shape guarding the public Models line: a model id can
 * only contain plain identifier characters, so tool results and other
 * untrusted stream content cannot smuggle markdown or control characters
 * into the comment. The shape mirrors the ids the CLI itself emits.
 */
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function safeModelId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_MODEL_ID_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * Extracts the model id from one stream event. Only the event kinds the CLI
 * uses to report the session's model are considered:
 * - the `system` init event's `model` field;
 * - `assistant` / `message` / `completion` events' `modelId`, `model`, or
 *   `message.modelId` / `message.model` fields.
 * Everything else (tool calls and their results, result payloads, unknown
 * event kinds) is ignored.
 */
export function extractObservedModel(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const e = event as Record<string, unknown>;
  if (e.type === "system") {
    return safeModelId(e.model);
  }
  if (
    e.type !== "assistant" &&
    e.type !== "message" &&
    e.type !== "completion"
  ) {
    return undefined;
  }
  const message =
    typeof e.message === "object" && e.message !== null
      ? (e.message as Record<string, unknown>)
      : undefined;
  for (const value of [
    e.modelId,
    e.model,
    message && safeModelId(message.modelId),
    message && safeModelId(message.model),
  ]) {
    const model = safeModelId(value);
    if (model) return model;
  }
  return undefined;
}
