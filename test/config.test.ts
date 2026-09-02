import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";

describe("resolveConfig", () => {
  test("explicit overrides win", () => {
    const config = resolveConfig({
      dbPath: "/tmp/x.db",
      env: {
        DECANT_DB: "/env/db",
        DECANT_CLAUDE_DIR: "/env/claude",
        DECANT_CODEX_DIR: "/env/codex",
        DECANT_CURSOR_DIR: "/env/cursor",
      },
      homeDir: "/home/dev",
    });

    expect(config.dbPath).toBe("/tmp/x.db");
    expect(config.claudeDir).toBe("/env/claude");
    expect(config.codexDir).toBe("/env/codex");
    expect(config.cursorDir).toBe("/env/cursor");
  });

  test("environment overrides beat defaults", () => {
    const config = resolveConfig({
      env: {
        DECANT_DB: "/env/db",
        DECANT_CLAUDE_DIR: "/env/claude",
        DECANT_CODEX_DIR: "/env/codex",
        DECANT_CURSOR_DIR: "/env/cursor",
      },
      homeDir: "/home/dev",
    });

    expect(config).toEqual({
      dbPath: "/env/db",
      claudeDir: "/env/claude",
      codexDir: "/env/codex",
      cursorDir: "/env/cursor",
    });
  });

  test("defaults point into home", () => {
    const config = resolveConfig({ env: {}, homeDir: "/home/dev" });
    expect(config.dbPath).toBe("/home/dev/.decant/decant.db");
    expect(config.claudeDir).toBe("/home/dev/.claude/projects");
    expect(config.codexDir).toBe("/home/dev/.codex");
    expect(config.cursorDir).toBe("/home/dev/.cursor/chats");
  });
});
