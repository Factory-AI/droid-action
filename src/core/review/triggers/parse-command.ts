/** Shared parser. Platform adapters decide whether free text is a thread question. */
export type DroidCommand =
  | "fill"
  | "review"
  | "security"
  | "security-full"
  | "help"
  | "fix"
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
  const mask = (code: string) => code.replace(/[^\r\n]/g, " ");
  const inlineBoundaries: number[] = [];
  let offset = 0;
  let quoteDepth = 0;
  let listKind: "ordered" | "bullet" | undefined;
  let atBlockStart = true;
  const blocks = text
    .split("\n")
    .map((line) => {
      const match = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const start = offset;
      offset += line.length + 1;
      const quote = /^(?: {0,3}> ?)+/.exec(line)?.[0] ?? "";
      const depth = quote.match(/>/g)?.length ?? 0;
      const content = line.slice(quote.length).replace(/\r$/, "");
      const blank = !content.trim();
      const singleLine =
        /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content) ||
        /^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(
          content,
        );
      const list = /^ {0,3}(?:([*+-])|(\d{1,9})[.)])[ \t]+\S/.exec(content);
      const startsList =
        !!list &&
        (!!list[1] ||
          list[2] === "1" ||
          atBlockStart ||
          listKind === "ordered");
      const startsQuote = depth > 0 && depth !== quoteDepth;
      const codeBlock = !!fence || !!match;
      // Inline spans can cross soft newlines, but never Markdown block boundaries.
      // Use raw lines: a masked indented continuation is not a blank paragraph.
      if (blank || singleLine || codeBlock || startsQuote || startsList)
        inlineBoundaries.push(start);
      if (blank || singleLine || codeBlock) {
        inlineBoundaries.push(offset);
        quoteDepth = 0;
        listKind = undefined;
        atBlockStart = true;
      } else {
        if (startsQuote) listKind = undefined;
        if (startsList) listKind = list![2] ? "ordered" : "bullet";
        if (depth || startsList) quoteDepth = depth;
        atBlockStart = false;
      }
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
      return /^(?: {0,3}> ?)*(?: {4}|\t)/.test(line) ? mask(line) : line;
    })
    .join("\n");
  const ticks = [...blocks.matchAll(/`+/g)];
  const visible = blocks.split("");
  for (let i = 0; i < ticks.length; i++) {
    const open = ticks[i]!;
    const blockEnd =
      inlineBoundaries.find((boundary) => boundary > open.index!) ??
      text.length;
    const close = ticks.findIndex(
      (run, j) =>
        j > i && run.index! < blockEnd && run[0].length === open[0].length,
    );
    if (close < 0) continue;
    const end = ticks[close]!.index! + ticks[close]![0].length;
    for (let offset = open.index!; offset < end; offset++) {
      if (visible[offset] !== "\n" && visible[offset] !== "\r")
        visible[offset] = " ";
    }
    i = close;
  }
  return visible.join("");
}

export function parseDroidCommand(text: string): ParsedCommand | null {
  if (!text) return null;
  const visible = withoutMarkdownCode(text);
  const mentions = [...visible.matchAll(/(?<![\w@/])@droid(?![\w-])/gi)];
  let fallback: ParsedCommand | null = null;
  for (const mention of mentions) {
    const start = mention.index!;
    const mentionEnd = start + mention[0].length;
    const end =
      mentions.find((next) => next.index! > start)?.index ?? text.length;
    const rest = visible.slice(mentionEnd, end);
    const separator = /^[\s,:;.!?]*/.exec(rest)![0].length;
    const tail = rest.slice(separator);
    const originalTail = text
      .slice(mentionEnd, end)
      .replace(/^[\s,:;.!?]+/, "")
      .trim();
    const base = {
      raw: text.slice(start, start + mention[0].length),
      location: "body" as const,
    };
    if (!tail.trim()) {
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
        "fix",
        "resolve",
        "pause",
        "resume",
      ].includes(name)
    ) {
      fallback ??= { ...base, command: "unknown", text: originalTail };
      continue;
    }
    const prefixLength = separator + word![0].length;
    const raw = text.slice(start, start + mention[0].length + prefixLength);
    let args = rest.slice(prefixLength);
    if (
      name === "review" &&
      /^[\s,:;.!?]*security(?:$|[\s,:;.!?])/i.test(args)
    ) {
      args = args.replace(/^[\s,:;.!?]*security[\s,:;.!?]*/i, "");
      const full = /^--full(?:$|[\s.!?,;:])/i.test(args);
      return {
        ...base,
        raw: `${raw} security${full ? " --full" : ""}`,
        command: full ? "security-full" : "security",
      };
    }
    if (name === "review") {
      const fullReview = /(?:^|\s)--full(?:$|[\s.!?,;:])/i.test(args);
      const fullFlags = /(?:^|\s)--full(?=$|[\s.!?,;:])(?:[.!?,;:](?=$))?/gi;
      if (/(?:^|\s)--\S+/.test(args.replace(fullFlags, " ")))
        return { ...base, command: "unknown", text: originalTail };
      let originalArgs = text.slice(mentionEnd + prefixLength, end);
      for (const flag of [...args.matchAll(fullFlags)].reverse()) {
        originalArgs =
          originalArgs.slice(0, flag.index) +
          " " +
          originalArgs.slice(flag.index! + flag[0].length);
      }
      const focus = originalArgs.replace(/^[\s,:;.!?]+/, "").trim();
      return {
        ...base,
        raw,
        command: "review",
        ...(fullReview ? { fullReview: true } : {}),
        ...(focus ? { focus } : {}),
      };
    }
    if (name === "security") {
      const full = /^[\s,:;.!?]*--full(?:$|[\s.!?,;:])/i.test(args);
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
