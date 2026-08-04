import { describe, expect, test } from "bun:test";
import { formatMcpServer } from "../src/ui/mcp-server.ts";

describe("formatMcpServer", () => {
  test.each([
    ["claude_ai_Dosu", "Dosu"],
    ["claude_ai_Slack", "Slack"],
    ["plugin_vercel_vercel", "Vercel"],
    ["plugin_posthog_posthog", "Posthog"],
    ["plugin_my-vendor_analytics", "Analytics"],
    ["dosu", "Dosu"],
    ["some_raw_server", "Some Raw Server"],
    ["claude_ai_", ""],
    [null, ""],
    [undefined, ""],
    ["", ""],
  ])("formats %p as %p", (raw, expected) => {
    expect(formatMcpServer(raw)).toBe(expected);
  });
});
