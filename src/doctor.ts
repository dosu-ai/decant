import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { LATEST_SCHEMA_VERSION } from "./db.ts";
import { discover, INGEST_PIPELINE_REVISION } from "./ingest.ts";
import { TOOLS, type Tool } from "./model.ts";
import { detectInstall, type InstallChannel, updateCheckEnabled } from "./update.ts";
import { DECANT_VERSION } from "./version.ts";

/**
 * Everything a bug report needs about the machine, and nothing from a
 * transcript. The report is meant to be pasted into a public issue, so paths
 * outside the home directory are replaced with CUSTOM_PATH and environment
 * variables are reported by name only.
 */
export interface DoctorReport {
  decant_version: string;
  install_channel: InstallChannel;
  platform: string;
  os_release: string;
  bun_version: string;
  supported_schema_version: number;
  ingest_pipeline_revision: number;
  update_check: boolean;
  archive: DoctorArchive;
  sources: DoctorSource[];
  /** Set by discovery failures; source counts are then incomplete. */
  discovery_error: string | null;
  /** Event names of warnings discovery raised, such as an unreadable OpenCode database. */
  discovery_warnings: string[];
  env: string[];
}

export interface DoctorArchive {
  path: string;
  exists: boolean;
  size_bytes: number | null;
  schema_version: number | null;
  sessions: Partial<Record<Tool, number>>;
  error: string | null;
}

export interface DoctorSource {
  tool: Tool;
  roots: string[];
  exists: boolean;
  /** Session sources discovery found: files for JSONL tools, sessions for OpenCode. */
  found: number;
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  install?: { channel: InstallChannel };
  /** Injected so tests do not depend on the machine's discovery result. */
  discover?: typeof discover;
}

export const CUSTOM_PATH = "(custom path)";

// Names only: values can hold paths with a user name in them.
const ENV_PREFIXES = ["DECANT_", "OPENCODE_"];
const ENV_NAMES = new Set(["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]);

export function collectDoctorReport(config: Config, options: DoctorOptions = {}): DoctorReport {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const display = (path: string): string => displayPath(path, home);

  let found: Partial<Record<Tool, number>> = {};
  let discoveryError: string | null = null;
  const warnings = new Set<string>();
  try {
    const files = (options.discover ?? discover)(config, (_message, properties) => {
      const name = properties["event.name"];
      warnings.add(typeof name === "string" ? name : "unknown warning");
    });
    found = countByTool(files.map((file) => file.tool));
  } catch (error) {
    discoveryError = errorName(error);
  }

  return {
    decant_version: DECANT_VERSION,
    install_channel: (options.install ?? detectInstall({ env })).channel,
    platform: `${process.platform} ${process.arch}`,
    os_release: release(),
    bun_version: typeof Bun === "undefined" ? "unknown" : Bun.version,
    supported_schema_version: LATEST_SCHEMA_VERSION,
    ingest_pipeline_revision: INGEST_PIPELINE_REVISION,
    update_check: updateCheckEnabled({ env, homeDir: options.homeDir }),
    archive: inspectArchive(config.dbPath, display),
    sources: TOOLS.map((tool) => {
      const roots = sourceRoots(config, tool);
      return {
        tool,
        roots: roots.map(display),
        exists: roots.some((root) => existsSync(root)),
        found: found[tool] ?? 0,
      };
    }),
    discovery_error: discoveryError,
    discovery_warnings: [...warnings].sort(),
    env: Object.keys(env)
      .filter(
        (name) =>
          env[name] != null &&
          (ENV_NAMES.has(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
      )
      .sort(),
  };
}

/** `~/...` for paths under the home directory, CUSTOM_PATH for anything else. */
export function displayPath(rawPath: string, rawHome: string): string {
  if (rawHome === "") {
    return CUSTOM_PATH;
  }
  // Resolved first so `~/../other` cannot leave the home directory in the
  // printed form, and so a trailing separator on either side does not matter.
  const home = resolve(rawHome);
  const path = resolve(rawPath);
  if (home === resolve(sep)) {
    return CUSTOM_PATH;
  }
  if (path === home) {
    return "~";
  }
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : CUSTOM_PATH;
}

function sourceRoots(config: Config, tool: Tool): string[] {
  switch (tool) {
    case "claude_code":
      return [config.claudeDir];
    case "codex":
      return [config.codexDir];
    case "gemini":
      return [config.geminiDir];
    case "opencode":
      return config.opencodeDb == null
        ? [config.opencodeDir]
        : [config.opencodeDir, config.opencodeDb];
    case "cursor":
      return [config.cursorDir];
    case "copilot":
      return [config.copilotDir];
    case "vscode_copilot":
      return config.vscodeCopilotInsidersDir == null
        ? [config.vscodeCopilotDir]
        : [config.vscodeCopilotDir, config.vscodeCopilotInsidersDir];
  }
}

// Opened read-only and never migrated: doctor must work on an archive that a
// newer or older Decant wrote, which is often why someone runs it.
function inspectArchive(path: string, display: (path: string) => string): DoctorArchive {
  const archive: DoctorArchive = {
    path: display(path),
    exists: existsSync(path),
    size_bytes: null,
    schema_version: null,
    sessions: {},
    error: null,
  };
  if (!archive.exists) {
    return archive;
  }
  let db: Database | null = null;
  try {
    archive.size_bytes = statSync(path).size;
    db = new Database(path, { readonly: true });
    const hasMigrations = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (hasMigrations != null) {
      const row = db.query("SELECT max(version) AS version FROM schema_migrations").get() as {
        version: unknown;
      };
      // A damaged archive can hold any text here, including a path.
      if (Number.isSafeInteger(row.version) && (row.version as number) >= 0) {
        archive.schema_version = row.version as number;
      } else if (row.version != null) {
        archive.error = "unreadable schema_migrations";
      }
    }
    const hasSessions = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'")
      .get();
    if (hasSessions != null) {
      const rows = db.query("SELECT tool, count(*) AS n FROM session GROUP BY tool").all() as {
        tool: string;
        n: number;
      }[];
      for (const row of rows) {
        if ((TOOLS as readonly string[]).includes(row.tool)) {
          archive.sessions[row.tool as Tool] = row.n;
        }
      }
    }
  } catch (error) {
    archive.error = errorName(error);
  } finally {
    db?.close();
  }
  return archive;
}

function countByTool(tools: Tool[]): Partial<Record<Tool, number>> {
  const counts: Partial<Record<Tool, number>> = {};
  for (const tool of tools) {
    counts[tool] = (counts[tool] ?? 0) + 1;
  }
  return counts;
}

// Error messages from SQLite and the filesystem can quote paths, so the report
// keeps the error class or SQLite code only.
function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} (${code})` : error.name;
  }
  return "unknown error";
}
