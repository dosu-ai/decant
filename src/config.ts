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
  /** GitHub Copilot CLI session-state directory: one `<session id>/events.jsonl`
   * per session. */
  copilotDir: string;
  /** VS Code's `User` directory, whose workspace and global storage hold
   * Copilot Chat sessions. */
  vscodeCopilotDir: string;
  /** VS Code Insiders' `User` directory, read beside the stable one. Present
   * only when no override names a single directory. */
  vscodeCopilotInsidersDir?: string;
  /** ATIF trajectory files, such as Harbor job directories or `decant export
   * --as atif` output, read recursively on every sync. No tool writes to the
   * default; a user copies trajectories into it, because discovery does not
   * follow symbolic links. Absent in a config built by hand, which then reads
   * no ATIF directory. */
  atifDir?: string;
}

export interface ConfigOverrides {
  dbPath?: string | null;
  claudeDir?: string | null;
  codexDir?: string | null;
  geminiDir?: string | null;
  opencodeDir?: string | null;
  cursorDir?: string | null;
  copilotDir?: string | null;
  vscodeCopilotDir?: string | null;
  atifDir?: string | null;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  /** Defaults to the running platform; tests pass one to check each layout. */
  platform?: NodeJS.Platform;
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
    // COPILOT_HOME relocates all of Copilot CLI's data, session state included.
    copilotDir:
      overrides.copilotDir ??
      nonEmpty(env.DECANT_COPILOT_DIR) ??
      join(nonEmpty(env.COPILOT_HOME) ?? join(home, ".copilot"), "session-state"),
    ...vscodeCopilotDirs(overrides, env, home),
    atifDir: overrides.atifDir ?? nonEmpty(env.DECANT_ATIF_DIR) ?? join(home, ".decant", "atif"),
  };
}

/** One override replaces both VS Code builds' defaults, so a scratch run never
 * reads the real Insiders data. Other editors built on VS Code keep their own
 * data directories and are not read. */
function vscodeCopilotDirs(
  overrides: ConfigOverrides,
  env: Record<string, string | undefined>,
  home: string,
): Pick<Config, "vscodeCopilotDir" | "vscodeCopilotInsidersDir"> {
  const override = overrides.vscodeCopilotDir ?? nonEmpty(env.DECANT_VSCODE_COPILOT_DIR);
  if (override != null) {
    return { vscodeCopilotDir: override };
  }
  const appData = vscodeAppDataDir(overrides.platform ?? process.platform, env, home);
  return {
    vscodeCopilotDir: join(appData, "Code", "User"),
    vscodeCopilotInsidersDir: join(appData, "Code - Insiders", "User"),
  };
}

/** Where VS Code keeps per-user data on each platform (`getDefaultUserDataPath`
 * in VS Code's `src/vs/platform/environment/node/userDataPath.ts`). */
function vscodeAppDataDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return nonEmpty(env.APPDATA) ?? join(home, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config");
}

function nonEmpty(value: string | undefined): string | null {
  return value == null || value === "" ? null : value;
}
