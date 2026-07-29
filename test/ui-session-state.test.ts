import { describe, expect, test } from "bun:test";
import {
  archiveActionFor,
  DELETE_SESSION_EXPLANATION,
  sessionStateRequest,
} from "../src/ui/session-state.ts";

describe("session state UI", () => {
  test("offers archive, direct unarchive, or no-op for inherited archive state", () => {
    expect(archiveActionFor({ user_state: null, is_user_archived: false })).toBe("archived");
    expect(archiveActionFor({ user_state: "archived", is_user_archived: true })).toBe("visible");
    expect(archiveActionFor({ user_state: null, is_user_archived: true })).toBeNull();
  });

  test("builds the local state mutation request", () => {
    expect(sessionStateRequest(42, "deleted")).toEqual({
      path: "/api/sessions/42/state",
      init: {
        method: "POST",
        body: '{"state":"deleted"}',
      },
    });
  });

  test("delete confirmation distinguishes archive data from source files and sync behavior", () => {
    expect(DELETE_SESSION_EXPLANATION).toContain("Decant archive");
    expect(DELETE_SESSION_EXPLANATION).toContain("source JSONL files on disk are not changed");
    expect(DELETE_SESSION_EXPLANATION).toContain("future syncs from restoring");
  });
});
