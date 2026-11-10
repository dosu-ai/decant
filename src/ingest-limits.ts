import { fstatSync, readSync } from "node:fs";

// Large transcripts remain useful, but a single file must not exhaust the heap.
export const MAX_SOURCE_FILE_BYTES = 256 * 1024 * 1024;
export const FILE_LIMIT_MESSAGE = "source file exceeds the byte limit";

/** Read at most the budget plus one byte, even when a writer grows the file. */
export function readSourceFile(fd: number): string | null {
  if (fstatSync(fd).size > MAX_SOURCE_FILE_BYTES) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_SOURCE_FILE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_FILE_BYTES + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total).toString("utf8");
    total += count;
    if (total > MAX_SOURCE_FILE_BYTES) return null;
    chunks.push(chunk.subarray(0, count));
  }
  return null;
}
