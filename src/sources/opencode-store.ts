// Read-only access to an OpenCode 2.x database. OpenCode owns the file and
// keeps it in WAL mode; this module only reads. The connection is opened
// read-only (never `immutable`), so the -wal and -shm files stay visible and
// rows OpenCode committed since the last checkpoint are seen. Nothing here
// writes or checkpoints, and the OpenCode CLI is never started.
import { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { asInteger, asString, get, isObject } from "../json.ts";
import type { Json } from "../model.ts";
import { compareCodePoints } from "../order.ts";
import { queryRow, queryRows } from "../sqlite-statements.ts";
import type { OpenCodeMessageRow, OpenCodeSessionRow } from "./opencode.ts";

export interface OpenCodeSessionRef {
  dbPath: string;
  sessionId: string;
  /** Per-session change key (see `openCodeFingerprint`); stored in
   * `ingest_source.hash` so an unchanged session is skipped. */
  fingerprint: string;
  timeUpdated: number;
}

export interface OpenCodeLoadedSession {
  session: OpenCodeSessionRow;
  messages: OpenCodeMessageRow[];
}

interface FingerprintRow {
  id: string;
  time_updated: number;
  message_count: number;
  max_seq: number | null;
  max_message_updated: number | null;
}

/** The whole file's mtime moves on every write to any session, so change
 * detection is per session: the row's own update time plus the message set's
 * count, highest seq, and newest update. A revert lowers the count and a
 * streamed assistant row raises the update time; both change the key. */
export function openCodeFingerprint(
  timeUpdated: number,
  messageCount: number,
  maxSeq: number | null,
  maxMessageUpdated: number | null,
): string {
  return `${timeUpdated}:${messageCount}:${maxSeq ?? -1}:${maxMessageUpdated ?? -1}`;
}

export class OpenCodeStore {
  readonly path: string;
  readonly #db: Database;
  #contextWindows: ReadonlyMap<string, number> | null = null;

  private constructor(path: string, db: Database) {
    this.path = path;
    this.#db = db;
  }

  static open(path: string): OpenCodeStore {
    const db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    return new OpenCodeStore(path, db);
  }

  /** A database written only by OpenCode 1.x has `session`/`message`/`part`
   * and no `session_v2`; PR 3 reads those. */
  hasSessionTables(): boolean {
    return hasTable(this.#db, "session_v2") && hasTable(this.#db, "session_message");
  }

  listSessions(): OpenCodeSessionRef[] {
    if (!this.hasSessionTables()) {
      return [];
    }
    const rows = queryRows<FingerprintRow>(
      this.#db,
      `SELECT s.id, s.time_updated,
              (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS message_count,
              (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = s.id) AS max_seq,
              (SELECT MAX(m.time_updated) FROM session_message m WHERE m.session_id = s.id)
                AS max_message_updated
         FROM session_v2 s`,
    );
    return rows
      .map((row) => ({
        dbPath: this.path,
        sessionId: row.id,
        fingerprint: openCodeFingerprint(
          row.time_updated,
          row.message_count,
          row.max_seq,
          row.max_message_updated,
        ),
        timeUpdated: row.time_updated,
      }))
      .sort((a, b) => compareCodePoints(a.sessionId, b.sessionId));
  }

  loadSession(sessionId: string): OpenCodeLoadedSession | null {
    if (!this.hasSessionTables()) {
      return null;
    }
    const session = queryRow<OpenCodeSessionRow>(
      this.#db,
      `SELECT id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory, title,
              version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
              tokens_cache_write, agent, model, time_created, time_updated, time_archived
         FROM session_v2 WHERE id = ?1`,
      [sessionId],
    );
    if (session == null) {
      return null;
    }
    const messages = queryRows<OpenCodeMessageRow>(
      this.#db,
      `SELECT id, session_id, type, seq, time_created, time_updated, data
         FROM session_message WHERE session_id = ?1 ORDER BY seq`,
      [sessionId],
    );
    return { session, messages };
  }

  /** `limit.context` per `<providerID>/<modelID>` from OpenCode's cached
   * models.dev catalog (`kv` key `models-dev:catalog`, or
   * `models-dev:catalog:<hash>` for a custom catalog source). Parsed once per
   * store; an unreadable catalog yields an empty map, never a guess. */
  contextWindows(): ReadonlyMap<string, number> {
    if (this.#contextWindows != null) {
      return this.#contextWindows;
    }
    const windows = new Map<string, number>();
    if (hasTable(this.#db, "kv")) {
      const rows = queryRows<{ value: string }>(
        this.#db,
        "SELECT value FROM kv WHERE key = 'models-dev:catalog' OR key LIKE 'models-dev:catalog:%'",
      );
      for (const row of rows) {
        collectContextWindows(row.value, windows);
      }
    }
    this.#contextWindows = windows;
    return windows;
  }

  close(): void {
    this.#db.close();
  }
}

function collectContextWindows(value: string, windows: Map<string, number>): void {
  const body = parseJson(get(parseJson(value), "body"));
  if (!isObject(body)) {
    return;
  }
  for (const [providerId, provider] of Object.entries(body)) {
    const models = get(provider, "models");
    if (!isObject(models)) {
      continue;
    }
    for (const [modelId, model] of Object.entries(models)) {
      const context = asInteger(get(get(model, "limit"), "context"));
      if (context != null && context > 0 && !windows.has(`${providerId}/${modelId}`)) {
        windows.set(`${providerId}/${modelId}`, context);
      }
    }
  }
}

/** The catalog envelope is JSON whose `body` is itself a JSON string. */
function parseJson(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return undefined;
  }
}

function hasTable(db: Database, table: string): boolean {
  return (
    queryRow<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
      [table],
    ) != null
  );
}

/** File access for config lookup, so tests can substitute an in-memory tree. */
export interface OpenCodeConfigFs {
  /** The file's text, or null when it is missing or unreadable. */
  readText(path: string): string | null;
  /** The absolute path with symlinks resolved, or just made absolute when it
   * does not exist (OpenCode's `FSUtil.resolve`). */
  realPath(path: string): string;
}

export const nodeOpenCodeConfigFs: OpenCodeConfigFs = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  realPath(path) {
    const absolute = resolve(path);
    try {
      return realpathSync.native(absolute);
    } catch {
      return absolute;
    }
  },
};

/** MCP server names from one OpenCode config file (`opencode.json` or the
 * JSONC `opencode.jsonc`): `mcp.servers.<name>` plus the legacy `mcp.<name>`
 * object layout. A missing, unreadable, or malformed file names no servers. */
export function readOpenCodeMcpServers(
  configPath: string,
  fs: OpenCodeConfigFs = nodeOpenCodeConfigFs,
): string[] {
  const text = fs.readText(configPath);
  if (text == null) {
    return [];
  }
  let config: Json;
  try {
    config = parseJsonc(text);
  } catch {
    return [];
  }
  const mcp = get(config, "mcp");
  if (!isObject(mcp)) {
    return [];
  }
  const names = new Set<string>();
  const servers = mcp.servers;
  if (isObject(servers)) {
    for (const name of Object.keys(servers)) {
      names.add(name);
    }
  }
  for (const [name, value] of Object.entries(mcp)) {
    if (name !== "servers" && isObject(value) && asString(value.type) != null) {
      names.add(name);
    }
  }
  return [...names].sort(compareCodePoints);
}

/** Where OpenCode's MCP server names come from, besides project configs. */
export interface OpenCodeConfigSources {
  /** OpenCode's global config directory (`OPENCODE_CONFIG_DIR`, else
   * `$XDG_CONFIG_HOME/opencode`). Its `opencode.json` and `opencode.jsonc`
   * are read unless `globalFile` replaces them. */
  globalDir?: string;
  /** Decant's `DECANT_OPENCODE_CONFIG`: read alone in place of the global
   * directory's two files. */
  globalFile?: string;
  /** OpenCode's `OPENCODE_CONFIG`: one more file that OpenCode loads in
   * addition to the global and project configs. */
  extraFile?: string;
}

/** Config files read for every session, in OpenCode's file-name order. */
export function openCodeGlobalConfigPaths({
  globalDir,
  globalFile,
  extraFile,
}: OpenCodeConfigSources): string[] {
  const paths =
    globalFile != null
      ? [globalFile]
      : globalDir != null
        ? OPENCODE_CONFIG_NAMES.map((name) => join(globalDir, name))
        : [];
  return extraFile == null ? paths : [...paths, extraFile];
}

/** File names OpenCode reads from a config directory. */
const OPENCODE_CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/** MCP server names that apply to a session, found the way OpenCode 2.x
 * discovers configs (`ConfigDiscovery.discover`): the global configs, plus
 * `opencode.json`, `opencode.jsonc`, and `.opencode/opencode.json[c]` in the
 * session's directory and in every ancestor up to the filesystem root. A
 * project file that resolves to a global file, and a `.opencode` that resolves
 * to the global directory, are skipped as OpenCode skips them. Names are a
 * union, so OpenCode's precedence order does not matter here.
 *
 * Each ancestor is read once per instance, and ingest makes one instance per
 * sync, so a config edit is seen by the next sync. */
export class OpenCodeMcpServerNames {
  readonly #fs: OpenCodeConfigFs;
  readonly #global: readonly string[];
  readonly #globalDir: string | null;
  readonly #globalFiles: ReadonlySet<string>;
  readonly #byAncestor = new Map<string, readonly string[]>();
  readonly #byDirectory = new Map<string, readonly string[]>();

  constructor(sources: OpenCodeConfigSources = {}, fs: OpenCodeConfigFs = nodeOpenCodeConfigFs) {
    this.#fs = fs;
    this.#global = readAll(openCodeGlobalConfigPaths(sources), fs);
    const globalDir = sources.globalDir;
    this.#globalDir = globalDir == null ? null : fs.realPath(globalDir);
    this.#globalFiles = new Set(
      globalDir == null
        ? []
        : OPENCODE_CONFIG_NAMES.map((name) => fs.realPath(join(globalDir, name))),
    );
  }

  forDirectory(directory: string | null): readonly string[] {
    // A relative directory would resolve against Decant's own cwd.
    if (directory == null || !isAbsolute(directory)) {
      return this.#global;
    }
    let names = this.#byDirectory.get(directory);
    if (names == null) {
      names = this.#walk(directory);
      this.#byDirectory.set(directory, names);
    }
    return names;
  }

  #walk(directory: string): readonly string[] {
    // OpenCode reads no project configs for a session run from inside its
    // global config directory.
    if (this.#globalDir != null && this.#fs.realPath(directory) === this.#globalDir) {
      return this.#global;
    }
    const lists: (readonly string[])[] = [this.#global];
    let current = resolve(directory);
    while (true) {
      lists.push(this.#ancestor(current));
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    const names = mergeNames(lists);
    return names.length === this.#global.length ? this.#global : names;
  }

  #ancestor(directory: string): readonly string[] {
    let names = this.#byAncestor.get(directory);
    if (names == null) {
      const fs = this.#fs;
      const real = fs.realPath(directory);
      const paths = OPENCODE_CONFIG_NAMES.map((name) => join(real, name)).filter(
        (path) => !this.#globalFiles.has(fs.realPath(path)),
      );
      const projectDir = fs.realPath(join(real, ".opencode"));
      if (projectDir !== this.#globalDir) {
        paths.push(...OPENCODE_CONFIG_NAMES.map((name) => join(projectDir, name)));
      }
      names = readAll(paths, fs);
      this.#byAncestor.set(directory, names);
    }
    return names;
  }
}

function readAll(paths: readonly string[], fs: OpenCodeConfigFs): string[] {
  return mergeNames(paths.map((path) => readOpenCodeMcpServers(path, fs)));
}

function mergeNames(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compareCodePoints);
}

/** Parses JSONC as OpenCode accepts it: JSON plus `//` and block comments and
 * trailing commas. Anything else that is not JSON throws. */
export function parseJsonc(text: string): Json {
  return JSON.parse(withoutTrailingCommas(withoutComments(text.replace(/^\uFEFF/, "")))) as Json;
}

/** Index just past the string literal that opens at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  return i + 1;
}

function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SyntaxError("unterminated block comment");
      }
      out += " ";
      i = end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function withoutTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) {
        j += 1;
      }
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}
