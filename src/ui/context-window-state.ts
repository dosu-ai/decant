export type ContextWindowDisplayMode = "hidden" | "unavailable" | "chart";

export interface ContextWindowDisplayInput {
  window_tokens: number | null;
  points: readonly unknown[];
}

export interface CacheMissPoint {
  cache_read_tokens: number;
  context_tokens: number;
  seq: number;
}

export interface CacheMissCompaction {
  seq: number;
}

export function isFullCacheMiss(
  points: readonly CacheMissPoint[],
  index: number,
  compactions: readonly CacheMissCompaction[],
): boolean {
  const point = points[index];
  if (
    point == null ||
    index === 0 ||
    point.cache_read_tokens !== 0 ||
    point.context_tokens <= 20_000
  ) {
    return false;
  }
  const previousCompaction = [...compactions]
    .filter((compaction) => compaction.seq < point.seq)
    .sort((a, b) => b.seq - a.seq)[0];
  if (previousCompaction == null) {
    return true;
  }
  const firstAfterCompaction = points.findIndex(
    (candidate) => candidate.seq > previousCompaction.seq,
  );
  return firstAfterCompaction !== index;
}

export function contextWindowDisplayMode(
  timeline: ContextWindowDisplayInput | null,
): ContextWindowDisplayMode {
  if (timeline == null) {
    return "hidden";
  }
  if (timeline.window_tokens == null || timeline.points.length === 0) {
    return "unavailable";
  }
  return "chart";
}
