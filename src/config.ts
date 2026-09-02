import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dbPath: string;
  claudeDir: string;
  codexDir: string;
  cursorDir: string;
}

export interface ConfigOverrides {
  dbPath?: string | null;
  claudeDir?: string | null;
  codexDir?: string | null;
  cursorDir?: string | null;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
}

export function resolveConfig(overrides: ConfigOverrides = {}): Config {
  const env = overrides.env ?? process.env;
  const home = (overrides.homeDir ?? homedir()) || ".";
  return {
    dbPath: overrides.dbPath ?? env.DECANT_DB ?? join(home, ".decant", "decant.db"),
    claudeDir: overrides.claudeDir ?? env.DECANT_CLAUDE_DIR ?? join(home, ".claude", "projects"),
    codexDir: overrides.codexDir ?? env.DECANT_CODEX_DIR ?? join(home, ".codex"),
    cursorDir: overrides.cursorDir ?? env.DECANT_CURSOR_DIR ?? join(home, ".cursor", "chats"),
  };
}
