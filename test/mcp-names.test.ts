import { describe, expect, test } from "bun:test";
import {
  formatMcpServer,
  mcpServerLabel,
  mcpServerLabels,
  mcpServerOrigin,
} from "../src/mcp-names.ts";

describe("formatMcpServer", () => {
  test.each([
    ["claude_ai_Dosu", "Dosu"],
    ["claude_ai_Slack", "Slack"],
    ["claude_ai_Google_Drive", "Google Drive"],
    ["plugin_vercel_vercel", "Vercel"],
    ["plugin_posthog_posthog", "Posthog"],
    ["plugin_my-vendor_analytics", "Analytics"],
    ["dosu", "Dosu"],
    ["some_raw_server", "Some Raw Server"],
    ["claude-in-chrome", "Claude In Chrome"],
    ["linear-server", "Linear Server"],
    ["dataAnalyticsWidgets", "DataAnalyticsWidgets"],
    ["4b9d01f4-ab8b-4e2e-a545-d04b1af2fbaa", "4b9d01f4-ab8b-4e2e-a545-d04b1af2fbaa"],
    ["claude_ai_", ""],
    [null, ""],
    [undefined, ""],
    ["", ""],
  ])("formats %p as %p", (raw, expected) => {
    expect(formatMcpServer(raw)).toBe(expected);
  });
});

describe("mcpServerOrigin", () => {
  test.each([
    ["claude_ai_Dosu", "connector"],
    ["plugin_posthog_posthog", "plugin"],
    ["plugin_vercel_vercel", "plugin"],
    ["plugin_my-vendor_analytics", "my-vendor plugin"],
    ["dosu", "local"],
    ["node_repl", "local"],
  ])("reports %p as %p", (raw, expected) => {
    expect(mcpServerOrigin(raw)).toBe(expected);
  });
});

describe("mcpServerLabels", () => {
  test("disambiguates names shared by two registrations, and only those", () => {
    const labels = mcpServerLabels([
      "dosu",
      "claude_ai_Dosu",
      "posthog",
      "plugin_posthog_posthog",
      "codex_apps",
      "playwright",
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      dosu: "Dosu (local)",
      claude_ai_Dosu: "Dosu (connector)",
      posthog: "Posthog (local)",
      plugin_posthog_posthog: "Posthog (plugin)",
      codex_apps: "Codex Apps",
      playwright: "Playwright",
    });
  });

  test("never leaves two distinct slugs sharing a label", () => {
    const raws = [
      "dosu",
      "claude_ai_Dosu",
      "exa",
      "claude_ai_Exa",
      "linear",
      "claude_ai_Linear",
      "linear-server",
      "context7",
      "plugin_context7_context7",
    ];
    const labels = mcpServerLabels(raws);
    expect(new Set(labels.values()).size).toBe(raws.length);
  });

  test("the same slug repeated is not a collision with itself", () => {
    expect(mcpServerLabels(["dosu", "dosu", "dosu"]).get("dosu")).toBe("Dosu");
  });

  test("skips empty and missing slugs", () => {
    const labels = mcpServerLabels(["dosu", null, undefined, ""]);
    expect(Object.fromEntries(labels)).toEqual({ dosu: "Dosu" });
  });
});

describe("mcpServerLabel", () => {
  const labels = mcpServerLabels(["dosu", "claude_ai_Dosu"]);

  test("prefers the disambiguated label", () => {
    expect(mcpServerLabel(labels, "claude_ai_Dosu")).toBe("Dosu (connector)");
  });

  test("falls back to the short name for a slug outside the set", () => {
    expect(mcpServerLabel(labels, "claude_ai_Slack")).toBe("Slack");
  });

  test("renders nothing for a missing slug", () => {
    expect(mcpServerLabel(labels, null)).toBe("");
    expect(mcpServerLabel(labels, "")).toBe("");
  });
});
