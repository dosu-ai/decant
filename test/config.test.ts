import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
  test("explicit overrides win", () => {
    const config = resolveConfig({
      dbPath: "/tmp/x.db",
      opencodeDir: "/flag/opencode",
      env: {
        DECANT_DB: "/env/db",
        DECANT_CLAUDE_DIR: "/env/claude",
        DECANT_CODEX_DIR: "/env/codex",
        DECANT_GEMINI_DIR: "/env/gemini",
        DECANT_OPENCODE_DIR: "/env/opencode",
        DECANT_CURSOR_DIR: "/env/cursor",
        DECANT_COPILOT_DIR: "/env/copilot",
        DECANT_VSCODE_COPILOT_DIR: "/env/vscode",
      },
      homeDir: "/home/dev",
    });

    expect(config.dbPath).toBe("/tmp/x.db");
    expect(config.claudeDir).toBe("/env/claude");
    expect(config.codexDir).toBe("/env/codex");
    expect(config.geminiDir).toBe("/env/gemini");
    expect(config.opencodeDir).toBe("/flag/opencode");
    expect(config.cursorDir).toBe("/env/cursor");
    expect(config.copilotDir).toBe("/env/copilot");
    expect(config.vscodeCopilotDir).toBe("/env/vscode");
    expect(config.vscodeCopilotInsidersDir).toBeUndefined();
  });

  test("environment overrides beat defaults", () => {
    const config = resolveConfig({
      env: {
        DECANT_DB: "/env/db",
        DECANT_CLAUDE_DIR: "/env/claude",
        DECANT_CODEX_DIR: "/env/codex",
        DECANT_GEMINI_DIR: "/env/gemini",
        DECANT_OPENCODE_DIR: "/env/opencode",
        DECANT_OPENCODE_CONFIG: "/env/opencode.json",
        DECANT_CURSOR_DIR: "/env/cursor",
        DECANT_COPILOT_DIR: "/env/copilot",
        DECANT_VSCODE_COPILOT_DIR: "/env/vscode",
        DECANT_ATIF_DIR: "/env/atif",
        DECANT_HERMES_DIR: "/env/hermes",
      },
      homeDir: "/home/dev",
    });

    expect(config).toEqual({
      dbPath: "/env/db",
      claudeDir: "/env/claude",
      codexDir: "/env/codex",
      geminiDir: "/env/gemini",
      opencodeDir: "/env/opencode",
      opencodeConfigDir: "/home/dev/.config/opencode",
      opencodeConfigPath: "/env/opencode.json",
      opencodeModelsPath: "/home/dev/.cache/opencode/models.json",
      cursorDir: "/env/cursor",
      copilotDir: "/env/copilot",
      vscodeCopilotDir: "/env/vscode",
      atifDir: "/env/atif",
      hermesDir: "/env/hermes",
    });
  });

  test("defaults point into home", () => {
    const config = resolveConfig({ env: {}, homeDir: "/home/dev" });
    expect(config.dbPath).toBe("/home/dev/.decant/decant.db");
    expect(config.claudeDir).toBe("/home/dev/.claude/projects");
    expect(config.codexDir).toBe("/home/dev/.codex");
    expect(config.geminiDir).toBe("/home/dev/.gemini/tmp");
    expect(config.opencodeDir).toBe("/home/dev/.local/share/opencode");
    expect(config.opencodeDb).toBeUndefined();
    expect(config.opencodeConfigDir).toBe("/home/dev/.config/opencode");
    expect(config.opencodeConfigPath).toBeUndefined();
    expect(config.opencodeExtraConfigPath).toBeUndefined();
    expect(config.opencodeModelsPath).toBe("/home/dev/.cache/opencode/models.json");
    expect(config.cursorDir).toBe("/home/dev/.cursor/chats");
    expect(config.copilotDir).toBe("/home/dev/.copilot/session-state");
    expect(config.atifDir).toBe("/home/dev/.decant/atif");
    expect(config.hermesDir).toBe("/home/dev/.hermes");
  });

  test("reads VS Code and VS Code Insiders from each platform's user data directory", () => {
    const at = (platform: NodeJS.Platform, env: Record<string, string> = {}) => {
      const config = resolveConfig({ env, homeDir: "/h", platform });
      return [config.vscodeCopilotDir, config.vscodeCopilotInsidersDir];
    };
    expect(at("darwin")).toEqual([
      "/h/Library/Application Support/Code/User",
      "/h/Library/Application Support/Code - Insiders/User",
    ]);
    expect(at("linux")).toEqual(["/h/.config/Code/User", "/h/.config/Code - Insiders/User"]);
    expect(at("linux", { XDG_CONFIG_HOME: "/xdg" })).toEqual([
      "/xdg/Code/User",
      "/xdg/Code - Insiders/User",
    ]);
    expect(at("win32", { APPDATA: "/appdata" })).toEqual([
      "/appdata/Code/User",
      "/appdata/Code - Insiders/User",
    ]);
    expect(at("win32")).toEqual([
      "/h/AppData/Roaming/Code/User",
      "/h/AppData/Roaming/Code - Insiders/User",
    ]);
  });

  test("one VS Code override replaces both default directories", () => {
    const flag = resolveConfig({
      vscodeCopilotDir: "/flag/User",
      env: { DECANT_VSCODE_COPILOT_DIR: "/env/User" },
      homeDir: "/h",
      platform: "darwin",
    });
    expect(flag.vscodeCopilotDir).toBe("/flag/User");
    expect(flag.vscodeCopilotInsidersDir).toBeUndefined();
    const env = resolveConfig({ env: { DECANT_VSCODE_COPILOT_DIR: "" }, homeDir: "/h" });
    expect(env.vscodeCopilotInsidersDir).toBeDefined();
  });

  test("follows HERMES_HOME and Hermes's platform default for the Hermes Agent home", () => {
    const at = (env: Record<string, string>, platform: NodeJS.Platform = "linux") =>
      resolveConfig({ env, homeDir: "/h", platform }).hermesDir;
    expect(at({ HERMES_HOME: "/hh" })).toBe("/hh");
    expect(at({ HERMES_HOME: "/hh", DECANT_HERMES_DIR: "/d" })).toBe("/d");
    expect(at({ HERMES_HOME: "" })).toBe("/h/.hermes");
    expect(at({}, "darwin")).toBe("/h/.hermes");
    expect(at({ LOCALAPPDATA: "/local" }, "win32")).toBe("/local/hermes");
    expect(at({}, "win32")).toBe("/h/AppData/Local/hermes");
    expect(
      resolveConfig({ hermesDir: "/flag", env: { DECANT_HERMES_DIR: "/d" }, homeDir: "/h" })
        .hermesDir,
    ).toBe("/flag");
  });

  test("follows COPILOT_HOME for the Copilot CLI session state", () => {
    expect(resolveConfig({ env: { COPILOT_HOME: "/cp" }, homeDir: "/h" }).copilotDir).toBe(
      "/cp/session-state",
    );
    expect(
      resolveConfig({ env: { COPILOT_HOME: "/cp", DECANT_COPILOT_DIR: "/d" }, homeDir: "/h" })
        .copilotDir,
    ).toBe("/d");
    expect(resolveConfig({ env: { COPILOT_HOME: "" }, homeDir: "/h" }).copilotDir).toBe(
      "/h/.copilot/session-state",
    );
  });

  test("follows OpenCode's own environment before XDG and home", () => {
    expect(
      resolveConfig({
        env: { OPENCODE_DATA_DIR: "/oc/data", XDG_DATA_HOME: "/xdg" },
        homeDir: "/h",
      }).opencodeDir,
    ).toBe("/oc/data");
    const xdg = resolveConfig({
      env: { XDG_DATA_HOME: "/xdg", XDG_CONFIG_HOME: "/xdgc" },
      homeDir: "/h",
    });
    expect(xdg.opencodeDir).toBe("/xdg/opencode");
    expect(xdg.opencodeConfigDir).toBe("/xdgc/opencode");
    const explicit = resolveConfig({
      env: {
        OPENCODE_DB: "/oc/custom.db",
        OPENCODE_CONFIG: "/oc/cfg.json",
        OPENCODE_CONFIG_DIR: "/oc/config",
        XDG_CONFIG_HOME: "/xdgc",
      },
      homeDir: "/h",
    });
    expect(explicit.opencodeDb).toBe("/oc/custom.db");
    // OPENCODE_CONFIG_DIR relocates the global directory, as it does for
    // OpenCode; OPENCODE_CONFIG is an extra file, not a replacement for it.
    expect(explicit.opencodeConfigDir).toBe("/oc/config");
    expect(explicit.opencodeExtraConfigPath).toBe("/oc/cfg.json");
    expect(explicit.opencodeConfigPath).toBeUndefined();
    const decant = resolveConfig({
      env: { DECANT_OPENCODE_CONFIG: "/d/cfg.json", OPENCODE_CONFIG: "/oc/cfg.json" },
      homeDir: "/h",
    });
    expect(decant.opencodeConfigPath).toBe("/d/cfg.json");
    expect(decant.opencodeExtraConfigPath).toBe("/oc/cfg.json");
    // OpenCode 1.x caches the models.dev catalog in its cache directory,
    // and reads OPENCODE_MODELS_PATH instead when it is set.
    expect(
      resolveConfig({ env: { XDG_CACHE_HOME: "/xc" }, homeDir: "/h" }).opencodeModelsPath,
    ).toBe("/xc/opencode/models.json");
    expect(
      resolveConfig({
        env: { OPENCODE_MODELS_PATH: "/m.json", XDG_CACHE_HOME: "/xc" },
        homeDir: "/h",
      }).opencodeModelsPath,
    ).toBe("/m.json");
    // Empty values behave like unset ones.
    expect(resolveConfig({ env: { OPENCODE_DB: "" }, homeDir: "/h" }).opencodeDb).toBeUndefined();
    expect(
      resolveConfig({ env: { OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: "" }, homeDir: "/h" }),
    ).toMatchObject({ opencodeConfigDir: "/h/.config/opencode" });
  });
});
