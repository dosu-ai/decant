export function effortTooltip(
  effort: string | null | undefined,
  levels: readonly string[] | null | undefined,
): string | undefined {
  if (effort?.trim().toLowerCase() !== "mixed") {
    return undefined;
  }
  const mixedLevels = Array.from(
    new Set(
      (levels ?? [])
        .map((level) => level.trim().toLowerCase())
        .filter((level) => level !== "" && level !== "mixed"),
    ),
  );
  return mixedLevels.length > 0 ? `Effort levels used: ${mixedLevels.join(", ")}` : undefined;
}
