import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dbPath: string;
  claudeDir: string;
  codexDir: string;
  geminiDir: string;
  /** OpenCode data directory: `opencode.db` plus channel variants
   * `opencode-<channel>.db`. */
  opencodeDir: string;
  /** Explicit OpenCode database file from `OPENCODE_DB`; present only when
   * that variable is set. Read in addition to `opencodeDir`. */
  opencodeDb?: string;
  /** Global `opencode.json`, whose `mcp` section names the MCP servers
   * OpenCode prefixes tool names with. Ingest also reads the `opencode.jsonc`
   * beside it and each session directory's project configs. */
  opencodeConfigPath?: string;
}

export interface ConfigOverrides {
  dbPath?: string | null;
  claudeDir?: string | null;
  codexDir?: string | null;
  geminiDir?: string | null;
  opencodeDir?: string | null;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
}

export function resolveConfig(overrides: ConfigOverrides = {}): Config {
  const env = overrides.env ?? process.env;
  const home = (overrides.homeDir ?? homedir()) || ".";
  const xdgData = nonEmpty(env.XDG_DATA_HOME);
  const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME);
  const opencodeDb = nonEmpty(env.OPENCODE_DB);
  return {
    dbPath: overrides.dbPath ?? env.DECANT_DB ?? join(home, ".decant", "decant.db"),
    claudeDir: overrides.claudeDir ?? env.DECANT_CLAUDE_DIR ?? join(home, ".claude", "projects"),
    codexDir: overrides.codexDir ?? env.DECANT_CODEX_DIR ?? join(home, ".codex"),
    geminiDir: overrides.geminiDir ?? env.DECANT_GEMINI_DIR ?? join(home, ".gemini", "tmp"),
    // OpenCode's own variables come after Decant's so a user who relocated
    // OpenCode's data is found without extra configuration.
    opencodeDir:
      overrides.opencodeDir ??
      nonEmpty(env.DECANT_OPENCODE_DIR) ??
      nonEmpty(env.OPENCODE_DATA_DIR) ??
      (xdgData == null ? join(home, ".local", "share", "opencode") : join(xdgData, "opencode")),
    ...(opencodeDb == null ? {} : { opencodeDb }),
    opencodeConfigPath:
      nonEmpty(env.DECANT_OPENCODE_CONFIG) ??
      nonEmpty(env.OPENCODE_CONFIG) ??
      join(xdgConfig ?? join(home, ".config"), "opencode", "opencode.json"),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value == null || value === "" ? null : value;
}
