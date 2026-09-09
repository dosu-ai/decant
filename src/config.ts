import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dbPath: string;
  claudeDir: string;
  codexDir: string;
  geminiDir: string;
}

export interface ConfigOverrides {
  dbPath?: string | null;
  claudeDir?: string | null;
  codexDir?: string | null;
  geminiDir?: string | null;
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
    geminiDir: overrides.geminiDir ?? env.DECANT_GEMINI_DIR ?? join(home, ".gemini", "tmp"),
  };
}
