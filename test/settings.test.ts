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
    ).toEqual({ agent: "claude", terminal: "iterm", ide: "cursor" });
  });

  test("saveSettings persists sanitized values over detected defaults", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "save"), TERM: "xterm-kitty" };
    const saved = saveSettings(
      {
        agent: "codex",
        terminal: "ghostty",
        ide: "zed",
        unknown: "ignored",
      },
      { env, appExists: () => false },
    );
    expect(saved).toEqual({ agent: "codex", terminal: "ghostty", ide: "zed" });
    expect(JSON.parse(readFileSync(settingsPath({ env }), "utf8"))).toEqual({
      agent: "codex",
      terminal: "ghostty",
      ide: "zed",
    });

    const merged = saveSettings({ agent: "nope", terminal: "wezterm" }, { env });
    expect(merged).toMatchObject({ agent: "codex", terminal: "wezterm", ide: "zed" });
    expect(getSettings({ env }).terminal).toBe("wezterm");
  });

  test("detects Warp from TERM_PROGRAM and accepts it as a saved value", () => {
    const detected = detectedSettings({
      env: { TERM_PROGRAM: "WarpTerminal" },
      appExists: () => false,
    });
    expect(detected.terminal).toBe("warp");
    expect(terminalOptions.map(([key]) => key)).toContain("warp");
  });

  test("saveSettings round-trips Warp terminal through getSettings", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "warp") };
    const saved = saveSettings(
      {
        agent: "claude",
        terminal: "warp",
        ide: "vscode",
      },
      { env, appExists: () => false },
    );
    expect(saved.terminal).toBe("warp");
    const loaded = getSettings({ env });
    expect(loaded.terminal).toBe("warp");
  });
});
