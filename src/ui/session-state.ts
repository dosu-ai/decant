export type SessionStateUpdate = "archived" | "deleted" | "visible";

export interface SessionArchiveView {
  user_state: "archived" | null;
  is_user_archived: boolean;
}

export const DELETE_SESSION_EXPLANATION =
  "This permanently removes this session and its subagent transcripts from the Decant archive. " +
  "The source JSONL files on disk are not changed. A deletion tombstone prevents future syncs " +
  "from restoring these sessions.";

export function archiveActionFor(
  session: SessionArchiveView,
): Extract<SessionStateUpdate, "archived" | "visible"> | null {
  if (session.user_state === "archived") {
    return "visible";
  }
  return session.is_user_archived ? null : "archived";
}

export function sessionStateRequest(
  id: number,
  state: SessionStateUpdate,
): { path: string; init: RequestInit } {
  return {
    path: `/api/sessions/${id}/state`,
    init: {
      method: "POST",
      body: JSON.stringify({ state }),
    },
  };
}
