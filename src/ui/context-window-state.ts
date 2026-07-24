export type ContextWindowDisplayMode = "hidden" | "unavailable" | "chart";

export interface ContextWindowDisplayInput {
  window_tokens: number | null;
  points: readonly unknown[];
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
