/** Shared parser. Platform adapters decide whether free text is a thread question. */
export type DroidCommand =
  | "fill"
  | "review"
  | "security"
  | "security-full"
  | "help"
  | "resolve"
  | "pause"
  | "resume"
  | "question"
  | "unknown"
  | "default";

export interface ParsedCommand {
  command: DroidCommand;
  raw: string;
  location: "body" | "comment";
  timestamp?: string | null;
  fullReview?: boolean;
  focus?: string;
  text?: string;
}

/** Mask code rather than deleting it, so raw command offsets remain accurate. */
export function withoutMarkdownCode(text: string): string {
  let fence: { character: string; length: number } | undefined;
  return text
    .split("\n")
    .map((line) => {
      const match = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          match &&
          match[1]![0] === fence.character &&
          match[1]!.length >= fence.length &&
          !match[2]!.trim()
        ) {
          fence = undefined;
        }
        return " ".repeat(line.length);
      }
      if (match) {
        fence = { character: match[1]![0]!, length: match[1]!.length };
        return " ".repeat(line.length);
      }
      return line.replace(/(`+)[\s\S]*?\1/g, (code) => " ".repeat(code.length));
    })
    .join("\n");
}

export function parseDroidCommand(text: string): ParsedCommand | null {
  if (!text) return null;
  const visible = withoutMarkdownCode(text);
  const mentions = [...visible.matchAll(/(?<![\w@/])@droid(?![\w-])/gi)];
  let fallback: ParsedCommand | null = null;
  for (const mention of mentions) {
    const start = mention.index!;
    const rest = visible.slice(start + mention[0].length).split("\n")[0]!;
    const tail = rest.replace(/^[\s,:;.!?]+/, "").trim();
    const base = {
      raw: text.slice(start, start + mention[0].length),
      location: "body" as const,
    };
    if (!tail) {
      fallback ??= { ...base, command: "default" };
      continue;
    }
    const word = /^([a-z]+)(?=$|[\s,:;.!?])/i.exec(tail);
    const name = word?.[1]?.toLowerCase();
    if (
      !name ||
      ![
        "fill",
        "review",
        "security",
        "help",
        "resolve",
        "pause",
        "resume",
      ].includes(name)
    ) {
      fallback ??= { ...base, command: "unknown", text: tail };
      continue;
    }
    const prefixLength = rest.indexOf(word![0]) + word![0].length;
    const raw = text.slice(start, start + mention[0].length + prefixLength);
    let args = tail
      .slice(word![0].length)
      .replace(/^[,:;.!?]+/, "")
      .trim();
    if (name === "review" && /^security(?:$|[\s,:;.!?])/i.test(args)) {
      args = args.replace(/^security[\s,:;.!?]*/i, "");
      const full = /^--full(?:$|[\s.!?,;:])/i.test(args);
      return {
        ...base,
        raw: `${raw} security${full ? " --full" : ""}`,
        command: full ? "security-full" : "security",
      };
    }
    if (name === "review") {
      const fullReview = /(?:^|\s)--full(?:$|[\s.!?,;:])/i.test(args);
      const focus = args
        .replace(/(?:^|\s)--full(?=$|[\s.!?,;:])(?:[.!?,;:](?=$))?/gi, " ")
        .trim();
      if (/(?:^|\s)--\S+/.test(focus))
        return { ...base, command: "unknown", text: tail };
      return {
        ...base,
        raw,
        command: "review",
        ...(fullReview ? { fullReview: true } : {}),
        ...(focus ? { focus } : {}),
      };
    }
    if (name === "security") {
      const full = /^--full(?:$|[\s.!?,;:])/i.test(args);
      return {
        ...base,
        raw: `${raw}${full ? " --full" : ""}`,
        command: full ? "security-full" : "security",
      };
    }
    return { ...base, raw, command: name as DroidCommand };
  }
  return fallback;
}
