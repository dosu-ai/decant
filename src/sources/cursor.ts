import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { linkageIssues } from "../diagnostics.ts";
import { canonicalJson } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type ParsedSession,
  type Role,
} from "../model.ts";

type JsonObject = { [key: string]: Json };

type CursorStoreMeta = JsonObject;
type CursorFileMeta = JsonObject;

export interface CursorSource {
  fileMeta: CursorFileMeta;
  storeMeta: CursorStoreMeta;
  records: Json[];
}

/** Read one Cursor CLI chat store without ever opening the source database for
 * writes. Active WAL stores need a normal read-only connection; older stores
 * that no longer have sidecars are safely readable through SQLite immutable
 * mode. */
export function readCursorSource(storePath: string): CursorSource {
  const fileMeta = readCursorFileMeta(storePath);
  let lastError: unknown;
  for (const path of [storePath, `file:${storePath}?immutable=1`]) {
    let db: Database | null = null;
    try {
      db = new Database(path, { readonly: true });
      return readCursorDatabase(fileMeta, db);
    } catch (error) {
      lastError = error;
    } finally {
      db?.close(false);
    }
  }
  throw lastError;
}

function readCursorDatabase(fileMeta: CursorFileMeta, db: Database): CursorSource {
  const metaRow = db.query("SELECT value FROM meta LIMIT 1").get() as { value?: unknown } | null;
  if (typeof metaRow?.value !== "string") {
    throw new Error("Cursor store metadata is missing");
  }
  const storeMeta = parseHexJson(metaRow.value, "Cursor store metadata");
  if (!isObject(storeMeta)) {
    throw new Error("Cursor store metadata is not an object");
  }
  const rootId = asString(storeMeta.latestRootBlobId);
  if (rootId == null) {
    throw new Error("Cursor store metadata has no latestRootBlobId");
  }
  const rootRow = db.query("SELECT data FROM blobs WHERE id = ?1").get(rootId) as {
    data?: unknown;
  } | null;
  const root = bytes(rootRow?.data);
  if (root == null) {
    throw new Error("Cursor root blob is missing");
  }

  const messageIds = protobufFieldOneHashes(root);
  const statement = db.query("SELECT data FROM blobs WHERE id = ?1");
  const records: Json[] = [];
  for (const id of messageIds) {
    const row = statement.get(id) as { data?: unknown } | null;
    const data = bytes(row?.data);
    if (data == null) {
      records.push("Cursor message blob is missing");
      continue;
    }
    const text = new TextDecoder().decode(data);
    try {
      records.push(JSON.parse(text) as Json);
    } catch {
      // Keep the malformed blob as a string so the pure parser reports an
      // unparsed_line diagnostic while preserving the rest of the chat.
      records.push(text);
    }
  }
  return { fileMeta, storeMeta, records };
}

export function parseCursorSession(fallbackId: string, source: CursorSource): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  const unknownTypes = new Map<string, number>();
  if (source.fileMeta.schemaVersion !== 1) {
    issues.push({
      code: "unknown_record_type",
      lineNo: null,
      error: `unknown Cursor schema version ${String(source.fileMeta.schemaVersion)}; parsed with version 1 rules`,
      rawLine: null,
    });
  }

  for (const [seq, record] of source.records.entries()) {
    if (!isObject(record)) {
      issues.push({
        code: "unparsed_line",
        lineNo: seq + 1,
        error: "Cursor message blob is not a JSON object",
        rawLine: canonicalJson(record),
      });
      continue;
    }
    const blocks: NormalizedBlock[] = [];
    const content = Array.isArray(record.content) ? record.content : [];
    for (const item of content) {
      if (!isObject(item)) {
        unknownTypes.set("<non-object>", (unknownTypes.get("<non-object>") ?? 0) + 1);
        continue;
      }
      const type = asString(item.type) ?? "";
      const block = cursorBlock(item, blocks.length);
      if (block != null) {
        blocks.push(block);
      } else {
        unknownTypes.set(type, (unknownTypes.get(type) ?? 0) + 1);
      }
    }
    messages.push({
      seq: messages.length,
      sourceUuid: asString(record.id),
      parentSourceUuid: null,
      role: cursorRole(asString(record.role)),
      model: null,
      stopReason: null,
      timestamp: null,
      usage: null,
      raw: record,
      blocks,
    });
  }

  for (const [type, count] of unknownTypes) {
    issues.push({
      code: "unknown_record_type",
      lineNo: null,
      error: `unknown Cursor content type "${type}" in ${count} block(s); ignored`,
      rawLine: null,
    });
  }

  const subagent = isObject(source.storeMeta.subagentInfo)
    ? source.storeMeta.subagentInfo
    : undefined;
  const isSubagent = source.fileMeta.isSubagent === true || subagent != null;
  const sourceSessionId = asString(source.storeMeta.agentId) ?? fallbackId;
  const startedAt = timestamp(source.fileMeta.createdAtMs);
  const endedAt = timestamp(source.fileMeta.updatedAtMs) ?? startedAt;
  const cwd = asString(source.fileMeta.cwd);
  const session = {
    tool: "cursor" as const,
    sourceSessionId,
    projectPath: cwd,
    title:
      asString(source.fileMeta.title) ?? asString(source.storeMeta.name) ?? firstUserText(messages),
    cwd,
    gitBranch: null,
    model: cursorModel(source.storeMeta.lastUsedModel),
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: null,
    startedAt,
    endedAt,
    isArchived: false,
    isSubagent,
    rootSourceSessionId:
      asString(subagent?.rootParentAgentId) ?? asString(subagent?.parentAgentId) ?? null,
    spawnToolUseId: asString(subagent?.toolCallId),
    agentId: sourceSessionId,
    agentType: asString(subagent?.typeName),
    spawnDepth: null,
    rawMeta: { file: source.fileMeta, store: source.storeMeta },
    totals: emptyUsage(),
    estReasoningTokens: 0,
    reasoningSource: "none" as const,
    messages,
  };
  issues.push(...linkageIssues(session));
  return { session, issues };
}

function cursorBlock(item: JsonObject, ordinal: number): NormalizedBlock | null {
  const type = asString(item.type);
  if (type === "text" || type === "reasoning") {
    return {
      ordinal,
      blockType: type === "reasoning" ? "thinking" : "text",
      text: asString(item.text) ?? "",
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    };
  }
  if (type === "redacted-reasoning") {
    return {
      ordinal,
      blockType: "thinking",
      text: null,
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    };
  }
  if (type === "tool-call") {
    return {
      ordinal,
      blockType: "tool_use",
      text: null,
      toolName: asString(item.toolName),
      toolUseId: asString(item.toolCallId),
      toolInput: item.args,
      toolResult: null,
      isError: null,
    };
  }
  if (type === "tool-result") {
    return {
      ordinal,
      blockType: "tool_result",
      text: null,
      toolName: asString(item.toolName),
      toolUseId: asString(item.toolCallId),
      toolInput: undefined,
      toolResult: item.result === undefined ? null : renderResult(item.result),
      isError: explicitError(item),
    };
  }
  return null;
}

function cursorRole(role: string | null): Role {
  return role === "user" || role === "assistant" || role === "system" || role === "tool"
    ? role
    : "other";
}

function explicitError(item: JsonObject): boolean | null {
  if (typeof item.isError === "boolean") return item.isError;
  if (typeof item.error === "boolean") return item.error;
  return null;
}

function renderResult(value: Json): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function cursorModel(value: Json | undefined): string | null {
  if (typeof value === "string") return value;
  if (!isObject(value)) return null;
  return asString(value.model) ?? asString(value.id) ?? asString(value.name);
}

function firstUserText(messages: NormalizedMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.blocks.find((block) => block.blockType === "text")?.text?.trim();
    if (text) return text.slice(0, 200);
  }
  return null;
}

function readCursorFileMeta(storePath: string): CursorFileMeta {
  const path = storePath.replace(/store\.db$/, "meta.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as Json;
  if (!isObject(value)) throw new Error("Cursor meta.json is not an object");
  return value;
}

function parseHexJson(value: string, label: string): Json {
  try {
    return JSON.parse(Buffer.from(value, "hex").toString("utf8")) as Json;
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function protobufFieldOneHashes(data: Uint8Array): string[] {
  const ids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      offset = skipVarint(data, offset);
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(data, offset);
      offset = length.next;
      const end = offset + length.value;
      if (end > data.length) throw new Error("Cursor root protobuf is truncated");
      if (field === 1 && length.value === 32) {
        ids.push(Buffer.from(data.subarray(offset, end)).toString("hex"));
      }
      offset = end;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new Error(`Cursor root protobuf uses unsupported wire type ${wire}`);
    }
    if (offset > data.length) throw new Error("Cursor root protobuf is truncated");
  }
  return ids;
}

function readVarint(data: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < data.length && shift < 35; offset += 1) {
    const byte = data[offset] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    shift += 7;
  }
  throw new Error("Cursor root protobuf contains an invalid varint");
}

function skipVarint(data: Uint8Array, start: number): number {
  for (let offset = start; offset < data.length && offset < start + 10; offset += 1) {
    if (((data[offset] ?? 0) & 0x80) === 0) return offset + 1;
  }
  throw new Error("Cursor root protobuf contains an invalid varint");
}

function bytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function timestamp(value: Json | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
