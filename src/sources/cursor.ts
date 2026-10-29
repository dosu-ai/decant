import { constants, Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { linkageIssues } from "../diagnostics.ts";
import { canonicalJson, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type ParsedSession,
  type Role,
} from "../model.ts";
import { isoFromMillis } from "./opencode.ts";
import { block, countUnknown, type UnknownTypes, unknownTypeIssues } from "./shared.ts";

type CursorStoreMeta = JsonObject;
type CursorFileMeta = JsonObject;

export interface CursorSource {
  fileMeta: CursorFileMeta;
  storeMeta: CursorStoreMeta;
  records: CursorRecord[];
}

/** A message blob that could not be read as stored. Kept in place so the
 * parser reports it as a diagnostic without losing the rest of the chat. */
export class CursorBlobProblem {
  constructor(
    readonly kind: "missing" | "text" | "invalid_json",
    /** The blob's text, for the parser to read and for the local raw_line. */
    readonly text: string | null = null,
  ) {}
}

export type CursorRecord = Json | CursorBlobProblem;

/** A failure reading a Cursor store. Its message is fixed text that never
 * quotes the store, so it is safe to log. */
export class CursorSourceError extends Error {}

/** Read one Cursor CLI chat store without ever opening the source database for
 * writes. Active WAL stores need a normal read-only connection; older stores
 * that no longer have sidecars are safely readable through SQLite immutable
 * mode. */
export function readCursorSource(storePath: string): CursorSource {
  const fileMeta = readCursorFileMeta(storePath);
  try {
    return readWith(fileMeta, () => new Database(storePath, { readonly: true }));
  } catch (error) {
    // A WAL store on a read-only mount cannot get the -shm file a normal
    // read-only open creates. Immutable mode reads store.db alone, ignoring
    // locks and the -wal, so it is a fallback only for a store with no writer
    // holding it and nothing pending in its WAL. Anything else fails, and the
    // next sync retries it.
    if (error instanceof CursorSourceError || isLockError(error)) throw error;
    if (hasWalContent(storePath)) {
      throw new CursorSourceError(
        "Cursor store has unread WAL data that a read-only open cannot see; " +
          "mount the chats directory read-write or close the chat in Cursor",
      );
    }
    // Immutable mode needs a URI filename, and the SQLite in Bun's Linux
    // builds parses one only when SQLITE_OPEN_URI is set.
    return readWith(
      fileMeta,
      () =>
        new Database(
          `file:${storePath.replace(/[?#%]/g, encodeURIComponent)}?immutable=1`,
          constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
        ),
    );
  }
}

function readWith(fileMeta: CursorFileMeta, open: () => Database): CursorSource {
  const db = open();
  try {
    return readCursorDatabase(fileMeta, db);
  } finally {
    db.close(false);
  }
}

function hasWalContent(storePath: string): boolean {
  try {
    return statSync(`${storePath}-wal`).size > 0;
  } catch (error) {
    // No WAL file means every commit is already in store.db.
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function isLockError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

function readCursorDatabase(fileMeta: CursorFileMeta, db: Database): CursorSource {
  const metaRow = db.query("SELECT value FROM meta LIMIT 1").get() as { value?: unknown } | null;
  if (typeof metaRow?.value !== "string") {
    throw new CursorSourceError("Cursor store metadata is missing");
  }
  const storeMeta = parseHexJson(metaRow.value, "Cursor store metadata");
  if (!isObject(storeMeta)) {
    throw new CursorSourceError("Cursor store metadata is not an object");
  }
  const rootId = asString(storeMeta.latestRootBlobId);
  if (rootId == null) {
    throw new CursorSourceError("Cursor store metadata has no latestRootBlobId");
  }
  const rootRow = db.query("SELECT data FROM blobs WHERE id = ?1").get(rootId) as {
    data?: unknown;
  } | null;
  const root = bytes(rootRow?.data);
  if (root == null) {
    throw new CursorSourceError("Cursor root blob is missing");
  }

  const messageIds = protobufFieldOneHashes(root);
  const statement = db.query("SELECT data FROM blobs WHERE id = ?1");
  const records: CursorRecord[] = [];
  for (const id of messageIds) {
    const row = statement.get(id) as { data?: unknown } | null;
    if (typeof row?.data === "string") {
      records.push(new CursorBlobProblem("text", row.data));
      continue;
    }
    const data = bytes(row?.data);
    if (data == null) {
      records.push(new CursorBlobProblem("missing"));
      continue;
    }
    const text = new TextDecoder().decode(data);
    try {
      records.push(JSON.parse(text) as Json);
    } catch {
      // Keep the malformed blob in place so the pure parser reports an
      // unparsed_line diagnostic while preserving the rest of the chat.
      records.push(new CursorBlobProblem("invalid_json", text));
    }
  }
  return { fileMeta, storeMeta, records };
}

export function parseCursorSession(fallbackId: string, source: CursorSource): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  const unknownTypes: UnknownTypes = new Map();
  const unknownRoles: UnknownTypes = new Map();
  const schemaVersion = source.fileMeta.schemaVersion;
  if (schemaVersion !== 1) {
    issues.push({
      code: "unknown_record_type",
      lineNo: null,
      error: `unknown Cursor schema version ${typeof schemaVersion === "number" ? schemaVersion : "(not a number)"}; parsed with version 1 rules`,
      rawLine: null,
    });
  }

  for (const [seq, stored] of source.records.entries()) {
    const lineNo = seq + 1;
    const record = readRecord(stored, lineNo, issues);
    if (record === undefined) continue;
    if (!isObject(record)) {
      issues.push({
        code: "unparsed_line",
        lineNo,
        error: "Cursor message blob is not a JSON object",
        rawLine: canonicalJson(record),
      });
      continue;
    }
    const blocks: NormalizedBlock[] = [];
    let content: Json[] = [];
    if (Array.isArray(record.content)) {
      content = record.content;
    } else if (typeof record.content === "string") {
      // The AI SDK message format Cursor stores allows plain-string content.
      content = [{ type: "text", text: record.content }];
    } else {
      issues.push({
        code: "unparsed_line",
        lineNo,
        error: "Cursor message content is not an array; message kept without content",
        rawLine: canonicalJson(record),
      });
    }
    for (const item of content) {
      if (!isObject(item)) {
        countUnknown(unknownTypes, "<non-object>", lineNo);
        continue;
      }
      const normalized = cursorBlock(item, blocks.length);
      if (normalized != null) {
        blocks.push(normalized);
      } else {
        countUnknown(unknownTypes, typeLabel(item.type), lineNo);
      }
    }
    const role = cursorRole(asString(record.role));
    if (role === "other") {
      countUnknown(unknownRoles, typeLabel(record.role), lineNo);
    }
    messages.push({
      seq: messages.length,
      sourceUuid: asString(record.id),
      parentSourceUuid: null,
      role,
      model: null,
      stopReason: null,
      timestamp: null,
      usage: null,
      raw: record,
      blocks,
    });
  }

  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));
  for (const [role, seen] of unknownRoles) {
    issues.push({
      code: "unknown_record_type",
      lineNo: seen.firstLine,
      error: `unknown Cursor message role "${role}" on ${seen.count} message(s); kept as role "other"`,
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

/** Resolves a stored record to its JSON value, or to undefined after
 * reporting a blob that holds none. */
function readRecord(
  stored: CursorRecord,
  lineNo: number,
  issues: ParsedSession["issues"],
): Json | undefined {
  if (!(stored instanceof CursorBlobProblem)) return stored;
  if (stored.kind === "missing") {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: "Cursor message blob is missing from the store",
      rawLine: null,
    });
    return undefined;
  }
  if (stored.kind === "text") {
    issues.push({
      code: "unknown_record_type",
      lineNo,
      error: "Cursor message blob is stored as TEXT rather than BLOB; read as UTF-8",
      rawLine: null,
    });
  }
  try {
    return JSON.parse(stored.text ?? "") as Json;
  } catch {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: "Cursor message blob is not valid JSON",
      rawLine: stored.text,
    });
    return undefined;
  }
}

/** A diagnostic names a type or role only when it looks like an identifier,
 * so a malformed record cannot copy transcript text into the message. */
function typeLabel(value: Json | undefined): string {
  if (typeof value !== "string") return "<non-string>";
  return /^[A-Za-z0-9_.:-]{1,40}$/.test(value) ? value : "<unrecognized>";
}

function cursorBlock(item: JsonObject, ordinal: number): NormalizedBlock | null {
  const type = asString(item.type);
  if (type === "text" || type === "reasoning") {
    return block(ordinal, type === "reasoning" ? "thinking" : "text", {
      text: asString(item.text) ?? "",
    });
  }
  if (type === "redacted-reasoning") {
    return block(ordinal, "thinking");
  }
  if (type === "tool-call") {
    return block(ordinal, "tool_use", {
      toolName: asString(item.toolName),
      toolUseId: asString(item.toolCallId),
      toolInput: item.args,
    });
  }
  if (type === "tool-result") {
    return block(ordinal, "tool_result", {
      toolName: asString(item.toolName),
      toolUseId: asString(item.toolCallId),
      toolResult: item.result === undefined ? null : renderResult(item.result),
      isError: explicitError(item),
    });
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
  const text = readFileSync(path, "utf8");
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    // A JSON syntax error quotes the text around it, so it is not rethrown.
    throw new CursorSourceError("Cursor meta.json is not valid JSON");
  }
  if (!isObject(value)) throw new CursorSourceError("Cursor meta.json is not an object");
  return value;
}

function parseHexJson(value: string, label: string): Json {
  try {
    return JSON.parse(Buffer.from(value, "hex").toString("utf8")) as Json;
  } catch {
    throw new CursorSourceError(`${label} is not valid JSON`);
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
      if (end > data.length) throw new CursorSourceError("Cursor root protobuf is truncated");
      if (field === 1 && length.value === 32) {
        ids.push(Buffer.from(data.subarray(offset, end)).toString("hex"));
      }
      offset = end;
    } else if (wire === 5) {
      offset += 4;
    } else {
      throw new CursorSourceError(`Cursor root protobuf uses unsupported wire type ${wire}`);
    }
    if (offset > data.length) throw new CursorSourceError("Cursor root protobuf is truncated");
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
  throw new CursorSourceError("Cursor root protobuf contains an invalid varint");
}

function skipVarint(data: Uint8Array, start: number): number {
  for (let offset = start; offset < data.length && offset < start + 10; offset += 1) {
    if (((data[offset] ?? 0) & 0x80) === 0) return offset + 1;
  }
  throw new CursorSourceError("Cursor root protobuf contains an invalid varint");
}

function bytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function timestamp(value: Json | undefined): string | null {
  return typeof value === "number" ? isoFromMillis(value) : null;
}

/** Cursor writes empty strings for unset fields, so "" reads as absent. */
function asString(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
