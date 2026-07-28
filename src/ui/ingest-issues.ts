/** Label for the session-detail header badge that surfaces ingest diagnostics
 * recorded against a session's source file. */
export function formatIssueBadge(count: number): string {
  return `${count} ingest issue${count === 1 ? "" : "s"}`;
}

const UNKNOWN_RECORD_TYPE = /unknown record type "([^"]+)"/i;

export function unknownRecordTypeSummary(errors: string[]): {
  count: number;
  types: string[];
} {
  const types = [
    ...new Set(
      errors
        .map((error) => error.match(UNKNOWN_RECORD_TYPE)?.[1]?.trim() ?? "")
        .filter((type) => type !== ""),
    ),
  ];
  return { count: errors.length, types };
}
