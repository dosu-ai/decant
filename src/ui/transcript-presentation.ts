export type StructuredTranscriptKind =
  | "collaboration"
  | "collaboration-mode"
  | "realtime-ended"
  | "realtime-handoff";

export type StructuredTranscriptSpeaker = "assistant" | "user";

export interface StructuredTranscriptLine {
  speaker: StructuredTranscriptSpeaker;
  text: string;
}

export interface StructuredTranscriptBlock {
  kind: StructuredTranscriptKind;
  title: string;
  description: string;
  chips: string[];
  dialogue: StructuredTranscriptLine[];
}

export function structuredTranscriptBlock(text: string): StructuredTranscriptBlock | null {
  const trimmed = text.trim();
  if (/^<realtime_conversation>/i.test(trimmed)) {
    const reason = matchText(trimmed, /(?:^|\n)Reason:\s*([^\r\n<]+)/i);
    return {
      kind: "realtime-ended",
      title: "Realtime conversation ended",
      description:
        reason?.toLowerCase() === "inactive"
          ? "Voice mode ended after a period of inactivity. The conversation continued in text."
          : "Voice mode ended and the conversation continued in text.",
      chips: ["voice", reason == null ? "ended" : reason],
      dialogue: [],
    };
  }

  if (/^<realtime_delegation>/i.test(trimmed)) {
    const source = tagContents(trimmed, "source");
    const input = tagContents(trimmed, "input");
    const delta = tagContents(trimmed, "transcript_delta");
    const dialogue =
      delta == null
        ? directVoiceInput(input)
        : parseTranscriptDialogue(decodeXmlEntities(delta).trim());
    const tailFlush = source === "transcript_tail_flush";
    return {
      kind: "realtime-handoff",
      title: tailFlush ? "Realtime handoff" : "Voice input",
      description: tailFlush
        ? "The final voice exchange was handed back to the agent before returning to text."
        : "Spoken input captured during the realtime conversation.",
      chips: [
        "voice",
        tailFlush ? "final exchange" : "live input",
        dialogue.length === 0
          ? null
          : `${dialogue.length} ${dialogue.length === 1 ? "message" : "messages"}`,
      ].filter((value): value is string => value != null),
      dialogue,
    };
  }

  if (
    /^You are `\/root`, the primary agent in a team of agents collaborating/i.test(trimmed) ||
    (trimmed.includes("collaboration tools cannot be called from inside") &&
      trimmed.includes("All agents share the same directory"))
  ) {
    const slots = matchText(trimmed, /There are\s+(\d+)\s+available concurrency slots/i);
    return {
      kind: "collaboration",
      title: "Multi-agent collaboration",
      description:
        "This session uses a primary coordinator that can delegate work to agents sharing the same workspace.",
      chips: ["primary agent", slots == null ? null : `${slots} slots`, "shared workspace"].filter(
        (value): value is string => value != null,
      ),
      dialogue: [],
    };
  }

  if (/^<multi_agent_mode>/i.test(trimmed)) {
    const delegationDisabled = /do not spawn sub-agents unless/i.test(trimmed);
    return {
      kind: "collaboration-mode",
      title: "Collaboration mode",
      description: delegationDisabled
        ? "Subagent delegation is disabled unless the user or repository instructions request it."
        : "Runtime guidance for how this session may delegate work to other agents.",
      chips: [delegationDisabled ? "delegation on request" : "agent coordination"],
      dialogue: [],
    };
  }

  return null;
}

export function parseTranscriptDialogue(value: string): StructuredTranscriptLine[] {
  const marker = /(?:^|\n)\s*(assistant|user):\s*/gi;
  const matches = [...value.matchAll(marker)];
  return matches.flatMap((match, index) => {
    const speaker = match[1]?.toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    const text = value.slice(start, end).trim();
    if ((speaker !== "assistant" && speaker !== "user") || text === "") {
      return [];
    }
    return [{ speaker, text }];
  });
}

function directVoiceInput(input: string | null): StructuredTranscriptLine[] {
  if (
    input == null ||
    input === "" ||
    /^The user just ended their realtime session\./i.test(input)
  ) {
    return [];
  }
  const text = decodeXmlEntities(stripTags(input)).trim();
  return text === "" ? [] : [{ speaker: "user", text }];
}

function tagContents(value: string, tag: string): string | null {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function matchText(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1]?.trim() ?? null;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
