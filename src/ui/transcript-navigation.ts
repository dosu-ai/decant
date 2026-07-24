export type TranscriptNavigationDirection = -1 | 1;

export interface TranscriptNavigationKey {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function transcriptNavigationDirection(
  event: TranscriptNavigationKey,
): TranscriptNavigationDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowDown") {
    return 1;
  }
  if (event.key === "ArrowUp") {
    return -1;
  }
  return null;
}

export function nextTranscriptSeq(
  sequences: readonly number[],
  activeSeq: number | null,
  direction: TranscriptNavigationDirection,
): number | null {
  if (sequences.length === 0) {
    return null;
  }
  if (activeSeq == null) {
    return direction === 1 ? (sequences[0] ?? null) : (sequences.at(-1) ?? null);
  }
  const activeIndex = sequences.indexOf(activeSeq);
  if (activeIndex === -1) {
    return direction === 1 ? (sequences[0] ?? null) : (sequences.at(-1) ?? null);
  }
  return sequences[activeIndex + direction] ?? null;
}

export function transcriptSeqFromHash(hash: string): number | null {
  const match = hash.match(/^#message-(\d+)$/);
  if (match == null) {
    return null;
  }
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}
