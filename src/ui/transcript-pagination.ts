import { SESSION_MESSAGE_PAGE_MAX } from "../api-limits.ts";

export interface SequencedTranscriptMessage {
  seq: number;
}

export interface TranscriptRequestRef<T> {
  current: Promise<T> | null;
}

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

export function prependTranscriptPage<T extends SequencedTranscriptMessage>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  if (incoming.length === 0) {
    return [...current];
  }
  const seen = new Set(current.map((message) => message.seq));
  return [...incoming.filter((message) => !seen.has(message.seq)), ...current];
}

export function previousTranscriptPageRequest(
  offset: number,
  pageSize: number,
): { offset: number; limit: number } | null {
  if (!Number.isFinite(offset) || !Number.isFinite(pageSize)) {
    return null;
  }
  const start = Math.trunc(offset);
  const size = Math.max(1, Math.trunc(pageSize));
  if (start <= 0) {
    return null;
  }
  const previousOffset = Math.max(0, start - size);
  return { offset: previousOffset, limit: start - previousOffset };
}

export function transcriptWindowOffset(seq: number, contextBefore = 20): number {
  return Math.max(0, Math.trunc(seq) - Math.max(0, Math.trunc(contextBefore)));
}

export function transcriptPrefixRequest(
  seq: number,
  messageCount: number,
  contextAfter = 0,
): { offset: 0; limit: number } {
  const target = Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0;
  const available = Number.isFinite(messageCount) ? Math.max(0, Math.trunc(messageCount)) : 0;
  const following = Number.isFinite(contextAfter) ? Math.max(0, Math.trunc(contextAfter)) : 0;
  return {
    offset: 0,
    limit: available > 0 ? Math.min(target + 1 + following, available) : target + 1 + following,
  };
}

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

export interface TranscriptPage<M> {
  messages: M[];
  has_more_messages?: boolean;
}

export async function fetchTranscriptRange<M, P extends TranscriptPage<M>>(
  fetchPage: (offset: number, limit: number) => Promise<P>,
  offset: number,
  limit: number,
  maxPerRequest: number = SESSION_MESSAGE_PAGE_MAX,
  isCurrent: () => boolean = () => true,
): Promise<P> {
  const chunk = Math.max(1, Math.trunc(maxPerRequest));
  const end = offset + Math.max(1, Math.trunc(limit));
  const messages: M[] = [];
  let position = offset;
  let page: P;
  do {
    const size = Math.min(chunk, end - position);
    page = await fetchPage(position, size);
    messages.push(...page.messages);
    position += size;
    if (page.messages.length < size || page.has_more_messages === false) {
      break;
    }
  } while (position < end && isCurrent());
  return { ...page, messages };
}
