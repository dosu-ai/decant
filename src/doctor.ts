import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { LATEST_SCHEMA_VERSION } from "./db.ts";
import { discover, INGEST_PIPELINE_REVISION } from "./ingest.ts";
import { TOOLS, type Tool } from "./model.ts";
import { bunVersionSupported, runningBunVersion } from "./runtime.ts";
import { detectInstall, type InstallChannel, updateCheckEnabled } from "./update.ts";
import { DECANT_VERSION } from "./version.ts";

export interface DoctorReport {
  decant_version: string;
  install_channel: InstallChannel;
  platform: string;
  os_release: string;
  bun_version: string;
  bun_supported: boolean;
  supported_schema_version: number;
  ingest_pipeline_revision: number;
  update_check: boolean;
  archive: DoctorArchive;
  sources: DoctorSource[];
  discovery_error: string | null;
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
  found: number;
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  install?: { channel: InstallChannel };
  discover?: typeof discover;
}

export const CUSTOM_PATH = "(custom path)";

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
    bun_version: runningBunVersion(),
    bun_supported: bunVersionSupported(runningBunVersion()),
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

export function displayPath(rawPath: string, rawHome: string): string {
  if (rawHome === "") {
    return CUSTOM_PATH;
  }
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
    case "atif":
      return config.atifDir == null ? [] : [config.atifDir];
    case "hermes":
      return config.hermesDir == null ? [] : [config.hermesDir];
    case "pi":
      return config.piDir == null ? [] : [config.piDir];
  }
}

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

function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} (${code})` : error.name;
  }
  return "unknown error";
}
