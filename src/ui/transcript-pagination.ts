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

/** Keep a little preceding context when opening an unloaded outline target. */
export function transcriptWindowOffset(seq: number, contextBefore = 20): number {
  return Math.max(0, Math.trunc(seq) - Math.max(0, Math.trunc(contextBefore)));
}
