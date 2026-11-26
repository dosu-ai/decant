import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.ts";
import { closeDb, openDb } from "../../src/db.ts";
import { type SyncReport, sync } from "../../src/ingest.ts";
import { decodeBlockToolResult, decodeMessageRaw } from "../../src/message-storage.ts";
import { searchPage } from "../../src/query.ts";
import { buildFtsQuery } from "../../src/search-query.ts";

type Scalar = string | number | null;
type Row = Record<string, unknown>;

export interface CanonicalSnapshot {
  session: Row[];
  message: Row[];
  block: Row[];
  tool_call: Row[];
  file_ref: Row[];
  billed_request: Row[];
  unbilled_request: Row[];
  session_model_usage: Row[];
  session_economics: Row[];
  ingest_issue: Row[];
}

const SESSION_KEY_SQL = "s.tool || ':' || s.source_session_id";

export function captureCanonicalSnapshot(db: Database): CanonicalSnapshot {
  return {
    session: sessionRows(db),
    message: messageRows(db),
    block: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq, b.*
           FROM block b
           JOIN message m ON m.id = b.message_id
           JOIN session s ON s.id = b.session_id`,
      ).map((row) => {
        const decodedToolResult = decodeBlockToolResult(
          row.tool_result as string | Uint8Array | null,
          row.tool_result_bytes as number | null,
        );
        return {
          ...omit(row, ["id", "message_id", "session_id", "tool_result"]),
          decoded_tool_result: decodedToolResult,
        };
      }),
      (row) => [row.session_key, row.message_seq, row.ordinal],
    ),
    tool_call: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq,
                cm.seq AS call_message_seq, cb.ordinal AS call_block_ordinal,
                rm.seq AS result_message_seq, rb.ordinal AS result_block_ordinal, t.*
           FROM tool_call t
           JOIN session s ON s.id = t.session_id
           LEFT JOIN message m ON m.id = t.message_id
           LEFT JOIN block cb ON cb.id = t.call_block_id
           LEFT JOIN message cm ON cm.id = cb.message_id
           LEFT JOIN block rb ON rb.id = t.result_block_id
           LEFT JOIN message rm ON rm.id = rb.message_id`,
      ).map((row) =>
        omit(row, ["id", "session_id", "message_id", "call_block_id", "result_block_id"]),
      ),
      (row) => [
        row.session_key,
        row.call_message_seq,
        row.call_block_ordinal,
        row.ordinal,
        row.tool_name,
        row.tool_use_id,
        row.input,
      ],
    ),
    file_ref: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq, f.*
           FROM file_ref f
           JOIN session s ON s.id = f.session_id
           LEFT JOIN message m ON m.id = f.message_id`,
      ).map((row) => omit(row, ["id", "session_id", "message_id"])),
      (row) => [
        row.session_key,
        row.message_seq,
        row.path,
        row.rel_path,
        row.ext,
        row.operation,
        row.timestamp,
      ],
    ),
    billed_request: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq, r.*
           FROM billed_request r
           JOIN session s ON s.id = r.session_id
           LEFT JOIN message m ON m.id = r.message_id`,
      ).map((row) => omit(row, ["session_id", "message_id"])),
      (row) => [row.request_id],
    ),
    unbilled_request: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq, u.*
           FROM unbilled_request u
           JOIN session s ON s.id = u.session_id
           LEFT JOIN message m ON m.id = u.message_id`,
      ).map((row) => omit(row, ["session_id", "message_id"])),
      (row) => [row.session_key, row.message_seq],
    ),
    session_model_usage: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, u.*
           FROM session_model_usage u
           JOIN session s ON s.id = u.session_id`,
      ).map((row) => omit(row, ["session_id"])),
      (row) => [row.session_key, row.model, row.tier],
    ),
    session_economics: sorted(
      rows(
        db,
        `SELECT ${SESSION_KEY_SQL} AS session_key, e.session_id, e.format_version, e.vector_json
           FROM session_economics e
           JOIN session s ON s.id = e.session_id`,
      ).map((row) => {
        const { id, ...vector } = JSON.parse(String(row.vector_json)) as Record<string, unknown>;
        return {
          session_key: row.session_key,
          format_version: row.format_version,
          vector_names_its_session: id === row.session_id,
          vector: canonicalJson(vector),
        };
      }),
      (row) => [row.session_key],
    ),
    ingest_issue: sorted(
      rows(db, "SELECT source_path, line_no, code, error, raw_line FROM ingest_issue"),
      (row) => [row.source_path, row.line_no, row.code, row.error, row.raw_line],
    ),
  };
}

function sessionRows(db: Database): Row[] {
  return sorted(
    rows(
      db,
      `SELECT s.*, p.path AS project_path,
              CASE WHEN ps.id IS NULL THEN NULL
                   ELSE ps.tool || ':' || ps.source_session_id END AS parent_session_key
         FROM session s
         LEFT JOIN project p ON p.id = s.project_id
         LEFT JOIN session ps ON ps.id = s.parent_session_id`,
    ).map((row) => omit(row, ["id", "project_id", "parent_session_id", "ingested_at"])),
    (row) => [row.tool, row.source_session_id],
  );
}

function messageRows(db: Database): Row[] {
  return sorted(
    rows(
      db,
      `SELECT ${SESSION_KEY_SQL} AS session_key, pm.seq AS parent_seq, m.*
         FROM message m
         JOIN session s ON s.id = m.session_id
         LEFT JOIN message pm ON pm.id = m.parent_id`,
    ).map((row) => {
      const decodedRaw = decodeMessageRaw(row.raw as string | Uint8Array);
      return { ...omit(row, ["id", "session_id", "parent_id", "raw"]), decoded_raw: decodedRaw };
    }),
    (row) => [row.session_key, row.seq],
  );
}

export interface FtsCapture {
  query: string;
  direct: Row[];
  search: { total: number | null; hits: Row[] };
}

export function captureFtsResults(db: Database, queries: string[]): FtsCapture[] {
  const ordinalOf = db.query("SELECT ordinal FROM block WHERE id = ?1");
  const sessionKeyOf = db.query(
    "SELECT tool || ':' || source_session_id AS session_key FROM session WHERE id = ?1",
  );
  const tieKey = (row: Row) => [row.session_key, row.message_seq, row.block_ordinal];
  return queries.map((query) => {
    const scored = rows(
      db,
      `SELECT b.id AS block_id, ${SESSION_KEY_SQL} AS session_key, m.seq AS message_seq,
              b.ordinal AS block_ordinal,
              ROUND(bm25(block_fts, 4.0, 2.0, 1.0), 9) AS score
         FROM block_fts
         JOIN block b ON b.id = block_fts.rowid
         JOIN message m ON m.id = b.message_id
         JOIN session s ON s.id = b.session_id
        WHERE block_fts MATCH ?1`,
      [buildFtsQuery(query)],
    );
    const scoreByBlock = new Map(scored.map((row) => [row.block_id, row.score]));
    const direct = sorted(
      scored.map((row) => omit(row, ["block_id"])),
      (row) => [row.score, ...tieKey(row)],
    );
    const page = searchPage(db, query, { includeSubagents: true, limit: 100 });
    const hits = sortedWithinTies(
      page.results.map((hit) => ({
        session_key: (sessionKeyOf.get(hit.session_id) as { session_key: string } | null)
          ?.session_key,
        session_title: hit.session_title,
        message_seq: hit.message_seq,
        block_ordinal: (ordinalOf.get(hit.block_id) as { ordinal: number } | null)?.ordinal,
        block_type: hit.block_type,
        role: hit.role,
        project: hit.project,
        timestamp: hit.timestamp,
        snippet: hit.snippet,
        has_snippet: hit.snippet !== "",
        score: scoreByBlock.get(hit.block_id) ?? null,
      })),
      (row) => row.score,
      tieKey,
    );
    return { query, direct, search: { total: page.total, hits } };
  });
}

function sortedWithinTies(
  list: Row[],
  score: (row: Row) => unknown,
  key: (row: Row) => unknown[],
): Row[] {
  const out: Row[] = [];
  for (let start = 0; start < list.length; ) {
    let end = start + 1;
    while (end < list.length && score(list[end] as Row) === score(list[start] as Row)) end += 1;
    out.push(...sorted(list.slice(start, end), key));
    start = end;
  }
  return out;
}

/** SQLite's own page-level check plus FTS5's external-content cross-check,
 * which compares every `block_fts` entry with the `block` row it indexes. */
export function assertDatabaseIntegrity(db: Database): void {
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(() =>
    db.run("INSERT INTO block_fts(block_fts, rank) VALUES ('integrity-check', 1)"),
  ).not.toThrow();
}

export const SOURCE_ROOTS = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot",
  vscode: "vscode/User",
  pi: "pi",
} as const;

export type FileMutation =
  | { op: "write"; path: string; content: string | Uint8Array }
  | { op: "append"; path: string; content: string | Uint8Array }
  | { op: "truncate"; path: string; size: number }
  | { op: "rewrite"; path: string; content: string | Uint8Array }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string };

export interface ScenarioStep {
  label: string;
  mutations: FileMutation[];
  clock?: "advance" | "hold";
  afterSync?: (incremental: Database) => void;
}

export interface DifferentialScenario {
  name: string;
  steps: ScenarioStep[];
  queries: string[];
}

export interface DifferentialResult {
  snapshot: CanonicalSnapshot;
  fts: FtsCapture[];
  reports: SyncReport[];
}

const CONTENT_OPS: ReadonlySet<FileMutation["op"]> = new Set([
  "write",
  "append",
  "truncate",
  "rewrite",
]);

const CLOCK_START_SECONDS = Date.UTC(2026, 10, 1, 12, 0, 0) / 1000;
const CLOCK_STEP_SECONDS = 2;

export function runDifferentialScenario(scenario: DifferentialScenario): DifferentialResult {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "decant-oracle-")));
  const config = isolatedConfig(workspace);
  let incremental: Database | null = null;
  let fresh: Database | null = null;
  try {
    mkdirSync(join(workspace, "archive"));
    incremental = openDb(join(workspace, "archive", "incremental.db"));
    const reports: SyncReport[] = [];
    let clock = CLOCK_START_SECONDS;
    for (const { label, afterSync, ...step } of scenario.steps) {
      const stepName = `${scenario.name}: ${label}`;
      if (step.clock !== "hold") {
        clock += CLOCK_STEP_SECONDS;
      }
      const touched = applyMutations(workspace, step.mutations);
      for (const path of touched) {
        utimesSync(path, clock, clock);
      }
      const report = sync(incremental, config);
      expect({ step: stepName, failed: report.failed }).toEqual({
        step: stepName,
        failed: 0,
      });
      if (step.clock !== "hold" && step.mutations.some((m) => CONTENT_OPS.has(m.op))) {
        expect({ step: stepName, reingested: report.ingested > 0 }).toEqual({
          step: stepName,
          reingested: true,
        });
      }
      reports.push(report);
      assertDatabaseIntegrity(incremental);
      afterSync?.(incremental);
    }

    fresh = openDb(join(workspace, "archive", "fresh.db"));
    const freshReport = sync(fresh, config);
    expect(freshReport.failed).toBe(0);
    assertDatabaseIntegrity(fresh);

    const snapshot = captureCanonicalSnapshot(incremental);
    expect(snapshot).toEqual(captureCanonicalSnapshot(fresh));
    const fts = captureFtsResults(incremental, scenario.queries);
    expect(fts).toEqual(captureFtsResults(fresh, scenario.queries));
    return { snapshot, fts, reports };
  } finally {
    if (incremental != null) {
      closeDb(incremental);
    }
    if (fresh != null) {
      closeDb(fresh);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function isolatedConfig(workspace: string): Config {
  const root = (name: string): string => join(workspace, name);
  return {
    dbPath: join(workspace, "archive", "incremental.db"),
    claudeDir: root(SOURCE_ROOTS.claude),
    codexDir: root(SOURCE_ROOTS.codex),
    geminiDir: root(SOURCE_ROOTS.gemini),
    opencodeDir: root("opencode"),
    opencodeConfigDir: root("opencode-config"),
    opencodeModelsPath: join(workspace, "opencode-cache", "models.json"),
    cursorDir: root("cursor"),
    copilotDir: root(SOURCE_ROOTS.copilot),
    vscodeCopilotDir: root(SOURCE_ROOTS.vscode),
    atifDir: root("atif"),
    hermesDir: root("hermes"),
    piDir: root(SOURCE_ROOTS.pi),
  };
}

function writeExistingFile(
  path: string,
  content: string | Uint8Array,
  flags: number,
  mutation: Record<string, string>,
): void {
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      expect({ ...mutation, exists: false }).toEqual({ ...mutation, exists: true });
    }
    throw error;
  }
  try {
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(fd, bytes, offset);
    }
  } finally {
    closeSync(fd);
  }
}

function applyMutations(workspace: string, mutations: FileMutation[]): string[] {
  const touched = new Set<string>();
  for (const mutation of mutations) {
    const path = join(workspace, mutation.path);
    switch (mutation.op) {
      case "write":
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, mutation.content);
        touched.add(path);
        break;
      case "append":
        writeExistingFile(path, mutation.content, constants.O_WRONLY | constants.O_APPEND, {
          append: mutation.path,
        });
        touched.add(path);
        break;
      case "truncate":
        truncateSync(path, mutation.size);
        touched.add(path);
        break;
      case "rewrite":
        writeExistingFile(path, mutation.content, constants.O_WRONLY | constants.O_TRUNC, {
          rewrite: mutation.path,
        });
        touched.add(path);
        break;
      case "mkdir":
        mkdirSync(path, { recursive: true });
        break;
      case "remove":
        rmSync(path, { recursive: true, force: true });
        touched.delete(path);
        break;
    }
  }
  return [...touched].filter((path) => existsSync(path));
}

function rows(db: Database, sql: string, params: Scalar[] = []): Row[] {
  return db.query(sql).all(...params) as Row[];
}

function omit(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (!keys.includes(key)) {
      out[key] = value instanceof Uint8Array ? `blob:${Buffer.from(value).toString("hex")}` : value;
    }
  }
  return out;
}

function sorted(list: Row[], key: (row: Row) => unknown[]): Row[] {
  return list
    .map((row) => ({ row, key: key(row) }))
    .sort((a, b) => compareTuples(a.key, b.key))
    .map(({ row }) => row);
}

function compareTuples(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const order = compareValues(a[i], b[i]);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

function compareValues(a: unknown, b: unknown): number {
  const rank = (value: unknown): number => (value == null ? 0 : typeof value === "number" ? 1 : 2);
  if (rank(a) !== rank(b)) {
    return rank(a) - rank(b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (a == null) {
    return 0;
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
