/** Label for the session-detail header badge that surfaces ingest diagnostics
 * recorded against a session's source file. */
export function formatIssueBadge(count: number): string {
  return `${count} ingest issue${count === 1 ? "" : "s"}`;
}
