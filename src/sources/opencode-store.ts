// OpenCode keeps its database in WAL mode. The connection is opened read-only,
// never `immutable`, so the -wal and -shm files stay visible and rows OpenCode
// committed since the last checkpoint are seen.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundedFs } from "../bounded-fs.ts";
import { asInteger, asString, get, isObject } from "../json.ts";
import type { Json } from "../model.ts";
import { compareCodePoints } from "../order.ts";
import { queryRow, queryRows } from "../sqlite-statements.ts";
import type {
  OpenCodeLegacyCounterpart,
  OpenCodeMessageRow,
  OpenCodeSessionRow,
} from "./opencode.ts";
import type {
  OpenCodeLegacyMessageRow,
  OpenCodeLegacyPartRow,
  OpenCodeLegacySessionRow,
} from "./opencode-legacy.ts";

export interface OpenCodeSessionRef {
  dbPath: string;
  sessionId: string;
  format: "v1" | "v2";
  fingerprint: string;
  timeUpdated: number;
  directory: string | null;
}

export interface OpenCodeLoadedSession {
  session: OpenCodeSessionRow;
  messages: OpenCodeMessageRow[];
  legacy: OpenCodeLegacyCounterpart | null;
}

export interface OpenCodeLegacyLoadedSession {
  session: OpenCodeLegacySessionRow;
  messages: OpenCodeLegacyMessageRow[];
  parts: OpenCodeLegacyPartRow[];
}

interface FingerprintRow {
  id: string;
  directory: string | null;
  time_updated: number;
  message_count: number;
  max_seq: number | null;
  max_message_updated: number | null;
}

export function openCodeFingerprint(
  timeUpdated: number,
  messageCount: number,
  maxSeq: number | null,
  maxMessageUpdated: number | null,
): string {
  return `${timeUpdated}:${messageCount}:${maxSeq ?? -1}:${maxMessageUpdated ?? -1}`;
}

interface LegacyFingerprintRow {
  id: string;
  directory: string | null;
  time_updated: number;
  message_count: number;
  part_count: number;
  max_message_updated: number | null;
  max_part_updated: number | null;
  message_updated_total: number;
  part_updated_total: number;
  [stateColumn: `state_${string}`]: string | number | null;
}

export interface OpenCodeLegacyChangeFields {
  timeUpdated: number;
  messageCount: number;
  partCount: number;
  maxMessageUpdated: number | null;
  maxPartUpdated: number | null;
  messageUpdatedTotal: number;
  partUpdatedTotal: number;
  sessionState: readonly (string | number | null)[];
}

function withCounterpart(fingerprint: string, legacy: string | undefined): string {
  return legacy == null ? fingerprint : `${fingerprint}|${legacy}`;
}

export function openCodeLegacyFingerprint(fields: OpenCodeLegacyChangeFields): string {
  const state = createHash("sha256")
    .update(JSON.stringify(fields.sessionState))
    .digest("hex")
    .slice(0, 12);
  return [
    "v1",
    fields.timeUpdated,
    fields.messageCount,
    fields.partCount,
    fields.maxMessageUpdated ?? -1,
    fields.maxPartUpdated ?? -1,
    fields.messageUpdatedTotal,
    fields.partUpdatedTotal,
    state,
  ].join(":");
}

const LEGACY_STATE_COLUMNS = [
  "title",
  "time_archived",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
] as const satisfies readonly (keyof OpenCodeLegacySessionRow)[];

const LEGACY_SESSION_COLUMNS = [
  "id",
  "project_id",
  "parent_id",
  "slug",
  "directory",
  "title",
  "version",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "revert",
  "agent",
  "model",
  "time_created",
  "time_updated",
  "time_archived",
] as const satisfies readonly (keyof OpenCodeLegacySessionRow)[];

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

  hasSessionTables(): boolean {
    return hasTable(this.#db, "session_v2") && hasTable(this.#db, "session_message");
  }

  listSessions(legacy?: readonly OpenCodeSessionRef[]): OpenCodeSessionRef[] {
    if (!this.hasSessionTables()) {
      return [];
    }
    const counterparts = new Map(
      (legacy ?? this.listLegacySessions()).map((ref) => [ref.sessionId, ref.fingerprint]),
    );
    const rows = queryRows<FingerprintRow>(
      this.#db,
      `SELECT s.id, s.directory, s.time_updated,
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
        format: "v2" as const,
        fingerprint: withCounterpart(
          openCodeFingerprint(
            row.time_updated,
            row.message_count,
            row.max_seq,
            row.max_message_updated,
          ),
          counterparts.get(row.id),
        ),
        timeUpdated: row.time_updated,
        directory: row.directory,
      }))
      .sort((a, b) => compareCodePoints(a.sessionId, b.sessionId));
  }

  loadSession(sessionId: string): OpenCodeLoadedSession | null {
    if (!this.hasSessionTables()) {
      return null;
    }
    return this.#db
      .transaction((): OpenCodeLoadedSession | null => {
        const session = queryRow<OpenCodeSessionRow>(
          this.#db,
          `SELECT id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory,
                  title, version, cost, tokens_input, tokens_output, tokens_reasoning,
                  tokens_cache_read, tokens_cache_write, agent, model, time_created,
                  time_updated, time_archived
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
        return { session, messages, legacy: this.#legacyCounterpart(sessionId) };
      })
      .deferred();
  }

  #legacyCounterpart(sessionId: string): OpenCodeLegacyCounterpart | null {
    if (!this.hasLegacyTables()) {
      return null;
    }
    const session = queryRow<{ version: string | null }>(
      this.#db,
      "SELECT version FROM session WHERE id = ?1",
      [sessionId],
    );
    if (session == null) {
      return null;
    }
    const messages = queryRows<OpenCodeLegacyMessageRow>(
      this.#db,
      `SELECT id, session_id, time_created, time_updated, data
         FROM message WHERE session_id = ?1 ORDER BY time_created, id`,
      [sessionId],
    );
    const parts = queryRows<OpenCodeLegacyPartRow>(
      this.#db,
      `SELECT id, message_id, session_id, time_created, time_updated, data
         FROM part WHERE session_id = ?1 AND instr(data, '"step-finish"') > 0
        ORDER BY message_id, id`,
      [sessionId],
    );
    return { version: session.version, messages, parts };
  }

  /** A pre-release 2.x database from before OpenCode split its tables
   * (`opencode-next.db`): 2.x sessions in a table still named `session`, beside
   * `session_message`, and no `session_v2`. OpenCode tells it apart by
   * `session_message` the same way (v1-migration.bun.ts `isNextDatabase`), and
   * renames its `session` to `session_v2` when a 2.x release opens it. */
  isPreSplitDatabase(): boolean {
    return hasTable(this.#db, "session_message") && !hasTable(this.#db, "session_v2");
  }

  hasLegacyTables(): boolean {
    return (
      !this.isPreSplitDatabase() &&
      ["session", "message", "part"].every((table) => hasTable(this.#db, table))
    );
  }

  listLegacySessions(): OpenCodeSessionRef[] {
    if (!this.hasLegacyTables()) {
      return [];
    }
    const rows = this.#db
      .transaction(() => {
        const columns = legacySessionColumns(this.#db);
        const state = LEGACY_STATE_COLUMNS.map(
          (column) => `${columns.has(column) ? `s."${column}"` : "NULL"} AS "state_${column}"`,
        ).join(", ");
        return queryRows<LegacyFingerprintRow>(
          this.#db,
          `SELECT s.id, s.directory, s.time_updated, ${state},
                  COALESCE(m.n, 0) AS message_count,
                  COALESCE(p.n, 0) AS part_count,
                  m.latest AS max_message_updated,
                  p.latest AS max_part_updated,
                  COALESCE(m.total, 0) AS message_updated_total,
                  COALESCE(p.total, 0) AS part_updated_total
             FROM session s
             LEFT JOIN (SELECT session_id, COUNT(*) AS n, MAX(time_updated) AS latest,
                               SUM(time_updated) AS total
                          FROM message GROUP BY session_id) m ON m.session_id = s.id
             LEFT JOIN (SELECT session_id, COUNT(*) AS n, MAX(time_updated) AS latest,
                               SUM(time_updated) AS total
                          FROM part GROUP BY session_id) p ON p.session_id = s.id`,
        );
      })
      .deferred();
    return rows
      .map((row) => ({
        dbPath: this.path,
        sessionId: row.id,
        format: "v1" as const,
        fingerprint: openCodeLegacyFingerprint({
          timeUpdated: row.time_updated,
          messageCount: row.message_count,
          partCount: row.part_count,
          maxMessageUpdated: row.max_message_updated,
          maxPartUpdated: row.max_part_updated,
          messageUpdatedTotal: row.message_updated_total,
          partUpdatedTotal: row.part_updated_total,
          sessionState: LEGACY_STATE_COLUMNS.map((column) => row[`state_${column}`] ?? null),
        }),
        timeUpdated: row.time_updated,
        directory: row.directory,
      }))
      .sort((a, b) => compareCodePoints(a.sessionId, b.sessionId));
  }

  loadLegacySession(sessionId: string): OpenCodeLegacyLoadedSession | null {
    if (!this.hasLegacyTables()) {
      return null;
    }
    return this.#db
      .transaction((): OpenCodeLegacyLoadedSession | null => {
        const columns = legacySessionColumns(this.#db);
        const projection = LEGACY_SESSION_COLUMNS.map((column) =>
          columns.has(column) ? `"${column}"` : `NULL AS "${column}"`,
        ).join(", ");
        const session = queryRow<OpenCodeLegacySessionRow>(
          this.#db,
          `SELECT ${projection} FROM session WHERE id = ?1`,
          [sessionId],
        );
        if (session == null) {
          return null;
        }
        const messages = queryRows<OpenCodeLegacyMessageRow>(
          this.#db,
          `SELECT id, session_id, time_created, time_updated, data
             FROM message WHERE session_id = ?1 ORDER BY time_created, id`,
          [sessionId],
        );
        const parts = queryRows<OpenCodeLegacyPartRow>(
          this.#db,
          `SELECT id, message_id, session_id, time_created, time_updated, data
             FROM part WHERE session_id = ?1 ORDER BY message_id, id`,
          [sessionId],
        );
        return { session, messages, parts };
      })
      .deferred();
  }

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
  collectCatalogWindows(parseJson(get(parseJson(value), "body")), windows);
}

function collectCatalogWindows(body: Json | undefined, windows: Map<string, number>): void {
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

export type OpenCodeModelsCache =
  | { status: "ok"; windows: ReadonlyMap<string, number> }
  | { status: "missing" }
  | { status: "failed"; error: string };

export function readOpenCodeModelsCache(path: string): OpenCodeModelsCache {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const body = parseJson(text);
  if (!isObject(body)) {
    return { status: "failed", error: "not a JSON object" };
  }
  const windows = new Map<string, number>();
  collectCatalogWindows(body, windows);
  return { status: "ok", windows };
}

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

function legacySessionColumns(db: Database): Set<string> {
  return new Set(
    queryRows<{ name: string }>(db, "SELECT name FROM pragma_table_info('session')").map(
      (row) => row.name,
    ),
  );
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

export interface OpenCodeConfigFs {
  readText(path: string): string | null;
  realPath(path: string): string;
  readonly unanswered?: number;
}

export const nodeOpenCodeConfigFs: OpenCodeConfigFs = boundedFs;

export interface OpenCodeMcpLookup {
  names: readonly string[];
  unreachable: boolean;
}

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

export interface OpenCodeConfigSources {
  globalDir?: string;
  globalFile?: string;
  extraFile?: string;
}

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

const OPENCODE_CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const;

export class OpenCodeMcpServerNames {
  readonly #fs: OpenCodeConfigFs;
  readonly #global: readonly string[];
  readonly #globalDir: string | null;
  readonly #globalFiles: ReadonlySet<string>;
  readonly #byAncestor = new Map<string, OpenCodeMcpLookup>();
  readonly #byDirectory = new Map<string, OpenCodeMcpLookup>();

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
    return this.lookup(directory).names;
  }

  lookup(directory: string | null): OpenCodeMcpLookup {
    if (directory == null || !isAbsolute(directory)) {
      return { names: this.#global, unreachable: false };
    }
    let found = this.#byDirectory.get(directory);
    if (found == null) {
      found = this.#walk(directory);
      this.#byDirectory.set(directory, found);
    }
    return found;
  }

  #walk(directory: string): OpenCodeMcpLookup {
    const before = this.#fs.unanswered ?? 0;
    const real = this.#fs.realPath(directory);
    let unreachable = (this.#fs.unanswered ?? 0) !== before;
    if (this.#globalDir != null && real === this.#globalDir) {
      return { names: this.#global, unreachable };
    }
    const lists: (readonly string[])[] = [this.#global];
    let current = resolve(directory);
    while (true) {
      const ancestor = this.#ancestor(current);
      lists.push(ancestor.names);
      unreachable ||= ancestor.unreachable;
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    const names = mergeNames(lists);
    return { names: names.length === this.#global.length ? this.#global : names, unreachable };
  }

  #ancestor(directory: string): OpenCodeMcpLookup {
    let found = this.#byAncestor.get(directory);
    if (found == null) {
      const fs = this.#fs;
      const before = fs.unanswered ?? 0;
      const real = fs.realPath(directory);
      const paths = OPENCODE_CONFIG_NAMES.map((name) => join(real, name)).filter(
        (path) => !this.#globalFiles.has(fs.realPath(path)),
      );
      const projectDir = fs.realPath(join(real, ".opencode"));
      if (projectDir !== this.#globalDir) {
        paths.push(...OPENCODE_CONFIG_NAMES.map((name) => join(projectDir, name)));
      }
      const names = readAll(paths, fs);
      found = { names, unreachable: (fs.unanswered ?? 0) !== before };
      this.#byAncestor.set(directory, found);
    }
    return found;
  }
}

function readAll(paths: readonly string[], fs: OpenCodeConfigFs): string[] {
  return mergeNames(paths.map((path) => readOpenCodeMcpServers(path, fs)));
}

function mergeNames(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort(compareCodePoints);
}

export function parseJsonc(text: string): Json {
  return JSON.parse(withoutTrailingCommas(withoutComments(text.replace(/^\uFEFF/, "")))) as Json;
}

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
