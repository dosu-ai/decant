import type { Database } from "bun:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "bun";
import { withImmediateTransaction } from "./db.ts";
import { byteLength, canonicalJson, get } from "./json.ts";
import type { Json } from "./model.ts";

const MIN_COMPRESS_BYTES = 1024;
const MIN_TOOL_RESULT_SAVINGS_BYTES = 32;
const COMPACT_BATCH_SIZE = 128;

export const MESSAGE_METADATA_SQL = "COALESCE(m.raw_meta, m.raw)";

export const METADATA_PATHS = [
  ["isSidechain"],
  ["subtype"],
  ["type"],
  ["isCompactSummary"],
  ["compactMetadata", "trigger"],
  ["compactMetadata", "preTokens"],
  ["data", "preCompactionTokens"],
  ["payload", "role"],
  ["message", "id"],
  ["message", "usage"],
  ["cost"],
  ["metrics", "cost_usd"],
  ["model", "providerID"],
  ["providerID"],
  ["reasoning_tokens"],
  ["callID"],
  ["id"],
  ["name"],
  ["tool"],
  ["state", "metadata", "sessionID"],
  ["state", "metadata", "sessionId"],
  ["sessionId"],
  ["agentId"],
  ["extra", "context_management", "type"],
  ["_compressed_summary"],
  ["usage"],
  ["tokensBefore"],
] as const;

export interface StoredMessageRaw {
  raw: string | Uint8Array;
  rawMeta: string | null;
  rawBytes: number | null;
}

export interface StoredBlockToolResult {
  toolResult: string | Uint8Array | null;
  toolResultBytes: number | null;
}

function rawMetadata(raw: Json): string {
  const metadata: Record<string, Json> = {};
  for (const path of METADATA_PATHS) {
    let value: Json | undefined = raw;
    for (const key of path) value = get(value, key);
    if (value === undefined) continue;
    let target = metadata;
    for (const key of path.slice(0, -1)) {
      target[key] ??= {};
      target = target[key] as Record<string, Json>;
    }
    target[path[path.length - 1] as string] = value;
  }
  if (get(raw, "type") === "session.compaction_complete") {
    metadata.data ??= {};
    (metadata.data as Record<string, Json>).preCompactionTokens ??= null;
  }
  return canonicalJson(metadata);
}

export function encodeMessageRaw(raw: string, parsed?: Json): StoredMessageRaw {
  const bytes = byteLength(raw);
  if (bytes < MIN_COMPRESS_BYTES) return { raw, rawMeta: null, rawBytes: null };
  let value = parsed;
  if (value === undefined) {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      return { raw, rawMeta: null, rawBytes: null };
    }
  }
  const rawMeta = rawMetadata(value);
  const compressed = zstdCompressSync(raw, { level: 3 });
  if (compressed.byteLength + byteLength(rawMeta) + 64 >= bytes) {
    return { raw, rawMeta: null, rawBytes: null };
  }
  return { raw: compressed, rawMeta, rawBytes: bytes };
}

export function decodeMessageRaw(raw: string | Uint8Array): string {
  if (typeof raw === "string") return raw;
  if (raw.byteLength === 0) {
    throw new Error("compressed message source record is empty");
  }
  return zstdDecompressSync(raw).toString("utf8");
}

export function encodeBlockToolResult(toolResult: string | null): StoredBlockToolResult {
  if (toolResult == null) return { toolResult: null, toolResultBytes: null };
  const bytes = byteLength(toolResult);
  if (bytes < MIN_COMPRESS_BYTES) return { toolResult, toolResultBytes: null };
  const compressed = zstdCompressSync(toolResult, { level: 3 });
  if (compressed.byteLength + MIN_TOOL_RESULT_SAVINGS_BYTES >= bytes) {
    return { toolResult, toolResultBytes: null };
  }
  return { toolResult: compressed, toolResultBytes: bytes };
}

export function decodeBlockToolResult(
  toolResult: string | Uint8Array | null,
  expectedBytes?: number | null,
): string | null {
  if (toolResult == null || typeof toolResult === "string") return toolResult;
  if (toolResult.byteLength === 0) {
    throw new Error("compressed tool_result payload is empty");
  }
  const decoded = zstdDecompressSync(toolResult);
  if (expectedBytes != null && decoded.byteLength !== expectedBytes) {
    throw new Error(
      `compressed tool_result byte length ${decoded.byteLength} does not match recorded ${expectedBytes}`,
    );
  }
  return decoded.toString("utf8");
}

export interface CompactMessageStorageResult {
  scanned: number;
  compressed: number;
  saved_bytes: number;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

export function compactMessageStorage(
  db: Database,
  onProgress?: (result: Readonly<CompactMessageStorageResult>) => void,
): CompactMessageStorageResult {
  const result = { scanned: 0, compressed: 0, saved_bytes: 0 };
  const ids = db.prepare(
    `SELECT id FROM message WHERE id > ?1 AND typeof(raw) = 'text'
       AND octet_length(raw) >= ?2 ORDER BY id LIMIT ?3`,
  );
  const read = db.prepare("SELECT raw, CAST(raw AS BLOB) AS raw_blob FROM message WHERE id = ?1");
  const update = db.prepare(
    "UPDATE message SET raw = ?1, raw_meta = ?2, raw_bytes = ?3 WHERE id = ?4",
  );
  let after = 0;
  try {
    while (true) {
      const batch = ids.all(after, MIN_COMPRESS_BYTES, COMPACT_BATCH_SIZE) as { id: number }[];
      if (batch.length === 0) break;
      withImmediateTransaction(db, () => {
        for (const { id } of batch) {
          const row = read.get(id) as { raw: string | Uint8Array; raw_blob: Uint8Array } | null;
          if (row == null || typeof row.raw !== "string") continue;
          result.scanned += 1;
          if (!bytesEqual(Buffer.from(row.raw, "utf8"), row.raw_blob)) continue;
          const encoded = encodeMessageRaw(row.raw);
          if (typeof encoded.raw === "string") continue;
          const decompressed = zstdDecompressSync(encoded.raw);
          if (
            !bytesEqual(decompressed, row.raw_blob) ||
            decompressed.toString("utf8") !== row.raw
          ) {
            throw new Error(`message ${id} failed lossless compression verification`);
          }
          update.run(encoded.raw, encoded.rawMeta, encoded.rawBytes, id);
          result.compressed += 1;
          result.saved_bytes +=
            row.raw_blob.byteLength - encoded.raw.byteLength - byteLength(encoded.rawMeta ?? "");
        }
      });
      after = batch[batch.length - 1]?.id ?? after;
      onProgress?.({ ...result });
    }
  } finally {
    ids.finalize();
    read.finalize();
    update.finalize();
  }
  return result;
}

export function compactBlockToolResultStorage(
  db: Database,
  onProgress?: (result: Readonly<CompactMessageStorageResult>) => void,
): CompactMessageStorageResult {
  const result = { scanned: 0, compressed: 0, saved_bytes: 0 };
  const ids = db.prepare(
    `SELECT id FROM block WHERE id > ?1 AND typeof(tool_result) = 'text'
       AND octet_length(tool_result) >= ?2 ORDER BY id LIMIT ?3`,
  );
  const read = db.prepare(
    "SELECT tool_result, CAST(tool_result AS BLOB) AS raw_blob FROM block WHERE id = ?1",
  );
  const update = db.prepare(
    "UPDATE block SET tool_result = ?1, tool_result_bytes = ?2 WHERE id = ?3",
  );
  let after = 0;
  try {
    while (true) {
      const batch = ids.all(after, MIN_COMPRESS_BYTES, COMPACT_BATCH_SIZE) as { id: number }[];
      if (batch.length === 0) break;
      withImmediateTransaction(db, () => {
        for (const { id } of batch) {
          const row = read.get(id) as {
            tool_result: string | Uint8Array | null;
            raw_blob: Uint8Array | null;
          } | null;
          if (row == null || typeof row.tool_result !== "string" || row.raw_blob == null) continue;
          result.scanned += 1;
          if (!bytesEqual(Buffer.from(row.tool_result, "utf8"), row.raw_blob)) continue;
          const encoded = encodeBlockToolResult(row.tool_result);
          if (encoded.toolResult == null || typeof encoded.toolResult === "string") continue;
          const decompressed = zstdDecompressSync(encoded.toolResult);
          if (
            !bytesEqual(decompressed, row.raw_blob) ||
            decompressed.toString("utf8") !== row.tool_result
          ) {
            throw new Error(`block ${id} failed lossless compression verification`);
          }
          update.run(encoded.toolResult, encoded.toolResultBytes, id);
          result.compressed += 1;
          result.saved_bytes += row.raw_blob.byteLength - encoded.toolResult.byteLength;
        }
      });
      after = batch[batch.length - 1]?.id ?? after;
      onProgress?.({ ...result });
    }
  } finally {
    ids.finalize();
    read.finalize();
    update.finalize();
  }
  return result;
}

export function backfillCopilotCompactionMetadata(db: Database): number {
  const ids = db.prepare(`SELECT m.id FROM message m JOIN session s ON s.id = m.session_id
    WHERE s.tool = 'copilot' AND m.id > ?1 AND m.role = 'system'
      AND json_extract(${MESSAGE_METADATA_SQL}, '$.type') = 'session.compaction_complete'
      AND json_type(m.raw_meta, '$.data.preCompactionTokens') IS NULL
    ORDER BY m.id LIMIT ?2`);
  const read = db.prepare("SELECT raw, session_id FROM message WHERE id = ?1");
  const update = db.prepare("UPDATE message SET raw_meta = ?1 WHERE id = ?2");
  const invalidate = db.prepare("UPDATE session SET peak_context_tokens = NULL WHERE id = ?1");
  let after = 0;
  let repaired = 0;
  try {
    while (true) {
      const batch = ids.all(after, COMPACT_BATCH_SIZE) as { id: number }[];
      if (batch.length === 0) break;
      withImmediateTransaction(db, () => {
        for (const { id } of batch) {
          const row = read.get(id) as { raw: string | Uint8Array; session_id: number };
          const raw = JSON.parse(decodeMessageRaw(row.raw)) as Json;
          update.run(rawMetadata(raw), id);
          invalidate.run(row.session_id);
          repaired += 1;
        }
      });
      after = batch[batch.length - 1]?.id ?? after;
    }
  } finally {
    ids.finalize();
    read.finalize();
    update.finalize();
    invalidate.finalize();
  }
  return repaired;
}
