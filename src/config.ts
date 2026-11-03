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
  /** OpenCode's global config directory, whose `opencode.json` and
   * `opencode.jsonc` name the MCP servers OpenCode prefixes tool names with:
   * `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`. Ingest also reads
   * each session's project configs. */
  opencodeConfigDir?: string;
  /** `DECANT_OPENCODE_CONFIG`: one file read in place of the global
   * directory's files. */
  opencodeConfigPath?: string;
  /** `OPENCODE_CONFIG`: an extra file OpenCode loads in addition to the global
   * and project configs, so Decant reads it in addition too. */
  opencodeExtraConfigPath?: string;
  /** OpenCode 1.x's models.dev cache, read for context windows when a
   * database has no catalog of its own: `OPENCODE_MODELS_PATH`, else
   * `$XDG_CACHE_HOME/opencode/models.json`. */
  opencodeModelsPath?: string;
  cursorDir: string;
}

export interface ConfigOverrides {
  dbPath?: string | null;
  claudeDir?: string | null;
  codexDir?: string | null;
  geminiDir?: string | null;
  opencodeDir?: string | null;
  cursorDir?: string | null;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
}

export function resolveConfig(overrides: ConfigOverrides = {}): Config {
  const env = overrides.env ?? process.env;
  const home = (overrides.homeDir ?? homedir()) || ".";
  const xdgData = nonEmpty(env.XDG_DATA_HOME);
  const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME);
  const xdgCache = nonEmpty(env.XDG_CACHE_HOME);
  const opencodeDb = nonEmpty(env.OPENCODE_DB);
  const opencodeConfigPath = nonEmpty(env.DECANT_OPENCODE_CONFIG);
  const opencodeExtraConfigPath = nonEmpty(env.OPENCODE_CONFIG);
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
    // OpenCode resolves its global config directory the same way.
    opencodeConfigDir:
      nonEmpty(env.OPENCODE_CONFIG_DIR) ?? join(xdgConfig ?? join(home, ".config"), "opencode"),
    ...(opencodeConfigPath == null ? {} : { opencodeConfigPath }),
    ...(opencodeExtraConfigPath == null ? {} : { opencodeExtraConfigPath }),
    // Where OpenCode 1.x keeps it (packages/core/src/models-dev.ts), read-only.
    opencodeModelsPath:
      nonEmpty(env.OPENCODE_MODELS_PATH) ??
      join(xdgCache ?? join(home, ".cache"), "opencode", "models.json"),
    cursorDir: overrides.cursorDir ?? env.DECANT_CURSOR_DIR ?? join(home, ".cursor", "chats"),
  };
}

function nonEmpty(value: string | undefined): string | null {
  return value == null || value === "" ? null : value;
}
