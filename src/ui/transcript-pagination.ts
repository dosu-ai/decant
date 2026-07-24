export interface SequencedTranscriptMessage {
  seq: number;
}

export interface TranscriptRequestRef<T> {
  current: Promise<T> | null;
}

/**
 * Wait for the shared transcript request slot, then claim it before yielding.
 * Re-checking the ref after every await serializes callers that resume from the
 * same request.
 */
export async function runWithTranscriptRequestSlot<T>(
  requestRef: TranscriptRequestRef<T>,
  isCurrent: () => boolean,
  staleValue: T,
  startRequest: () => Promise<T>,
): Promise<T> {
  while (requestRef.current != null) {
    await requestRef.current;
    if (!isCurrent()) {
      return staleValue;
    }
  }
  if (!isCurrent()) {
    return staleValue;
  }
  const request = startRequest();
  requestRef.current = request;
  try {
    return await request;
  } finally {
    if (requestRef.current === request) {
      requestRef.current = null;
    }
  }
}

/**
 * Append a transcript page without duplicating rows if a retry overlaps the
 * previous page. Message sequence numbers are unique within a session.
 */
export function appendTranscriptPage<T extends SequencedTranscriptMessage>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length === 0) {
    return [...current];
  }
  const seen = new Set(current.map((message) => message.seq));
  return [...current, ...incoming.filter((message) => !seen.has(message.seq))];
}

/**
 * Keep a little preceding context when opening an unloaded outline target.
 *
 * Treats `seq` as a dense, zero-based row index, because the server pages with
 * `LIMIT/OFFSET` over `ORDER BY seq`. Both parsers currently guarantee that:
 * every branch that increments `seq` also emits exactly one message. Nothing in
 * the schema enforces it. A parser that ever skipped a `seq` would send outline
 * clicks and compaction jumps to a window that does not contain the target.
 */
export function transcriptWindowOffset(seq: number, contextBefore = 20): number {
  return Math.max(0, Math.trunc(seq) - Math.max(0, Math.trunc(contextBefore)));
}

/**
 * Hold a window offset inside the session so it always addresses a page with
 * rows in it. Deep links travel between archives: `#message-1400` pasted from a
 * longer copy of the same session would otherwise request an offset past the
 * end, get an empty page back, and blank the transcript.
 */
export function clampTranscriptWindowOffset(
  offset: number,
  messageCount: number,
  pageSize: number,
): number {
  if (
    !Number.isFinite(offset) ||
    !Number.isFinite(pageSize) ||
    !Number.isFinite(messageCount) ||
    messageCount <= 0
  ) {
    return 0;
  }
  const lastPageOffset = Math.max(0, Math.trunc(messageCount) - Math.max(1, Math.trunc(pageSize)));
  return Math.min(Math.max(0, Math.trunc(offset)), lastPageOffset);
}
