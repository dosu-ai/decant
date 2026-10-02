import { asString, canonicalJson, get } from "../json.ts";
import type { BlockType, Issue, Json, NormalizedBlock } from "../model.ts";

export type UnknownTypes = Map<string, { count: number; firstLine: number }>;

/** Returns undefined for blank lines and records an `unparsed_line` issue for
 * malformed ones, so a bad record never aborts the rest of the file. */
export function parseJsonLine(line: string, lineNo: number, issues: Issue[]): Json | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(line) as Json;
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: error instanceof Error ? error.message : String(error),
      rawLine: line,
    });
    return undefined;
  }
}

export function countUnknown(unknownTypes: UnknownTypes, typ: string, lineNo: number): void {
  const seen = unknownTypes.get(typ) ?? { count: 0, firstLine: lineNo };
  seen.count += 1;
  unknownTypes.set(typ, seen);
}

/** `handling` completes the message, e.g. `ignored` or `kept as role "other"`. */
export function unknownTypeIssues(unknownTypes: UnknownTypes, handling: string): Issue[] {
  const issues: Issue[] = [];
  for (const [typ, seen] of unknownTypes) {
    issues.push({
      code: "unknown_record_type",
      lineNo: seen.firstLine,
      error: `unknown record type "${typ}" on ${seen.count} line(s); ${handling}`,
      rawLine: null,
    });
  }
  return issues;
}

export function block(
  ordinal: number,
  blockType: BlockType,
  fields: Partial<Omit<NormalizedBlock, "ordinal" | "blockType">> = {},
): NormalizedBlock {
  return {
    ordinal,
    blockType,
    text: null,
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
    ...fields,
  };
}

/** Tool-result content as the model read it: text items joined by newlines,
 * anything else (images, structured items) kept as canonical JSON. Claude and
 * Codex both send arrays of content items, and storing the array's JSON would
 * count the wrapper keys as window volume the model never saw. */
export function contentText(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const text = asString(get(item, "text"));
        return text ?? canonicalJson(item);
      })
      .join("\n");
  }
  if (content !== undefined) {
    return canonicalJson(content);
  }
  return "";
}
