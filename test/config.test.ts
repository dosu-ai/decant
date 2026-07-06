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
        DECANT_CURSOR_CHATS_DIR: "/env/cursor-projects",
      },
      homeDir: "/home/dev",
      cursorDir: "/tmp/cursor",
      cursorChatsDir: "/tmp/cursor-projects",
      cursorChatsEnabled: true,
    });

    expect(config.dbPath).toBe("/tmp/x.db");
    expect(config.claudeDir).toBe("/env/claude");
    expect(config.codexDir).toBe("/env/codex");
    expect(config.cursorDir).toBe("/tmp/cursor");
    expect(config.cursorChatsDir).toBe("/tmp/cursor-projects");
    expect(config.cursorChatsEnabled).toBe(true);
  });

  test("environment overrides beat defaults", () => {
    const config = resolveConfig({
      env: {
        DECANT_DB: "/env/db",
        DECANT_CLAUDE_DIR: "/env/claude",
        DECANT_CODEX_DIR: "/env/codex",
        DECANT_CURSOR_DIR: "/env/cursor",
        DECANT_CURSOR_CHATS_DIR: "/env/cursor-projects",
      },
      homeDir: "/home/dev",
    });

    expect(config).toEqual({
      dbPath: "/env/db",
      claudeDir: "/env/claude",
      codexDir: "/env/codex",
      cursorDir: "/env/cursor",
      cursorChatsDir: "/env/cursor-projects",
      cursorChatsEnabled: false,
    });
  });

  test("defaults point into home", () => {
    const config = resolveConfig({ env: {}, homeDir: "/home/dev" });
    expect(config.dbPath).toBe("/home/dev/.decant/decant.db");
    expect(config.claudeDir).toBe("/home/dev/.claude/projects");
    expect(config.codexDir).toBe("/home/dev/.codex");
    expect(config.cursorDir).toBeNull();
    expect(config.cursorChatsDir).toBe("/home/dev/.cursor");
    expect(config.cursorChatsEnabled).toBe(false);
  });
});
