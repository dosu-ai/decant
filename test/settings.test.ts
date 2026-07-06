import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectedSettings,
  getSettings,
  saveSettings,
  settingsPath,
  terminalOptions,
} from "../src/settings.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-settings-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("settings", () => {
  test("path honors DECANT_CONFIG_DIR and detected defaults use the environment", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "cfg"), TERM_PROGRAM: "iTerm.app" };
    expect(settingsPath({ env })).toBe(join(workDir, "cfg", "settings.json"));
    expect(
      detectedSettings({
        env,
        appExists: (name) => name === "Cursor",
      }),
    ).toEqual({
      agent: "claude",
      terminal: "iterm",
      ide: "cursor",
      experimental: { cursorChats: false },
    });
  });

  test("Warp is detected and exposed as a terminal choice", () => {
    expect(terminalOptions).toContainEqual(["warp", "Warp"]);
    expect(detectedSettings({ env: { TERM_PROGRAM: "WarpTerminal" } }).terminal).toBe("warp");
  });

  test("saveSettings persists sanitized values over detected defaults", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "save"), TERM: "xterm-kitty" };
    const saved = saveSettings(
      {
        agent: "codex",
        terminal: "ghostty",
        ide: "zed",
        experimental: { cursorChats: true },
        unknown: "ignored",
      },
      { env, appExists: () => false },
    );
    expect(saved).toEqual({
      agent: "codex",
      terminal: "ghostty",
      ide: "zed",
      experimental: { cursorChats: true },
    });
    expect(JSON.parse(readFileSync(settingsPath({ env }), "utf8"))).toEqual({
      agent: "codex",
      terminal: "ghostty",
      ide: "zed",
      experimental: { cursorChats: true },
    });

    const merged = saveSettings({ agent: "nope", terminal: "wezterm" }, { env });
    expect(merged).toMatchObject({
      agent: "codex",
      terminal: "wezterm",
      ide: "zed",
      experimental: { cursorChats: true },
    });
    expect(getSettings({ env }).terminal).toBe("wezterm");
  });
});
