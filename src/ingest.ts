import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { extname, join, basename as pathBasename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { outcome, workType } from "./classify.ts";
import { materializeContextWindow, materializeMissingContextWindows } from "./context-window.ts";
import { defaultPricing, estimateCost } from "./cost.ts";
import { withImmediateTransaction } from "./db.ts";
import { facets, fileRefs } from "./enrich.ts";
import { canonicalJson } from "./json.ts";
import {
  type Json,
  type NormalizedBlock,
  type ParsedSession,
  reasoningEffortLevels,
  recordedReasoningEffort,
  summarizeReasoningEfforts,
  type Tool,
} from "./model.ts";
import { compareCodePoints } from "./order.ts";
import { regenerate as regenerateRecommendations } from "./recommendations.ts";
import { inheritDeletedSessionTombstone } from "./session-user-state.ts";
import { parseClaudeSession } from "./sources/claude.ts";
import { parseCodexSession } from "./sources/codex.ts";
import {
  materializeMissingSessionEconomics,
  materializeSessionEconomics,
} from "./token-economics.ts";
import { classifyTool, previewHeadTail } from "./tools.ts";
import { resolveWorktreeRoots } from "./worktree.ts";

export interface IngestConfig {
  claudeDir: string;
  codexDir: string;
  sourcePaths?: string[];
}

/**
 * Version of the source-to-archive derivation pipeline. Increment this when a
 * parser or ingest enrichment change must be applied to already-seen source
 * files. The next sync re-ingests each stale source transactionally once.
 */
export const INGEST_PIPELINE_REVISION = 1;

export interface SyncReport {
  scanned: number;
  ingested: number;
  skipped: number;
  issues: number;
  /** `issues` split by IngestIssueCode; only codes actually seen appear. Lets
   * callers separate data loss (`unparsed_line`) from informational sensors. */
  issuesByCode: Record<string, number>;
  failed: number;
  cancelled: boolean;
}

/** A snapshot of a running sync. `scanned` is the number of discovered source
 * files inspected so far; `total` is the number discovered at startup. */
export interface SyncProgress {
  scanned: number;
  ingested: number;
  skipped: number;
  failed: number;
  total: number;
}

export type SyncProgressListener = (progress: SyncProgress) => void;

export interface SourceFile {
  tool: Tool;
  path: string;
  archived: boolean;
}

interface Prepared {
  file: SourceFile;
  lineCount: number;
  mtime: number;
  size: number;
  hash: string;
}

interface ToolUseBlock {
  messageId: number;
  callBlockId: number;
  timestamp: string | null;
  block: NormalizedBlock;
}

type IngestQueryParam = string | number | bigint | boolean | null;

function ingestRows<T>(db: Database, sql: string, params: IngestQueryParam[] = []): T[] {
  const statement = db.prepare<T, IngestQueryParam[]>(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function ingestRow<T>(db: Database, sql: string, params: IngestQueryParam[] = []): T | null {
  const statement = db.prepare<T, IngestQueryParam[]>(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}

function runIngestStatement(db: Database, sql: string, params: IngestQueryParam[] = []): number {
  const statement = db.prepare<unknown, IngestQueryParam[]>(sql);
  try {
    return Number(statement.run(...params).lastInsertRowid);
  } finally {
    statement.finalize();
  }
}

export function discover(config: IngestConfig): SourceFile[] {
  if (config.sourcePaths != null && config.sourcePaths.length > 0) {
    return discoverSourcePaths(config.sourcePaths);
  }

  const out: SourceFile[] = [];
  collect(config.claudeDir, "claude_code", false, isClaudeSessionFile, out);
  collect(join(config.codexDir, "sessions"), "codex", false, isCodexRollout, out);
  collect(join(config.codexDir, "archived_sessions"), "codex", true, isCodexRollout, out);
  return out;
}

export function discoverSourcePaths(paths: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const path of paths) {
    collectSourcePath(path, out);
  }
  return dedupeSourceFiles(out);
}

export function sync(
  db: Database,
  config: IngestConfig,
  cancel?: { aborted: boolean },
  onProgress?: SyncProgressListener,
): SyncReport {
  seedModelPricing(db);
  const files = discover(config);
  const titles = codexTitles(config);
  const report: SyncReport = {
    scanned: files.length,
    ingested: 0,
    skipped: 0,
    issues: 0,
    issuesByCode: {},
    failed: 0,
    cancelled: false,
  };
  let inspected = 0;
  const emitProgress = (): void =>
    onProgress?.({
      scanned: inspected,
      ingested: report.ingested,
      skipped: report.skipped,
      failed: report.failed,
      total: files.length,
    });

  emitProgress();

  for (const file of files) {
    if (cancel?.aborted === true) {
      report.cancelled = true;
      break;
    }

    try {
      // One descriptor for everything: the skip decision, the recorded stat,
      // and the content read all describe the same inode, so a path swapped
      // mid-loop can neither skip wrongly nor record metadata for content that
      // was never read. A file that vanished before open is a silent skip,
      // matching the old stat-failure path; any other open error counts as
      // failed, matching the old read-failure path.
      let fd: number;
      try {
        fd = openSync(file.path, "r");
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          report.failed += 1;
        }
        continue;
      }
      let stats: Stats;
      let content: string;
      try {
        stats = fstatSync(fd);
        const prior = ingestRow<{ size: number; mtime: number; ingest_revision: number }>(
          db,
          "SELECT size, mtime, ingest_revision FROM ingest_source WHERE path = ?1",
          [file.path],
        );
        if (
          prior != null &&
          prior.size === stats.size &&
          prior.mtime === mtimeSecs(stats) &&
          prior.ingest_revision === INGEST_PIPELINE_REVISION
        ) {
          report.skipped += 1;
          continue;
        }
        // fstat before read: a write landing mid-window records a smaller size
        // than the content read, so the next sync re-ingests instead of
        // silently skipping the tail.
        content = readFileSync(fd, "utf8");
      } catch {
        report.failed += 1;
        continue;
      } finally {
        try {
          closeSync(fd);
        } catch {
          // A close failure (EIO on network/FUSE mounts) cannot invalidate a
          // read that already succeeded, and a throw here would mask the real
          // error on the failure path.
        }
      }

      const stem = fileStem(file.path);
      const parsed =
        file.tool === "claude_code"
          ? parseClaudeSession(stem, content, {
              sourcePath: file.path,
              sidecarMeta: readClaudeSidecarMeta(file.path),
            })
          : parseCodexSession(stem, content, titles);
      parsed.session.isArchived = file.archived;

      const prepared: Prepared = {
        file,
        lineCount: lineCount(content),
        mtime: mtimeSecs(stats),
        size: stats.size,
        hash: hashContent(content),
      };

      const outcome = writeIngestedFile(db, prepared, parsed);
      if (outcome === "tombstoned") {
        report.skipped += 1;
      } else {
        report.ingested += 1;
        report.issues += parsed.issues.length;
        for (const issue of parsed.issues) {
          report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
        }
      }
    } finally {
      inspected += 1;
      emitProgress();
    }
  }

  resolveSubagentParents(db);
  const materializedEconomics = materializeMissingSessionEconomics(db);
  const materializedWindows = materializeMissingContextWindows(db);
  const materializedEfforts = materializeMissingReasoningEfforts(db);
  if (report.ingested > 0) {
    resolveWorktreeRoots(db);
  }
  const uncheckedRecommendationImpactLabels =
    db
      .query(
        `SELECT 1
           FROM recommendation
          WHERE kind = 'signal' AND impact_label_checked = 0
          LIMIT 1`,
      )
      .get() != null;
  if (report.ingested > 0 || uncheckedRecommendationImpactLabels) {
    regenerateRecommendations(db);
  }
  if (
    report.ingested > 0 ||
    materializedEconomics > 0 ||
    materializedWindows > 0 ||
    materializedEfforts > 0
  ) {
    // Refresh planner statistics after write bursts; without ANALYZE data the
    // query planner picks pathological join orders on multi-GB archives.
    db.exec("PRAGMA optimize;");
  }

  return report;
}

/**
 * Insert or replace one parsed session. Returns 0 when the source identity or
 * its provider-recorded parent has a durable deleted tombstone, leaving the
 * archive unchanged and extending that tombstone through the lineage.
 */
export function upsertSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string,
): number {
  return (
    withImmediateTransaction(db, () => writeSession(db, parsed, sourcePath, mtime, size, hash)) ?? 0
  );
}

export function seedModelPricing(db: Database): void {
  const insert = db.prepare(
    `INSERT INTO model_pricing(
       model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
       cache_write_per_mtok, cache_write_1h_per_mtok, source, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'seed', datetime('now'))
     ON CONFLICT(model) DO UPDATE SET
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       cache_read_per_mtok = excluded.cache_read_per_mtok,
       cache_write_per_mtok = excluded.cache_write_per_mtok,
       cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
       updated_at = excluded.updated_at
     WHERE model_pricing.source = 'seed'`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const [model, price] of defaultPricing()) {
        insert.run(
          model,
          price.inputPerMtok,
          price.outputPerMtok,
          price.cacheReadPerMtok,
          price.cacheWritePerMtok,
          price.cacheWrite1hPerMtok,
        );
      }
    });
  } finally {
    insert.finalize();
  }
}

export function resolveSubagentParents(db: Database): void {
  const rows = ingestRows<{
    id: number;
    tool: Tool;
    source_session_id: string;
    raw_meta: string | null;
    source_path: string | null;
    spawn_tool_use_id: string | null;
    agent_id: string | null;
    agent_type: string | null;
    spawn_depth: number | null;
    is_subagent: number;
    first_raw: string | null;
  }>(
    db,
    `SELECT s.id, s.source_session_id, s.raw_meta, s.source_path, s.spawn_tool_use_id,
              s.agent_id, s.agent_type, s.spawn_depth, s.is_subagent,
              s.tool,
              (SELECT m.raw
               FROM message m
               WHERE m.session_id = s.id
               ORDER BY m.seq
               LIMIT 1) AS first_raw
       FROM session s
       WHERE s.tool IN ('claude_code', 'codex')`,
  );

  const sessionBySource = new Map<string, number>();
  const rootByClaudeSession = new Map<string, number>();
  const rootByChild = new Map<number, number>();
  const inferred = new Map<number, InferredSubagent>();
  for (const row of rows) {
    const info = inferSubagent(row);
    inferred.set(row.id, info);
    sessionBySource.set(sourceKey(row.tool, row.source_session_id), row.id);
    if (!info.isSubagent) {
      if (info.rootKey != null) {
        rootByClaudeSession.set(info.rootKey, row.id);
      }
    }
  }

  for (const row of rows) {
    const info = inferred.get(row.id);
    if (info == null || !info.isSubagent) {
      continue;
    }
    const rootKey = info.rootKey;
    const rootId =
      (rootKey == null ? null : rootByClaudeSession.get(rootKey)) ??
      (rootKey == null ? null : sessionBySource.get(sourceKey(row.tool, rootKey))) ??
      null;
    if (rootId != null) {
      rootByChild.set(row.id, rootId);
    }
  }

  const findSpawner = db.prepare(
    `SELECT b.session_id AS session_id
     FROM block b
     JOIN session s ON s.id = b.session_id
     WHERE b.type = 'tool_use' AND b.tool_use_id = ?1
     ORDER BY s.is_subagent DESC, b.id DESC
     LIMIT 1`,
  );
  const findCodexSpawner = db.prepare(
    `SELECT call.tool_use_id AS tool_use_id
     FROM block result
     JOIN block call
       ON call.session_id = result.session_id
      AND call.tool_use_id = result.tool_use_id
      AND call.type = 'tool_use'
     WHERE result.session_id = ?1
       AND result.type = 'tool_result'
       AND call.tool_name = 'spawn_agent'
       AND result.tool_result LIKE ?2
     ORDER BY call.id DESC
     LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE session
     SET is_subagent = ?1,
         parent_session_id = ?2,
         spawn_tool_use_id = COALESCE(spawn_tool_use_id, ?3),
         agent_id = COALESCE(agent_id, ?4),
         agent_type = COALESCE(agent_type, ?5),
         spawn_depth = COALESCE(spawn_depth, ?6)
     WHERE id = ?7`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const row of rows) {
        const info = inferred.get(row.id);
        if (info == null || !info.isSubagent) {
          continue;
        }
        const rootId = rootByChild.get(row.id) ?? null;
        let parentId: number | null = null;
        let spawnToolUseId = info.spawnToolUseId;
        if (spawnToolUseId == null && row.tool === "codex" && rootId != null) {
          const spawner = findCodexSpawner.get(rootId, `%${row.source_session_id}%`) as {
            tool_use_id: string;
          } | null;
          spawnToolUseId = spawner?.tool_use_id ?? null;
        }
        if (spawnToolUseId != null) {
          const spawner = findSpawner.get(spawnToolUseId) as { session_id: number } | null;
          if (spawner != null && spawner.session_id !== row.id) {
            parentId = spawner.session_id;
          }
        }
        parentId ??= rootId;
        update.run(
          1,
          parentId === row.id ? null : parentId,
          spawnToolUseId,
          info.agentId,
          info.agentType,
          info.spawnDepth,
          row.id,
        );
      }
    });
  } finally {
    update.finalize();
    findCodexSpawner.finalize();
    findSpawner.finalize();
  }
}

/** One-time schema-upgrade backfill. Effort lives only in source records, so
 * unchanged sessions cannot recover it from the archive itself. The checked
 * marker prevents source files that genuinely omit effort from being reparsed
 * on every sync, while normal re-ingest refreshes the value when a file grows. */
export function materializeMissingReasoningEfforts(db: Database): number {
  const pendingStatement = db.prepare(
    `SELECT id, tool, source_session_id, source_path
       FROM session
       WHERE reasoning_effort_checked = 0`,
  );
  let rows: {
    id: number;
    tool: Tool;
    source_session_id: string;
    source_path: string | null;
  }[];
  try {
    rows = pendingStatement.all() as typeof rows;
  } finally {
    pendingStatement.finalize();
  }
  if (rows.length === 0) {
    return 0;
  }

  const efforts = rows.map((row) => {
    let effort: ReasoningEffortSummary = { summary: null, levels: [] };
    if (row.source_path != null) {
      try {
        effort = reasoningEffortFromSource(row.tool, row.source_path);
      } catch {
        // Missing/unreadable source files are a stable unavailable state.
      }
    }
    return { id: row.id, ...effort };
  });

  const update = db.prepare(
    `UPDATE session
     SET reasoning_effort = ?2, reasoning_effort_levels = ?3, reasoning_effort_checked = 1
     WHERE id = ?1`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const row of efforts) {
        update.run(row.id, row.summary, canonicalJson(row.levels));
      }
    });
  } finally {
    update.finalize();
  }
  return rows.length;
}

/** Narrow source scan for the one-time effort backfill. It avoids rebuilding
 * every message/block/tool object from a potentially multi-GB archive and
 * leaves the database write transaction for the small update batch only. */
interface ReasoningEffortSummary {
  summary: string | null;
  levels: string[];
}

function reasoningEffortFromSource(tool: Tool, path: string): ReasoningEffortSummary {
  const efforts = new Set<string>();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const fd = openSync(path, "r");
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        collectReasoningEffort(tool, pending.slice(0, newline), efforts);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    collectReasoningEffort(tool, pending + decoder.end(), efforts);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort cleanup: preserve the scan result or original read error.
    }
  }
  const levels = reasoningEffortLevels(efforts);
  return { summary: summarizeReasoningEfforts(levels), levels };
}

function collectReasoningEffort(tool: Tool, line: string, efforts: Set<string>): void {
  if (line.trim() === "") {
    return;
  }
  try {
    const value = JSON.parse(line) as Json;
    const effort =
      tool === "claude_code"
        ? recordedReasoningEffort(get(value, "effort"))
        : recordedReasoningEffort(get(get(value, "payload"), "effort"));
    if (
      effort != null &&
      (tool === "claude_code" || asString(get(value, "type")) === "turn_context")
    ) {
      efforts.add(effort);
    }
  } catch {
    // Parser parity: malformed source rows do not hide valid effort labels.
  }
}

function sourceKey(tool: Tool, sourceSessionId: string): string {
  return `${tool}\0${sourceSessionId}`;
}

interface InferredSubagent {
  isSubagent: boolean;
  rootKey: string | null;
  spawnToolUseId: string | null;
  agentId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
}

function inferSubagent(row: {
  tool: Tool;
  source_session_id: string;
  raw_meta: string | null;
  source_path: string | null;
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  is_subagent: number;
  first_raw: string | null;
}): InferredSubagent {
  const meta = parseObject(row.raw_meta);
  const first = parseObject(row.first_raw);
  const source = get(meta, "source");
  const subagentSource = get(source, "subagent");
  const threadSpawn = get(subagentSource, "thread_spawn");
  const parentThreadId =
    asString(get(meta, "parent_thread_id")) ?? asString(get(threadSpawn, "parent_thread_id"));
  const fromPath = row.source_path != null && /(?:^|[/\\])subagents(?:[/\\])/.test(row.source_path);
  const isSubagent =
    row.is_subagent !== 0 ||
    fromPath ||
    asBoolean(get(meta, "isSubagent")) === true ||
    asBoolean(get(first, "isSidechain")) === true ||
    subagentSource !== undefined ||
    parentThreadId != null;
  return {
    isSubagent,
    rootKey:
      parentThreadId ?? asString(get(meta, "sessionId")) ?? asString(get(first, "sessionId")),
    spawnToolUseId:
      row.spawn_tool_use_id ??
      asString(get(meta, "spawnToolUseId")) ??
      asString(get(meta, "toolUseId")),
    agentId:
      row.agent_id ??
      asString(get(meta, "agent_nickname")) ??
      asString(get(threadSpawn, "agent_nickname")) ??
      asString(get(meta, "agentId")) ??
      asString(get(first, "agentId")) ??
      (isSubagent && row.tool === "codex" ? row.source_session_id : null),
    agentType:
      row.agent_type ??
      asString(get(meta, "agent_role")) ??
      asString(get(threadSpawn, "agent_role")) ??
      asString(subagentSource) ??
      asString(get(meta, "agentType")) ??
      asString(get(meta, "subagentType")) ??
      asString(get(meta, "subagent_type")),
    spawnDepth:
      row.spawn_depth ?? asInteger(get(threadSpawn, "depth")) ?? asInteger(get(meta, "spawnDepth")),
  };
}

function writeIngestedFile(
  db: Database,
  prepared: Prepared,
  parsed: ParsedSession,
): "ingested" | "tombstoned" {
  return withImmediateTransaction(db, () => {
    runIngestStatement(db, "UPDATE ingest_source SET session_id = NULL WHERE path = ?1", [
      prepared.file.path,
    ]);
    const sessionId = writeSession(
      db,
      parsed,
      prepared.file.path,
      prepared.mtime,
      prepared.size,
      prepared.hash,
    );
    if (sessionId == null) {
      runIngestStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [
        prepared.file.path,
      ]);
      writeIngestSource(db, prepared, null, "skipped_deleted");
      return "tombstoned";
    }
    runIngestStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [prepared.file.path]);
    const insertIssue = db.prepare(
      `INSERT INTO ingest_issue(source_path, line_no, error, raw_line, code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    );
    try {
      for (const issue of parsed.issues) {
        insertIssue.run(prepared.file.path, issue.lineNo, issue.error, issue.rawLine, issue.code);
      }
    } finally {
      insertIssue.finalize();
    }
    const status = parsed.issues.length === 0 ? "ok" : "ok_with_issues";
    writeIngestSource(db, prepared, sessionId, status);
    return "ingested";
  });
}

function writeIngestSource(
  db: Database,
  prepared: Prepared,
  sessionId: number | null,
  status: string,
): void {
  runIngestStatement(
    db,
    `INSERT INTO ingest_source(
       path, tool, size, mtime, hash, ingest_revision, session_id, line_count, status,
       last_ingested_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       tool = ?2, size = ?3, mtime = ?4, hash = ?5, ingest_revision = ?6,
       session_id = ?7, line_count = ?8, status = ?9, error = NULL,
       last_ingested_at = datetime('now')`,
    [
      prepared.file.path,
      prepared.file.tool,
      prepared.size,
      prepared.mtime,
      prepared.hash,
      INGEST_PIPELINE_REVISION,
      sessionId,
      prepared.lineCount,
      status,
    ],
  );
}

function writeSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string,
): number | null {
  const s = parsed.session;
  if (
    inheritDeletedSessionTombstone(
      db,
      s.tool,
      s.sourceSessionId,
      s.isSubagent ? s.rootSourceSessionId : null,
      {
        rootSourceSessionId: s.rootSourceSessionId,
        spawnToolUseId: s.spawnToolUseId,
        ownedSpawnToolUseIds: claudeSpawnToolUseIds(parsed),
      },
    )
  ) {
    return null;
  }
  let projectId: number | null = null;
  if (s.projectPath != null) {
    runIngestStatement(
      db,
      `INSERT INTO project(path, name, first_seen_at, last_seen_at)
       VALUES (?1, ?2, datetime('now'), datetime('now'))
       ON CONFLICT(path) DO UPDATE SET last_seen_at = datetime('now')`,
      [s.projectPath, basename(s.projectPath)],
    );
    projectId =
      ingestRow<{ id: number }>(db, "SELECT id FROM project WHERE path = ?1", [s.projectPath])
        ?.id ?? null;
  }

  const existing = ingestRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = ?1 AND source_session_id = ?2",
    [s.tool, s.sourceSessionId],
  );
  if (existing != null) {
    runIngestStatement(
      db,
      "UPDATE session SET parent_session_id = NULL WHERE parent_session_id = ?1",
      [existing.id],
    );
  }
  runIngestStatement(db, "DELETE FROM session WHERE tool = ?1 AND source_session_id = ?2", [
    s.tool,
    s.sourceSessionId,
  ]);

  const refs = fileRefs(s);
  const gotFacets = facets(s);
  const gotOutcome = outcome(s);
  const gotWorkType = workType(s, refs);
  const cost = estimateCost(s.model, s.totals, defaultPricing());

  const sessionId = runIngestStatement(
    db,
    `INSERT INTO session(
       tool, source_session_id, project_id, title, cwd, git_branch, model, cli_version,
       started_at, ended_at, message_count,
       total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
       total_reasoning_tokens,
       estimated_cost_usd, is_archived,
       is_subagent, parent_session_id, spawn_tool_use_id, agent_id, agent_type, spawn_depth,
       source_path, raw_meta,
       ingested_at, source_mtime, source_size, source_hash,
       turn_count, error_count, interruption_count, compaction_count, sidechain_message_count,
       agent_spawn_count, skill_count, command_count, thinking_block_count, thinking_chars,
       active_seconds, outcome, work_type,
       est_reasoning_tokens, reasoning_source,
       id,
       total_cache_creation_1h_tokens,
       reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, datetime('now'), ?27, ?28, ?29, ?30, ?31,
             ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, 1)`,
    [
      s.tool,
      s.sourceSessionId,
      projectId,
      s.title,
      s.cwd,
      s.gitBranch,
      s.model,
      s.cliVersion,
      s.startedAt,
      s.endedAt,
      s.messages.length,
      s.totals.input,
      s.totals.output,
      s.totals.cacheRead,
      s.totals.cacheCreation,
      s.totals.reasoning,
      cost,
      Number(s.isArchived),
      Number(s.isSubagent),
      null,
      s.spawnToolUseId,
      s.agentId,
      s.agentType,
      s.spawnDepth,
      sourcePath,
      canonicalJson(s.rawMeta),
      mtime,
      size,
      hash,
      gotFacets.turnCount,
      gotFacets.errorCount,
      gotFacets.interruptionCount,
      gotFacets.compactionCount,
      gotFacets.sidechainMessageCount,
      gotFacets.agentSpawnCount,
      gotFacets.skillCount,
      gotFacets.commandCount,
      gotFacets.thinkingBlockCount,
      gotFacets.thinkingChars,
      gotFacets.activeSeconds,
      gotOutcome,
      gotWorkType,
      s.estReasoningTokens,
      s.reasoningSource,
      existing?.id ?? null,
      s.totals.cacheCreation1h,
      s.reasoningEffort,
      canonicalJson(s.reasoningEffortLevels),
    ],
  );

  const results = new Map<string, number>();
  const resultErrors = new Map<string, boolean | null>();
  const resultText = new Map<string, string>();
  const resultTimestamps = new Map<string, string | null>();
  const toolUseBlocks: ToolUseBlock[] = [];
  const messageIds: number[] = [];

  const insertMessage = db.prepare(
    `INSERT INTO message(
       session_id, seq, source_uuid, parent_source_uuid, role, model, stop_reason,
       timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO block(
       message_id, session_id, ordinal, type, text, tool_name, tool_use_id, tool_input, tool_result
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );

  try {
    for (const message of s.messages) {
      const messageId = Number(
        insertMessage.run(
          sessionId,
          message.seq,
          message.sourceUuid,
          message.parentSourceUuid,
          message.role,
          message.model,
          message.stopReason,
          message.timestamp,
          message.usage?.input ?? null,
          message.usage?.output ?? null,
          message.usage?.cacheRead ?? null,
          message.usage?.cacheCreation ?? null,
          canonicalJson(message.raw),
        ).lastInsertRowid,
      );
      messageIds.push(messageId);

      for (const block of message.blocks) {
        const blockId = Number(
          insertBlock.run(
            messageId,
            sessionId,
            block.ordinal,
            block.blockType,
            block.text,
            block.toolName,
            block.toolUseId,
            block.toolInput === undefined ? null : canonicalJson(block.toolInput),
            block.toolResult,
          ).lastInsertRowid,
        );
        if (block.blockType === "tool_use") {
          toolUseBlocks.push({
            messageId,
            callBlockId: blockId,
            timestamp: message.timestamp,
            block,
          });
        } else if (block.blockType === "tool_result" && block.toolUseId != null) {
          results.set(block.toolUseId, blockId);
          resultErrors.set(block.toolUseId, block.isError);
          resultText.set(block.toolUseId, block.toolResult ?? "");
          resultTimestamps.set(block.toolUseId, message.timestamp);
        }
      }
    }
  } finally {
    insertBlock.finalize();
    insertMessage.finalize();
  }

  const insertToolCall = db.prepare(
    `INSERT INTO tool_call(
       session_id, message_id, call_block_id, result_block_id, tool_kind, tool_name,
       mcp_server, tool_base_name, tool_use_id, input, input_bytes, is_error, has_result,
       output_preview, output_bytes, duration_ms, ordinal, timestamp
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  );
  try {
    for (const call of toolUseBlocks) {
      const name = call.block.toolName ?? "";
      const classified = classifyTool(name);
      const resultBlockId =
        call.block.toolUseId == null ? null : (results.get(call.block.toolUseId) ?? null);
      const isError =
        call.block.toolUseId == null || !resultErrors.has(call.block.toolUseId)
          ? null
          : resultErrors.get(call.block.toolUseId);
      const output =
        call.block.toolUseId == null ? null : (resultText.get(call.block.toolUseId) ?? null);
      const input = call.block.toolInput === undefined ? null : canonicalJson(call.block.toolInput);
      const resultTimestamp =
        call.block.toolUseId == null ? null : (resultTimestamps.get(call.block.toolUseId) ?? null);
      insertToolCall.run(
        sessionId,
        call.messageId,
        call.callBlockId,
        resultBlockId,
        classified.kind,
        name,
        classified.mcpServer,
        classified.baseName,
        call.block.toolUseId,
        input,
        input == null ? null : byteLength(input),
        isError == null ? null : Number(isError),
        Number(resultBlockId != null),
        output == null ? null : previewHeadTail(output, 500),
        output == null ? null : byteLength(output),
        durationBetween(call.timestamp, resultTimestamp),
        call.block.ordinal,
        call.timestamp,
      );
    }
  } finally {
    insertToolCall.finalize();
  }

  const insertFileRef = db.prepare(
    `INSERT INTO file_ref(session_id, message_id, path, rel_path, ext, operation, timestamp)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );
  try {
    for (const ref of refs) {
      insertFileRef.run(
        sessionId,
        messageIds[ref.messageIdx] ?? null,
        ref.path,
        ref.relPath,
        ref.ext,
        ref.operation,
        ref.timestamp,
      );
    }
  } finally {
    insertFileRef.finalize();
  }

  materializeSessionEconomics(db, sessionId);
  materializeContextWindow(db, sessionId);

  return sessionId;
}

function claudeSpawnToolUseIds(parsed: ParsedSession): string[] {
  if (parsed.session.tool !== "claude_code") {
    return [];
  }
  const spawnToolUseIds = new Set<string>();
  for (const message of parsed.session.messages) {
    for (const block of message.blocks) {
      if (
        block.blockType === "tool_use" &&
        (block.toolName === "Task" || block.toolName === "Agent") &&
        block.toolUseId != null
      ) {
        spawnToolUseIds.add(block.toolUseId);
      }
    }
  }
  return [...spawnToolUseIds];
}

function collect(
  root: string,
  tool: Tool,
  archived: boolean,
  want: (name: string) => boolean,
  out: SourceFile[],
): void {
  if (!existsSync(root)) {
    return;
  }
  for (const path of walk(root)) {
    const name = pathBasename(path);
    if (want(name)) {
      out.push({ tool, path, archived });
    }
  }
}

function collectSourcePath(path: string, out: SourceFile[]): void {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isFile()) {
    const source = sourceFileForPath(path);
    if (source != null) {
      out.push(source);
    }
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  for (const child of walk(path)) {
    const source = sourceFileForPath(child);
    if (source != null) {
      out.push(source);
    }
  }
}

function sourceFileForPath(path: string): SourceFile | null {
  const name = pathBasename(path);
  if (!name.endsWith(".jsonl") || name === "session_index.jsonl" || name === "journal.jsonl") {
    return null;
  }
  if (isCodexRollout(name)) {
    return { tool: "codex", path, archived: hasPathSegment(path, "archived_sessions") };
  }
  return { tool: "claude_code", path, archived: false };
}

function dedupeSourceFiles(files: SourceFile[]): SourceFile[] {
  const seen = new Set<string>();
  const unique: SourceFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) {
      continue;
    }
    seen.add(file.path);
    unique.push(file);
  }
  return unique;
}

/** Claude Code also writes non-session JSONL into the projects tree; the only
 * one today is the dynamic-workflow orchestration journal
 * (subagents/workflows/<runId>/journal.jsonl). Session transcripts are
 * <uuid>.jsonl mains and agent-*.jsonl subagents, which must keep flowing. */
function isClaudeSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && name !== "journal.jsonl";
}

function isCodexRollout(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

function hasPathSegment(path: string, segment: string): boolean {
  return path.split(/[\\/]+/).includes(segment);
}

function readClaudeSidecarMeta(path: string): Json | null {
  if (!path.endsWith(".jsonl")) {
    return null;
  }
  const metaPath = `${path.slice(0, -".jsonl".length)}.meta.json`;
  let content: string;
  try {
    content = readFileSync(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as Json;
  } catch {
    return null;
  }
}

function walk(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    compareCodePoints(left.name, right.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function codexTitles(config: IngestConfig): Map<string, string> {
  const titles = new Map<string, string>();
  const path = join(config.codexDir, "session_index.jsonl");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return titles;
  }
  for (const line of content.split(/\n/)) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const value = JSON.parse(line) as Json;
      const id = asString(get(value, "id"));
      const threadName = asString(get(value, "thread_name"));
      if (id != null && threadName != null) {
        titles.set(id, threadName);
      }
    } catch {
      // Corrupt session-index rows should not make session ingest fail.
    }
  }
  return titles;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? path;
}

function fileStem(path: string): string {
  const base = pathBasename(path);
  const ext = extname(base);
  return ext === "" ? base : base.slice(0, -ext.length);
}

function lineCount(content: string): number {
  if (content === "") {
    return 0;
  }
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split(/\r?\n/).length;
}

function mtimeSecs(stats: Stats): number {
  return Math.trunc(stats.mtimeMs / 1000);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (start == null || end == null) {
    return null;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseObject(value: string | null): Json | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return undefined;
  }
}

function get(value: Json | undefined, key: string): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value[key] as Json | undefined)
    : undefined;
}
