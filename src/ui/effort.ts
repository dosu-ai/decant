import { normalizeReasoningEffort } from "../model.ts";

export const UNRECORDED_EFFORT_TOOLTIP =
  "The source transcript did not record an effort level, so Decant cannot recover it reliably.";

export function effortDisplayLabel(effort: string | null | undefined, labeled = false): string {
  const label = effort == null ? null : normalizeReasoningEffort(effort);
  if (label == null) {
    return "-";
  }
  const display = displayEffortLevel(label);
  return labeled && !display.startsWith("effort ") ? `effort ${display}` : display;
}

export function effortTooltip(
  effort: string | null | undefined,
  levels: readonly string[] | null | undefined,
): string | undefined {
  const normalized = effort == null ? null : normalizeReasoningEffort(effort);
  if (normalized == null) {
    return UNRECORDED_EFFORT_TOOLTIP;
  }
  if (normalized !== "mixed") {
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
