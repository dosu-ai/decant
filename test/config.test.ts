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
      },
      homeDir: "/home/dev",
    });

    expect(config.dbPath).toBe("/tmp/x.db");
    expect(config.claudeDir).toBe("/env/claude");
    expect(config.codexDir).toBe("/env/codex");
    expect(config.geminiDir).toBe("/env/gemini");
    expect(config.opencodeDir).toBe("/flag/opencode");
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
      },
      homeDir: "/home/dev",
    });

    expect(config).toEqual({
      dbPath: "/env/db",
      claudeDir: "/env/claude",
      codexDir: "/env/codex",
      geminiDir: "/env/gemini",
      opencodeDir: "/env/opencode",
      opencodeConfigPath: "/env/opencode.json",
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
    expect(config.opencodeConfigPath).toBe("/home/dev/.config/opencode/opencode.json");
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
    expect(xdg.opencodeConfigPath).toBe("/xdgc/opencode/opencode.json");
    const explicit = resolveConfig({
      env: { OPENCODE_DB: "/oc/custom.db", OPENCODE_CONFIG: "/oc/cfg.json" },
      homeDir: "/h",
    });
    expect(explicit.opencodeDb).toBe("/oc/custom.db");
    expect(explicit.opencodeConfigPath).toBe("/oc/cfg.json");
    // Empty values behave like unset ones.
    expect(resolveConfig({ env: { OPENCODE_DB: "" }, homeDir: "/h" }).opencodeDb).toBeUndefined();
  });
});
