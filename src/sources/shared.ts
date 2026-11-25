import { createHash } from "node:crypto";
import { asString, assertJsonDepth, canonicalJson, get, JsonDepthError } from "../json.ts";
import type { BlockType, Issue, Json, NormalizedBlock } from "../model.ts";

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const RECORD_LIMIT_MESSAGE = "record exceeds the byte limit";

export function parseSourceJson(text: string): Json {
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new RecordLimitError();
  const value = JSON.parse(text) as Json;
  assertJsonDepth(value);
  return value;
}

export class RecordLimitError extends Error {
  constructor() {
    super(RECORD_LIMIT_MESSAGE);
  }
}

export function jsonProblem(error: unknown): string {
  return error instanceof JsonDepthError || error instanceof RecordLimitError
    ? error.message
    : "record is not valid JSON";
}

export function diagnosticRawLine(error: unknown, text: string): string | null {
  return error instanceof JsonDepthError || error instanceof RecordLimitError ? null : text;
}

export function printableType(typ: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(typ)
    ? typ
    : `(unprintable type) sha256:${createHash("sha256").update(typ).digest("hex").slice(0, 12)}`;
}

export type UnknownTypes = Map<string, { count: number; firstLine: number }>;

export function nullRecord<V>(
  source?: Record<string, V> | Iterable<[string, V]> | null,
): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  if (source == null) {
    return out;
  }
  if (Symbol.iterator in source) {
    for (const [k, v] of source) {
      out[k] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(source)) {
    out[k] = v;
  }
  return out;
}

export function ownGet<V>(
  record: Record<string, V> | undefined | null,
  key: string,
): V | undefined {
  return record != null && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function parseJsonLine(line: string, lineNo: number, issues: Issue[]): Json | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  try {
    return parseSourceJson(line);
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: jsonProblem(error),
      rawLine: diagnosticRawLine(error, line),
    });
    return undefined;
  }
}

export function countUnknown(unknownTypes: UnknownTypes, typ: string, lineNo: number): void {
  const label = printableType(typ);
  const seen = unknownTypes.get(label) ?? { count: 0, firstLine: lineNo };
  seen.count += 1;
  unknownTypes.set(label, seen);
}

export type UnknownTypeHandling = "ignored" | 'kept as role "other"' | "read as ATIF-v1.8";

export function unknownTypeIssues(
  unknownTypes: UnknownTypes,
  handling: UnknownTypeHandling,
): Issue[] {
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
