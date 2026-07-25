import { normalizeReasoningEffort } from "../model.ts";

export function effortDisplayLabel(
  effort: string | null | undefined,
  labeled = false,
): string | null {
  const label = effort == null ? null : normalizeReasoningEffort(effort);
  if (label == null) {
    return null;
  }
  const display = displayEffortLevel(label);
  return labeled && !display.startsWith("effort ") ? `effort ${display}` : display;
}

export function effortTooltip(
  effort: string | null | undefined,
  levels: readonly string[] | null | undefined,
): string | undefined {
  if (effort == null || normalizeReasoningEffort(effort) !== "mixed") {
    return undefined;
  }
  const mixedLevels = Array.from(
    new Set(
      (levels ?? [])
        .map(normalizeReasoningEffort)
        .filter((level): level is string => level != null && level !== "mixed"),
    ),
  );
  return mixedLevels.length > 0
    ? `Effort levels used: ${mixedLevels.map(displayEffortLevel).join(", ")}`
    : undefined;
}

function displayEffortLevel(level: string): string {
  return /^\d+(?:\.\d+)?$/.test(level) ? `${level} tokens` : level;
}
