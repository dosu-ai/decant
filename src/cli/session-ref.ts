import type { Database } from "bun:sqlite";
import { findSessionsByRef, type SessionRefMatch } from "../query.ts";

export type SessionRefResolution =
  | { ok: true; id: number }
  | { ok: false; code: 1 | 2; message: string };

/**
 * Resolve what a user typed for a session: Decant's id, or the id the source
 * tool uses when exactly one session carries it.
 */
export function resolveSessionRef(db: Database, ref: string): SessionRefResolution {
  const { byId, bySourceId } = findSessionsByRef(db, ref);
  // Decant's id wins, so an integer keeps naming the session it always named.
  if (byId != null) {
    return { ok: true, id: byId.id };
  }
  const [only] = bySourceId;
  if (bySourceId.length === 1 && only != null) {
    return { ok: true, id: only.id };
  }
  if (bySourceId.length > 1) {
    return { ok: false, code: 2, message: ambiguousMessage(ref, bySourceId) };
  }
  return {
    ok: false,
    code: 1,
    message: /^\s*\d+\s*$/.test(ref)
      ? `no session with id ${ref.trim()}`
      : `no session with id or source session id ${JSON.stringify(ref)}`,
  };
}

function ambiguousMessage(ref: string, matches: SessionRefMatch[]): string {
  const rows = matches.map(
    (match) => `  ${match.id}\t${match.tool}\t${match.started_at ?? "unknown start"}`,
  );
  return [
    `source session id ${JSON.stringify(ref)} matches ${matches.length} sessions. ` +
      "Pass one of these ids instead (id, tool, started):",
    ...rows,
  ].join("\n");
}
