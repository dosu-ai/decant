import { describe, expect, test } from "bun:test";
import { CONFIRMED_DOSU_SERVER_IDS, isDosuServer } from "../src/dosu.ts";

describe("Dosu MCP evidence", () => {
  test("uses only the confirmed normalized server IDs", () => {
    expect(CONFIRMED_DOSU_SERVER_IDS).toEqual(["dosu", "claude_ai_Dosu"]);
    expect(isDosuServer("dosu")).toBe(true);
    expect(isDosuServer("claude_ai_Dosu")).toBe(true);
  });

  test("does not accept broad name matches or missing server evidence", () => {
    expect(isDosuServer("my-dosu-proxy")).toBe(false);
    expect(isDosuServer("Dosu")).toBe(false);
    expect(isDosuServer(null)).toBe(false);
  });
});
