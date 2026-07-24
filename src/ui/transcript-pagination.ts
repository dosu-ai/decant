export interface SequencedTranscriptMessage {
  seq: number;
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
