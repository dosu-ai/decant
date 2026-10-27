import type { Database } from "bun:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "bun";
import { withImmediateTransaction } from "./db.ts";
import { byteLength, canonicalJson, get } from "./json.ts";
import type { Json } from "./model.ts";

const MIN_COMPRESS_BYTES = 1024;
const COMPACT_BATCH_SIZE = 128;

/** SQL reads use the small metadata projection without inflating the source record. */
export const MESSAGE_METADATA_SQL = "COALESCE(m.raw_meta, m.raw)";

// Keep this projection in sync with SQL readers of message source metadata.
// The complete source record remains in raw, including every unknown field.
// New paths also need a backfill from stored raw for existing compressed rows,
// including sessions whose source files are gone. Compaction skips BLOB rows.
const METADATA_PATHS = [
  ["isSidechain"],
  ["subtype"],
  ["type"],
  ["isCompactSummary"],
  ["compactMetadata", "trigger"],
  ["compactMetadata", "preTokens"],
  ["payload", "role"],
  ["message", "id"],
  ["message", "usage"],
  ["cost"],
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
] as const;

export interface StoredMessageRaw {
  raw: string | Uint8Array;
  rawMeta: string | null;
  rawBytes: number | null;
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
  return canonicalJson(metadata);
}

/** Store standard zstd frames only when the frame plus metadata is smaller. */
export function encodeMessageRaw(raw: string, parsed?: Json): StoredMessageRaw {
  const bytes = byteLength(raw);
  if (bytes < MIN_COMPRESS_BYTES) return { raw, rawMeta: null, rawBytes: null };
  let value = parsed;
  if (value === undefined) {
    try {
      value = JSON.parse(raw) as Json;
    } catch {
      // Historic/manual non-JSON rows retain their original validity semantics.
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

/** Corrupt frames throw rather than silently losing the retained record. */
export function decodeMessageRaw(raw: string | Uint8Array): string {
  if (typeof raw === "string") return raw;
  return zstdDecompressSync(raw).toString("utf8");
}

export interface CompactMessageStorageResult {
  scanned: number;
  compressed: number;
  saved_bytes: number;
}

/**
 * Each batch commits independently so interruption keeps completed work and a
 * retry skips its BLOB rows. Read one record at a time to avoid buffering a
 * batch of large tool results in memory. VACUUM belongs to the CLI caller.
 */
export function compactMessageStorage(
  db: Database,
  onProgress?: (result: Readonly<CompactMessageStorageResult>) => void,
): CompactMessageStorageResult {
  const result = { scanned: 0, compressed: 0, saved_bytes: 0 };
  const ids = db.prepare(
    `SELECT id FROM message WHERE id > ?1 AND typeof(raw) = 'text'
       AND octet_length(raw) >= ?2 ORDER BY id LIMIT ?3`,
  );
  const read = db.prepare("SELECT raw FROM message WHERE id = ?1");
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
          const row = read.get(id) as { raw: string | Uint8Array } | null;
          if (row == null || typeof row.raw !== "string") continue;
          result.scanned += 1;
          const encoded = encodeMessageRaw(row.raw);
          if (typeof encoded.raw === "string") continue;
          if (decodeMessageRaw(encoded.raw) !== row.raw) {
            throw new Error(`message ${id} failed lossless compression verification`);
          }
          update.run(encoded.raw, encoded.rawMeta, encoded.rawBytes, id);
          result.compressed += 1;
          result.saved_bytes +=
            byteLength(row.raw) - encoded.raw.byteLength - byteLength(encoded.rawMeta ?? "");
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
