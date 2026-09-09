import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectedSettings, getSettings, saveSettings, settingsPath } from "../src/settings.ts";

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
    });
  });

  test("detects Warp and exposes it as a persisted terminal option", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "warp"), TERM_PROGRAM: "WarpTerminal" };
    expect(detectedSettings({ env, appExists: () => false }).terminal).toBe("warp");
    expect(saveSettings({ terminal: "warp" }, { env }).terminal).toBe("warp");
  });

  test("an unrelated save prunes a stale Dosu suggestions preference", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "stale") };
    const path = settingsPath({ env });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ agent: "codex", dosuSuggestions: "hide" }, null, 2)}\n`,
    );

    expect(saveSettings({ terminal: "wezterm" }, { env, appExists: () => false })).toEqual({
      agent: "codex",
      terminal: "wezterm",
      ide: "vscode",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      agent: "codex",
      terminal: "wezterm",
    });
  });

  test("saveSettings persists sanitized values over detected defaults", () => {
    const env = { DECANT_CONFIG_DIR: join(workDir, "save"), TERM: "xterm-kitty" };
    const saved = saveSettings(
      {
        agent: "codex",
        terminal: "ghostty",
        ide: "zed",
        // Removed preferences from older settings files are pruned on save.
        dosuSuggestions: "hide",
        unknown: "ignored",
      },
      { env, appExists: () => false },
    );
    expect(saved).toEqual({
      agent: "codex",
      terminal: "ghostty",
      ide: "zed",
    });
    expect(JSON.parse(readFileSync(settingsPath({ env }), "utf8"))).toEqual({
      agent: "codex",
      terminal: "ghostty",
      ide: "zed",
    });

    const merged = saveSettings({ agent: "nope", terminal: "wezterm" }, { env });
    expect(merged).toMatchObject({
      agent: "codex",
      terminal: "wezterm",
      ide: "zed",
    });
    expect(getSettings({ env }).terminal).toBe("wezterm");
  });
});
