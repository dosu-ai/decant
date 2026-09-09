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
    // Hyphens separate words as often as underscores do.
    ["claude-in-chrome", "Claude In Chrome"],
    ["linear-server", "Linear Server"],
    // A segment that already carries capitals keeps them, but still gains an
    // initial capital so it lines up with every other name in the column.
    ["dataAnalyticsWidgets", "DataAnalyticsWidgets"],
    // A generated id is not a name: word-splitting it produces hex noise.
    ["4b9d01f4-ab8b-4e2e-a545-d04b1af2fbaa", "4b9d01f4-ab8b-4e2e-a545-d04b1af2fbaa"],
    // At most one namespace prefix comes off, and a prefix-only slug has no
    // name left to show.
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
    // A plugin named after its own server would only stutter.
    ["plugin_posthog_posthog", "plugin"],
    ["plugin_vercel_vercel", "plugin"],
    // A plugin whose name the display name does not already carry earns it.
    ["plugin_my-vendor_analytics", "my-vendor plugin"],
    ["dosu", "local"],
    ["node_repl", "local"],
  ])("reports %p as %p", (raw, expected) => {
    expect(mcpServerOrigin(raw)).toBe(expected);
  });
});

describe("mcpServerLabels", () => {
  // Every collision group observed in a real archive: the same server reached
  // it as a bare `.mcp.json` id and as a connector or a plugin bundle.
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
      // Untouched: nothing else formats to these.
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
