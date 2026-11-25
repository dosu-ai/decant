import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, basename as pathBasename, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  reconcileBilledRequests,
  releaseBilledRequests,
  unsettledRequests,
} from "./billed-requests.ts";
import { countSearchCandidateToolCall, isSearchCandidateTool } from "./buckets.ts";
import { outcome, workType } from "./classify.ts";
import { materializeContextWindow, materializeMissingContextWindows } from "./context-window.ts";
import { defaultPricing } from "./cost.ts";
import { refreshPlannerStatistics, withImmediateTransaction } from "./db.ts";
import { countToolUseBlocks, facets, fileRefs, isRenderableReply } from "./enrich.ts";
import {
  buildAndPersistCheckpointAfterFullWrite,
  type FullParseWithCheckpointResult,
  type FullWriteArtifact,
  isIncrementalTool,
  parseFullForCheckpoint,
  readSourceBuffer,
  tryIncrementalIngest,
} from "./incremental-ingest.ts";
import { FILE_LIMIT_MESSAGE, readSourceFile } from "./ingest-limits.ts";
import { asBoolean, asInteger, asString, byteLength, canonicalJson, get } from "./json.ts";
import { getDecantLogger } from "./logging.ts";
import {
  backfillCopilotCompactionMetadata,
  decodeMessageRaw,
  encodeMessageRaw,
  MESSAGE_METADATA_SQL,
} from "./message-storage.ts";
import {
  type IngestIssueCode,
  type Issue,
  type Json,
  type NormalizedBlock,
  type ParsedSession,
  reasoningEffortLevels,
  recordedReasoningEffort,
  summarizeReasoningEfforts,
  type Tool,
} from "./model.ts";
import {
  materializeMissingModelUsage,
  materializeModelUsage,
  sessionCostParts,
  totalCost,
} from "./model-usage.ts";
import { compareCodePoints } from "./order.ts";
import { regenerate as regenerateRecommendations } from "./recommendations.ts";
import { resolveProjectRemotes } from "./repo-remote.ts";
import { inheritDeletedSessionTombstone } from "./session-user-state.ts";
import { parseAtifDocument } from "./sources/atif.ts";
import { parseClaudeSession } from "./sources/claude.ts";
import { forkHistoryStart, parseCodexSession } from "./sources/codex.ts";
import { parseCopilotSession } from "./sources/copilot.ts";
import {
  type CursorSource,
  CursorSourceError,
  parseCursorSession,
  readCursorSource,
} from "./sources/cursor.ts";
import { parseGeminiSession } from "./sources/gemini.ts";
import { parseHermesSession } from "./sources/hermes.ts";
import {
  type HermesLoadedSession,
  type HermesSessionRef,
  HermesStore,
  HermesStoreError,
} from "./sources/hermes-store.ts";
import { parseOpenCodeSession } from "./sources/opencode.ts";
import { parseOpenCodeLegacySession } from "./sources/opencode-legacy.ts";
import {
  type OpenCodeLegacyLoadedSession,
  type OpenCodeLoadedSession,
  OpenCodeMcpServerNames,
  type OpenCodeSessionRef,
  OpenCodeStore,
  readOpenCodeModelsCache,
} from "./sources/opencode-store.ts";
import { parsePiSession, piSessionIdFromStem } from "./sources/pi.ts";
import { parseVscodeCopilotSession } from "./sources/vscode-copilot.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";
import {
  materializeMissingSessionEconomics,
  materializeSessionEconomics,
  refreshSessionCosts,
} from "./token-economics.ts";
import { classifyTool, previewHeadTail } from "./tools.ts";
import { basename, resolveWorktreeRoots } from "./worktree.ts";

const logger = getDecantLogger("ingest");

export type DiscoveryWarn = (message: string, properties: Record<string, unknown>) => void;

const logDiscoveryWarning: DiscoveryWarn = (message, properties) =>
  logger.warning(message, properties);

export interface IngestConfig {
  claudeDir: string;
  codexDir: string;
  geminiDir?: string;
  opencodeDir?: string;
  opencodeDb?: string;
  opencodeConfigDir?: string;
  opencodeConfigPath?: string;
  opencodeExtraConfigPath?: string;
  opencodeModelsPath?: string;
  cursorDir?: string;
  copilotDir?: string;
  vscodeCopilotDir?: string;
  vscodeCopilotInsidersDir?: string;
  atifDir?: string;
  hermesDir?: string;
  piDir?: string;
  sourcePaths?: string[];
}

export const INGEST_PIPELINE_REVISION = 22;

export interface SyncReport {
  repriced?: number;
  scanned: number;
  ingested: number;
  skipped: number;
  issues: number;
  issuesByCode: Partial<Record<IngestIssueCode, number>>;
  failed: number;
  cancelled: boolean;
}

export interface SyncProgress {
  scanned: number;
  ingested: number;
  skipped: number;
  failed: number;
  total: number;
}

export type SyncProgressListener = (progress: SyncProgress) => void;

export interface SyncOptions {
  candidatePaths?: readonly string[];
  deferDerivedRefresh?: boolean;
  recommendationMinIntervalMs?: number;
  onSessionChanged?: (sessionId: number) => void;
  onTombstoned?: () => void;
}

export interface SourceFile {
  tool: Tool;
  path: string;
  archived: boolean;
  opencode?: OpenCodeSessionRef;
  hermes?: HermesSessionRef;
  hermesUnreadable?: ReadonlySet<string>;
  hermesPartialDiscovery?: { listed: ReadonlySet<string> };
}

interface Prepared {
  file: SourceFile;
  lineCount: number;
  mtime: number;
  size: number;
  hash?: string | null;
}

interface ToolUseBlock {
  messageId: number;
  messageSeq: number;
  callBlockId: number;
  order: number;
  timestamp: string | null;
  block: NormalizedBlock;
}

export function discover(
  config: IngestConfig,
  warn: DiscoveryWarn = logDiscoveryWarning,
): SourceFile[] {
  if (config.sourcePaths != null && config.sourcePaths.length > 0) {
    return discoverSourcePaths(
      config.sourcePaths,
      warn,
      config.copilotDir,
      [config.vscodeCopilotDir, config.vscodeCopilotInsidersDir],
      config.piDir,
    );
  }

  const out: SourceFile[] = [];
  collect(config.claudeDir, "claude_code", false, isSessionJsonl, out);
  collect(join(config.codexDir, "sessions"), "codex", false, isCodexRollout, out);
  collect(join(config.codexDir, "archived_sessions"), "codex", true, isCodexRollout, out);
  if (config.geminiDir != null) {
    collectGemini(config.geminiDir, out);
  }
  out.push(...discoverOpenCode(openCodeDatabasePaths(config), warn));
  const hermes = listHermesDatabases(config.hermesDir);
  out.push(...discoverHermes(hermes.paths, warn, hermes.unlistedProfiles));
  if (config.cursorDir != null) {
    collect(config.cursorDir, "cursor", false, (name) => name === CURSOR_STORE_NAME, out);
  }
  if (config.copilotDir != null) {
    collectCopilot(config.copilotDir, out);
  }
  collectVscodeCopilot([config.vscodeCopilotDir, config.vscodeCopilotInsidersDir], out);
  if (config.atifDir != null) {
    collect(config.atifDir, "atif", false, () => true, out);
  }
  if (config.piDir != null) {
    collect(config.piDir, "pi", false, isSessionJsonl, out);
  }
  return out.filter(
    (file) =>
      (file.tool !== "cursor" || isCursorConversationStore(file.path)) &&
      (file.tool !== "atif" || isAtifDocument(file.path)),
  );
}

export function discoverSourcePaths(
  paths: string[],
  warn: DiscoveryWarn = logDiscoveryWarning,
  copilotDir?: string,
  vscodeUserDirs: readonly (string | undefined)[] = [],
  piDir?: string,
): SourceFile[] {
  const out: SourceFile[] = [];
  const databases: string[] = [];
  const hermesDatabases: string[] = [];
  for (const path of paths) {
    collectSourcePath(path, out, databases, hermesDatabases, {
      copilotDir,
      vscodeUserDirs,
      piDir,
    });
  }
  return [
    ...preferVscodeLogs(dedupeSourceFiles(out)),
    ...discoverOpenCode(databases, warn),
    ...discoverHermes(hermesDatabases, warn),
  ];
}

/** Hermes keeps one `state.db` per profile: the default profile's in the home
 * directory and each named profile's under `profiles/<name>/`. A name starting
 * with `.` is Hermes's own bookkeeping (`profiles/.deleted`), not a profile. */
export function hermesDatabasePaths(hermesDir: string | undefined): string[] {
  return listHermesDatabases(hermesDir).paths;
}

interface HermesDatabases {
  paths: string[];
  unlistedProfiles: UnlistedDirectory | null;
}

interface UnlistedDirectory {
  path: string;
  errorCode: string;
}

function listHermesDatabases(hermesDir: string | undefined): HermesDatabases {
  if (hermesDir == null || hermesDir === "") {
    return { paths: [], unlistedProfiles: null };
  }
  const paths = [join(hermesDir, HERMES_DATABASE_NAME)];
  const profilesDir = join(hermesDir, "profiles");
  let profiles: string[];
  try {
    profiles = readdirSync(profilesDir);
  } catch (error) {
    const code = errorCode(error);
    return {
      paths,
      unlistedProfiles: code === "ENOENT" ? null : { path: profilesDir, errorCode: code },
    };
  }
  for (const name of profiles.sort(compareCodePoints)) {
    if (!name.startsWith(".")) {
      paths.push(join(profilesDir, name, HERMES_DATABASE_NAME));
    }
  }
  return { paths, unlistedProfiles: null };
}

export const HERMES_DATABASE_NAME = "state.db";

export function hermesSourcePath(ref: HermesSessionRef): string {
  return `${ref.dbPath}#${ref.sessionId}`;
}

function discoverHermes(
  dbPaths: string[],
  warn: DiscoveryWarn,
  unlistedProfiles: UnlistedDirectory | null = null,
): SourceFile[] {
  const best = new Map<string, HermesSessionRef>();
  const unreadable = new Set<string>();
  if (unlistedProfiles != null) {
    warn("Hermes profiles could not be listed.", {
      "event.name": "decant.ingest.hermes_profiles_unlisted",
      "file.path": unlistedProfiles.path,
      "error.code": unlistedProfiles.errorCode,
    });
  }
  const listed = new Set<string>();
  for (const dbPath of new Set(dbPaths.map(canonicalPath))) {
    let store: HermesStore;
    try {
      statSync(dbPath);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      unreadable.add(dbPath);
      warn("Hermes database could not be opened.", {
        "event.name": "decant.ingest.hermes_open_failed",
        "file.path": dbPath,
        "error.message": `Hermes database could not be read (${code})`,
      });
      continue;
    }
    try {
      store = HermesStore.open(dbPath);
    } catch (error) {
      unreadable.add(dbPath);
      warn("Hermes database could not be opened.", {
        "event.name": "decant.ingest.hermes_open_failed",
        "file.path": dbPath,
        "error.message": hermesErrorMessage(error),
      });
      continue;
    }
    try {
      const refs = store.listSessions();
      listed.add(dbPath);
      for (const ref of refs) {
        const prior = best.get(ref.sessionId);
        if (
          prior == null ||
          ref.activity > prior.activity ||
          (ref.activity === prior.activity && compareCodePoints(ref.dbPath, prior.dbPath) < 0)
        ) {
          best.set(ref.sessionId, ref);
        }
      }
    } catch (error) {
      unreadable.add(dbPath);
      warn("Hermes database could not be listed.", {
        "event.name": "decant.ingest.hermes_list_failed",
        "file.path": dbPath,
        "error.message": hermesErrorMessage(error),
      });
    } finally {
      store.close();
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        compareCodePoints(a.dbPath, b.dbPath) || compareCodePoints(a.sessionId, b.sessionId),
    )
    .map((ref) => ({
      tool: "hermes" as const,
      path: hermesSourcePath(ref),
      archived: false,
      hermes: ref,
      hermesUnreadable: unreadable,
      hermesPartialDiscovery: unlistedProfiles == null ? undefined : { listed },
    }));
}

function hermesErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openCodeDatabasePaths(config: IngestConfig): string[] {
  const paths: string[] = [];
  if (config.opencodeDir != null && existsSync(config.opencodeDir)) {
    let entries: string[];
    try {
      entries = readdirSync(config.opencodeDir);
    } catch {
      entries = [];
    }
    for (const name of entries.sort(compareCodePoints)) {
      if (isOpenCodeDatabaseName(name)) {
        paths.push(join(config.opencodeDir, name));
      }
    }
  }
  if (config.opencodeDb != null && config.opencodeDb !== "" && !paths.includes(config.opencodeDb)) {
    paths.push(config.opencodeDb);
  }
  return paths;
}

const OPENCODE_DATABASE_NAME = /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/;

export function isOpenCodeDatabaseName(name: string): boolean {
  return OPENCODE_DATABASE_NAME.test(name);
}

export function openCodeSourcePath(ref: OpenCodeSessionRef): string {
  return `${ref.dbPath}#${ref.sessionId}`;
}

function discoverOpenCode(dbPaths: string[], warn: DiscoveryWarn): SourceFile[] {
  const best = new Map<string, OpenCodeSessionRef>();
  for (const dbPath of new Set(dbPaths.map(canonicalPath))) {
    if (!existsSync(dbPath)) {
      continue;
    }
    let store: OpenCodeStore;
    try {
      store = OpenCodeStore.open(dbPath);
    } catch (error) {
      warn("OpenCode database could not be opened.", {
        "event.name": "decant.ingest.opencode_open_failed",
        "file.path": dbPath,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      if (store.isPreSplitDatabase()) {
        // Its `session` rows are 2.x-shaped, so the 1.x reader would misread
        // them; OpenCode converts the file the next time a 2.x release opens it.
        warn("OpenCode database uses a pre-release layout and was skipped.", {
          "event.name": "decant.ingest.opencode_unsupported_layout",
          "file.path": dbPath,
        });
        continue;
      }
      const keepNewest = (ref: OpenCodeSessionRef): void => {
        const prior = best.get(ref.sessionId);
        if (prior == null || isNewerOpenCodeCopy(ref, prior)) {
          best.set(ref.sessionId, ref);
        }
      };
      let legacy: OpenCodeSessionRef[] = [];
      let legacyError: unknown = null;
      try {
        legacy = store.listLegacySessions();
      } catch (error) {
        legacyError = error;
      }
      store.listSessions(legacy).forEach(keepNewest);
      legacy.forEach(keepNewest);
      if (legacyError != null) {
        throw legacyError;
      }
    } catch (error) {
      warn("OpenCode database could not be listed.", {
        "event.name": "decant.ingest.opencode_list_failed",
        "file.path": dbPath,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    } finally {
      store.close();
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        compareCodePoints(a.dbPath, b.dbPath) || compareCodePoints(a.sessionId, b.sessionId),
    )
    .map((ref) => ({
      tool: "opencode" as const,
      path: openCodeSourcePath(ref),
      archived: false,
      opencode: ref,
    }));
}

/** Newest `time_updated` wins, across formats as well as databases: a 1.x
 * binary can keep writing a session after a 2.x build migrated it. A tie in
 * one database goes to the 2.x copy, because the migrator copies
 * `time_updated` verbatim, so a tie is the usual state of a migrated session.
 * A tie across databases goes to the code-point-smaller path. Either way the
 * winner never depends on discovery order. */
function isNewerOpenCodeCopy(ref: OpenCodeSessionRef, prior: OpenCodeSessionRef): boolean {
  if (ref.timeUpdated !== prior.timeUpdated) {
    return ref.timeUpdated > prior.timeUpdated;
  }
  if (ref.dbPath === prior.dbPath) {
    return ref.format === "v2" && prior.format === "v1";
  }
  return compareCodePoints(ref.dbPath, prior.dbPath) < 0;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Sessions written between mid-sync `PRAGMA optimize` calls. A new archive has
 * no sqlite_stat1 rows, and without them the planner reads per-message block
 * lookups through idx_block_type, which makes a cold sync quadratic in the
 * archive size. Calls that find nothing to analyze cost nothing measurable. What
 * costs time is the stretch before the first refresh: a cold sync of 500
 * synthetic sessions took about 5s with an interval of 10, 25, or 50, 6.7s at
 * 100, and 12s at 200.
 */
const PLANNER_STATISTICS_INTERVAL = 25;

const initializedSyncConnections = new WeakSet<Database>();
const recommendationsDirtyConnections = new WeakSet<Database>();
const lastRecommendationRefreshByDb = new WeakMap<Database, number>();
const ingestsSinceOptimizeByDb = new WeakMap<Database, number>();

export function sync(
  db: Database,
  config: IngestConfig,
  cancel?: { aborted: boolean },
  onProgress?: SyncProgressListener,
  options?: SyncOptions,
): SyncReport {
  const alreadyInitialized = initializedSyncConnections.has(db);
  const backgroundRefresh =
    alreadyInitialized &&
    (options?.deferDerivedRefresh === true || (options?.recommendationMinIntervalMs ?? 0) > 0);
  let repriced = 0;
  if (!backgroundRefresh) {
    seedModelPricing(db);
    materializeMissingModelUsage(db, (id) =>
      reconcileBilledRequests(db, id, { refreshReconciledSession: true }),
    );
    repriced = refreshSessionCosts(db);
  }
  const candidatePaths = options?.candidatePaths;
  const targeted = candidatePaths != null && candidatePaths.length > 0;
  const files = targeted
    ? discoverSourcePaths(
        [...candidatePaths],
        logDiscoveryWarning,
        config.copilotDir,
        [config.vscodeCopilotDir, config.vscodeCopilotInsidersDir],
        config.piDir,
      )
    : discover(config);
  const needsCodexTitles = files.some((file) => file.tool === "codex");
  const titles = needsCodexTitles ? codexTitles(config) : new Map<string, string>();
  const mcpServers = new OpenCodeMcpServerNames({
    globalDir: config.opencodeConfigDir,
    globalFile: config.opencodeConfigPath,
    extraFile: config.opencodeExtraConfigPath,
  });
  const opencode = new OpenCodeRun(db, config.opencodeModelsPath);
  const hermes = new HermesRun(db);
  const report: SyncReport = {
    ...(repriced > 0 ? { repriced } : {}),
    scanned: files.length,
    ingested: 0,
    skipped: 0,
    issues: 0,
    issuesByCode: {},
    failed: 0,
    cancelled: false,
  };
  let inspected = 0;
  let lineageMayHaveChanged = false;
  let touchedCopilot = false;
  let touchedOpenCode = false;
  let touchedProject = false;
  let ingestedAtStatisticsRefresh = 0;
  const emitProgress = (): void =>
    onProgress?.({
      scanned: inspected,
      ingested: report.ingested,
      skipped: report.skipped,
      failed: report.failed,
      total: files.length,
    });

  emitProgress();

  try {
    for (const file of files) {
      if (cancel?.aborted === true) {
        report.cancelled = true;
        break;
      }
      if (report.ingested - ingestedAtStatisticsRefresh >= PLANNER_STATISTICS_INTERVAL) {
        refreshPlannerStatistics(db);
        ingestedAtStatisticsRefresh = report.ingested;
        ingestsSinceOptimizeByDb.set(db, 0);
      }

      try {
        if (
          file.opencode != null ||
          file.hermes != null ||
          file.tool === "cursor" ||
          file.tool === "atif"
        ) {
          const outcome =
            file.opencode != null
              ? syncOpenCodeSession(db, file, file.opencode, opencode, mcpServers)
              : file.hermes != null
                ? syncHermesSession(db, file, file.hermes, hermes)
                : file.tool === "cursor"
                  ? syncCursorStore(db, file)
                  : syncAtifFile(db, file);
          if (outcome.kind === "ingested") {
            report.ingested += 1;
            report.issues += outcome.issues.length;
            for (const issue of outcome.issues) {
              report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
            }
            lineageMayHaveChanged = true;
            touchedProject = true;
            if (file.opencode != null) {
              touchedOpenCode = true;
            }
            for (const sid of outcome.sessionIds) {
              options?.onSessionChanged?.(sid);
            }
          } else if (outcome.kind === "failed") {
            report.failed += 1;
          } else {
            report.skipped += 1;
            if (outcome.kind === "tombstoned") {
              lineageMayHaveChanged = true;
              if (file.opencode != null) {
                touchedOpenCode = true;
              }
              options?.onTombstoned?.();
            }
          }
          continue;
        }
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
        let content: string | null = null;
        let rawBuffer: Buffer | null = null;
        let sidecarMeta: Json | null = null;
        let handledIncrementally = false;
        try {
          stats = fstatSync(fd);
          const prior = queryRow<{
            size: number;
            mtime: number;
            ingest_revision: number;
            session_id: number | null;
          }>(
            db,
            "SELECT size, mtime, ingest_revision, session_id FROM ingest_source WHERE path = ?1",
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
          if (isIncrementalTool(file.tool)) {
            if (file.tool === "claude_code") {
              sidecarMeta = readClaudeSidecarMeta(file.path);
            }
            if (
              prior != null &&
              prior.session_id != null &&
              prior.ingest_revision === INGEST_PIPELINE_REVISION
            ) {
              const inc = tryIncrementalIngest({
                db,
                fd,
                stats,
                sourcePath: file.path,
                tool: file.tool,
                archived: file.archived,
                priorSessionId: prior.session_id,
                ingestRevision: prior.ingest_revision,
                expectedRevision: INGEST_PIPELINE_REVISION,
                sidecarMeta,
                codexTitles: titles,
              });
              if (inc.kind === "oversized") {
                report.failed += 1;
                logger.warning("Source file could not be read.", {
                  "event.name": "decant.ingest.source_read_failed",
                  "file.path": file.path,
                  "error.message": FILE_LIMIT_MESSAGE,
                });
                continue;
              }
              if (inc.kind === "skipped") {
                report.skipped += 1;
                continue;
              }
              if (inc.kind === "ingested") {
                report.ingested += 1;
                report.issues += inc.issues.length;
                for (const issue of inc.issues) {
                  report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
                }
                lineageMayHaveChanged ||= inc.lineageDirty;
                touchedProject ||= inc.projectCreated;
                options?.onSessionChanged?.(inc.sessionId);
                handledIncrementally = true;
                continue;
              }
            }
            const limitedBuf = readSourceBuffer(fd, stats.size);
            if (limitedBuf === null) {
              report.failed += 1;
              logger.warning("Source file could not be read.", {
                "event.name": "decant.ingest.source_read_failed",
                "file.path": file.path,
                "error.message": FILE_LIMIT_MESSAGE,
              });
              continue;
            }
            rawBuffer = limitedBuf;
          } else {
            const limited = readSourceFile(fd);
            if (limited === null) {
              report.failed += 1;
              logger.warning("Source file could not be read.", {
                "event.name": "decant.ingest.source_read_failed",
                "file.path": file.path,
                "error.message": FILE_LIMIT_MESSAGE,
              });
              continue;
            }
            content = limited;
          }
        } catch (error) {
          report.failed += 1;
          logger.warning("Source file could not be read.", {
            "event.name": "decant.ingest.source_read_failed",
            "file.path": file.path,
            "error.type": (error as { code?: string }).code ?? "unknown",
            "error.message": error instanceof Error ? error.message : String(error),
          });
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
        if (handledIncrementally) {
          continue;
        }

        const stem = fileStem(file.path);
        let parsed: ParsedSession;
        let checkpointFull: FullParseWithCheckpointResult | undefined;
        let totalLineCount: number;
        if (isIncrementalTool(file.tool) && rawBuffer != null) {
          checkpointFull = parseFullForCheckpoint({
            tool: file.tool,
            sourcePath: file.path,
            stem: file.tool === "pi" ? piSessionIdFromStem(stem) : stem,
            rawBuffer,
            archived: file.archived,
            sidecarMeta,
            codexTitles: titles,
          });
          parsed = checkpointFull.parsed;
          totalLineCount = checkpointFull.scanned.totalLines;
        } else {
          const textContent = content ?? "";
          if (file.tool === "claude_code") {
            parsed = parseClaudeSession(stem, textContent, {
              sourcePath: file.path,
              sidecarMeta: readClaudeSidecarMeta(file.path),
            });
          } else if (file.tool === "copilot") {
            // Every Copilot log is named events.jsonl; its directory names the session.
            parsed = parseCopilotSession(pathBasename(dirname(file.path)), textContent);
          } else if (file.tool === "vscode_copilot") {
            parsed = parseVscodeCopilotSession(stem, textContent, {
              workspace: readVscodeWorkspace(file.path),
            });
          } else if (file.tool === "pi") {
            parsed = parsePiSession(piSessionIdFromStem(stem), textContent);
          } else if (file.tool === "gemini") {
            const layout = geminiSessionLayout(file.path);
            parsed = parseGeminiSession(stem, textContent, geminiProjectPath(layout), {
              parentSessionId: layout?.parentSessionId ?? null,
            });
          } else {
            parsed = parseCodexSession(stem, textContent, titles);
          }
          parsed.session.isArchived = file.archived;
          totalLineCount = lineCount(textContent);
        }

        const prepared: Prepared = {
          file,
          lineCount: totalLineCount,
          mtime: mtimeSecs(stats),
          size: stats.size,
        };

        const outcome = writeIngestedFile(db, prepared, parsed, undefined, checkpointFull);
        if (outcome.kind === "tombstoned") {
          report.skipped += 1;
          lineageMayHaveChanged = true;
          options?.onTombstoned?.();
        } else {
          report.ingested += 1;
          report.issues += parsed.issues.length;
          for (const issue of parsed.issues) {
            report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
          }
          lineageMayHaveChanged = true;
          touchedProject = true;
          if (file.tool === "copilot") {
            touchedCopilot = true;
          }
          options?.onSessionChanged?.(outcome.sessionId);
        }
      } finally {
        inspected += 1;
        emitProgress();
      }
    }
  } finally {
    opencode.close();
    hermes.close();
  }

  if (!report.cancelled) {
    refreshDerivedState(db, report, repriced, {
      lineageMayHaveChanged,
      touchedCopilot,
      touchedOpenCode,
      touchedProject,
      alreadyInitialized,
      deferDerivedRefresh: options?.deferDerivedRefresh === true,
      recommendationMinIntervalMs: options?.recommendationMinIntervalMs ?? 0,
    });
    if (!targeted && options?.deferDerivedRefresh !== true) {
      initializedSyncConnections.add(db);
    }
  }

  return report;
}

interface DerivedRefreshFlags {
  lineageMayHaveChanged: boolean;
  touchedCopilot: boolean;
  touchedOpenCode: boolean;
  touchedProject: boolean;
  alreadyInitialized: boolean;
  deferDerivedRefresh: boolean;
  recommendationMinIntervalMs: number;
}

function refreshDerivedState(
  db: Database,
  report: SyncReport,
  repriced: number,
  flags: DerivedRefreshFlags,
): void {
  const background =
    flags.alreadyInitialized &&
    (flags.deferDerivedRefresh || flags.recommendationMinIntervalMs > 0);
  const fullPass = !background;
  if (flags.touchedOpenCode || (fullPass && (report.ingested > 0 || flags.lineageMayHaveChanged))) {
    resolveOpenCodeSpawnLinks(db);
  }
  if (flags.lineageMayHaveChanged || (fullPass && report.ingested > 0)) {
    resolveSubagentParents(db);
  }
  const materializedEconomics = fullPass ? materializeMissingSessionEconomics(db) : 0;
  if (flags.touchedCopilot || !flags.alreadyInitialized) {
    backfillCopilotCompactionMetadata(db);
  }
  const materializedWindows =
    fullPass || flags.touchedCopilot ? materializeMissingContextWindows(db) : 0;
  const materializedEfforts = fullPass ? materializeMissingReasoningEfforts(db) : 0;
  if ((report.ingested > 0 && flags.touchedProject) || (fullPass && report.ingested > 0)) {
    resolveWorktreeRoots(db);
    resolveProjectRemotes(db);
  }
  if (report.ingested > 0 || repriced > 0) {
    recommendationsDirtyConnections.add(db);
  }
  if (!flags.deferDerivedRefresh) {
    const now = Date.now();
    const lastRefresh = lastRecommendationRefreshByDb.get(db) ?? 0;
    const dueForSweepRefresh =
      flags.recommendationMinIntervalMs <= 0 ||
      lastRefresh === 0 ||
      now - lastRefresh >= flags.recommendationMinIntervalMs;
    const dirty = recommendationsDirtyConnections.has(db);
    const uncheckedRecommendationImpactLabels =
      !background &&
      db
        .query(
          `SELECT 1
             FROM recommendation
            WHERE kind = 'signal' AND impact_label_checked = 0
            LIMIT 1`,
        )
        .get() != null;
    if ((dirty && dueForSweepRefresh) || uncheckedRecommendationImpactLabels) {
      regenerateRecommendations(db);
      recommendationsDirtyConnections.delete(db);
      lastRecommendationRefreshByDb.set(db, now);
    } else if (!background && lastRefresh === 0) {
      lastRecommendationRefreshByDb.set(db, now);
    }
  }
  const pendingIngests = (ingestsSinceOptimizeByDb.get(db) ?? 0) + report.ingested;
  const shouldOptimize =
    materializedEconomics > 0 ||
    materializedWindows > 0 ||
    materializedEfforts > 0 ||
    (!flags.alreadyInitialized && report.ingested > 0) ||
    pendingIngests >= PLANNER_STATISTICS_INTERVAL;
  if (shouldOptimize) {
    refreshPlannerStatistics(db);
    ingestsSinceOptimizeByDb.set(db, 0);
  } else if (report.ingested > 0) {
    ingestsSinceOptimizeByDb.set(db, pendingIngests);
  }
}

export function upsertSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string | null = null,
): number {
  return (
    withImmediateTransaction(db, () => writeSession(db, parsed, sourcePath, mtime, size, hash)) ?? 0
  );
}

type SessionSyncOutcome =
  | { kind: "skipped" | "tombstoned" | "failed" }
  | { kind: "ingested"; issues: Issue[]; sessionIds: number[] };

const WITHOUT_CATALOG = "|no-catalog";

const WITHOUT_PROJECT_CONFIG = "|no-project-config";

export function openCodeChangeKey(fingerprint: string, mcpServers: readonly string[]): string {
  if (mcpServers.length === 0) {
    return fingerprint;
  }
  const digest = createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex");
  return `${fingerprint}|mcp:${digest.slice(0, 12)}`;
}

interface OpenCodeCatalog {
  windows: ReadonlyMap<string, number>;
  available: boolean;
}

class OpenCodeRun {
  readonly #db: Database;
  readonly #modelsPath: string | null;
  readonly #stores = new Map<string, OpenCodeStore>();
  readonly #catalogs = new Map<string, OpenCodeCatalog>();
  #modelsCache: OpenCodeCatalog | null = null;
  #sourceDatabases: Set<string> | null = null;

  constructor(db: Database, modelsPath: string | undefined) {
    this.#db = db;
    this.#modelsPath = modelsPath == null || modelsPath === "" ? null : modelsPath;
  }

  store(dbPath: string): OpenCodeStore | null {
    let store = this.#stores.get(dbPath);
    if (store == null) {
      try {
        store = OpenCodeStore.open(dbPath);
      } catch (error) {
        logger.warning("OpenCode database could not be opened.", {
          "event.name": "decant.ingest.opencode_open_failed",
          "file.path": dbPath,
          "error.message": error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      this.#stores.set(dbPath, store);
    }
    return store;
  }

  catalog(store: OpenCodeStore): OpenCodeCatalog {
    let catalog = this.#catalogs.get(store.path);
    if (catalog == null) {
      try {
        catalog = { windows: store.contextWindows(), available: true };
        if (catalog.windows.size === 0 && this.#modelsPath != null) {
          // OpenCode 1.x keeps the catalog in a cache file, not the database.
          catalog = this.#readModelsCache(this.#modelsPath);
        }
      } catch (error) {
        logger.warning("OpenCode model catalog could not be read.", {
          "event.name": "decant.ingest.opencode_catalog_failed",
          "file.path": store.path,
          "error.message": error instanceof Error ? error.message : String(error),
        });
        catalog = { windows: new Map(), available: false };
      }
      this.#catalogs.set(store.path, catalog);
    }
    return catalog;
  }

  #readModelsCache(path: string): OpenCodeCatalog {
    if (this.#modelsCache == null) {
      const cache = readOpenCodeModelsCache(path);
      if (cache.status === "ok") {
        this.#modelsCache = { windows: cache.windows, available: true };
      } else {
        if (cache.status === "missing") {
          logger.info("OpenCode model cache was not found; context windows stay unknown.", {
            "event.name": "decant.ingest.opencode_models_cache_missing",
            "file.path": path,
          });
        } else {
          logger.warning("OpenCode model cache could not be read.", {
            "event.name": "decant.ingest.opencode_models_cache_failed",
            "file.path": path,
            "error.message": cache.error,
          });
        }
        this.#modelsCache = { windows: new Map(), available: false };
      }
    }
    return this.#modelsCache;
  }

  sourceDatabases(): Set<string> {
    this.#sourceDatabases ??= knownSourceDatabases(this.#db, "opencode");
    return this.#sourceDatabases;
  }

  close(): void {
    for (const store of this.#stores.values()) {
      store.close();
    }
    this.#stores.clear();
  }
}

function throughLastHashSql(column: string): string {
  return `rtrim(${column}, replace(${column}, '#', ''))`;
}

function syncOpenCodeSession(
  db: Database,
  file: SourceFile,
  ref: OpenCodeSessionRef,
  opencode: OpenCodeRun,
  mcpServers: OpenCodeMcpServerNames,
): SessionSyncOutcome {
  const prior = queryRow<{ hash: string | null; ingest_revision: number }>(
    db,
    "SELECT hash, ingest_revision FROM ingest_source WHERE path = ?1",
    [file.path],
  );
  const current = prior != null && prior.ingest_revision === INGEST_PIPELINE_REVISION;
  const lookup = mcpServers.lookup(ref.directory);
  const mcpServerNames = lookup.names;
  const changeKey = `${openCodeChangeKey(ref.fingerprint, mcpServerNames)}${
    lookup.unreachable ? WITHOUT_PROJECT_CONFIG : ""
  }`;
  if (current && prior.hash === changeKey) {
    return { kind: "skipped" };
  }
  const store = opencode.store(ref.dbPath);
  if (store == null) {
    return { kind: "failed" };
  }
  if (
    current &&
    prior.hash === `${changeKey}${WITHOUT_CATALOG}` &&
    !opencode.catalog(store).available
  ) {
    return { kind: "skipped" };
  }
  const loaded = readOpenCodeSession(store, ref, file.path);
  if (loaded === "failed") {
    return { kind: "failed" };
  }
  if (loaded == null) {
    return { kind: "skipped" };
  }
  const catalog = opencode.catalog(store);
  const context = { mcpServers: mcpServerNames, contextWindows: catalog.windows };
  const parsed =
    loaded.format === "v1"
      ? parseOpenCodeLegacySession(loaded.session, loaded.messages, loaded.parts, context)
      : parseOpenCodeSession(loaded.session, loaded.messages, context, loaded.legacy);
  if (lookup.unreachable) {
    parsed.issues.push({
      code: "unreachable_project_directory",
      lineNo: null,
      error:
        "The project directory did not answer in time, so its OpenCode config files were not read. MCP servers configured only there are not recognized.",
      rawLine: null,
    });
  }
  const prepared: Prepared = {
    file,
    lineCount: loaded.messages.length,
    mtime: Math.trunc(loaded.session.time_updated / 1000),
    size: 0,
    hash: catalog.available ? changeKey : `${changeKey}${WITHOUT_CATALOG}`,
  };
  const outcome = writeIngestedFile(db, prepared, parsed, opencode);
  return outcome.kind === "tombstoned"
    ? { kind: "tombstoned" }
    : { kind: "ingested", issues: parsed.issues, sessionIds: [outcome.sessionId] };
}

function knownSourceDatabases(db: Database, tool: "opencode" | "hermes"): Set<string> {
  return new Set(
    queryRows<{ through_last_hash: string }>(
      db,
      `SELECT DISTINCT ${throughLastHashSql("path")} AS through_last_hash
         FROM ingest_source
        WHERE tool = ?1 AND instr(path, '#') > 0`,
      [tool],
    ).map((row) => row.through_last_hash.slice(0, -1)),
  );
}

interface SourceDatabaseRun {
  sourceDatabases(): Set<string>;
}

class HermesRun {
  readonly #db: Database;
  readonly #stores = new Map<string, HermesStore | null>();
  #sourceDatabases: Set<string> | null = null;

  constructor(db: Database) {
    this.#db = db;
  }

  store(dbPath: string): HermesStore | null {
    if (!this.#stores.has(dbPath)) {
      let store: HermesStore | null = null;
      try {
        store = HermesStore.open(dbPath);
      } catch (error) {
        logger.warning("Hermes database could not be opened.", {
          "event.name": "decant.ingest.hermes_open_failed",
          "file.path": dbPath,
          "error.message": hermesErrorMessage(error),
        });
      }
      this.#stores.set(dbPath, store);
    }
    return this.#stores.get(dbPath) ?? null;
  }

  sourceDatabases(): Set<string> {
    this.#sourceDatabases ??= knownSourceDatabases(this.#db, "hermes");
    return this.#sourceDatabases;
  }

  close(): void {
    for (const store of this.#stores.values()) {
      store?.close();
    }
    this.#stores.clear();
  }
}

function syncHermesSession(
  db: Database,
  file: SourceFile,
  ref: HermesSessionRef,
  hermes: HermesRun,
): SessionSyncOutcome {
  const prior = queryRow<{ hash: string | null; ingest_revision: number }>(
    db,
    "SELECT hash, ingest_revision FROM ingest_source WHERE path = ?1",
    [file.path],
  );
  if (
    prior != null &&
    prior.ingest_revision === INGEST_PIPELINE_REVISION &&
    prior.hash === ref.fingerprint
  ) {
    return { kind: "skipped" };
  }
  const holder = unreadableArchivedCopy(db, file, ref, hermes);
  if (holder != null) {
    logger.warning("Hermes session kept from a profile database that could not be read.", {
      "event.name": "decant.ingest.hermes_copy_unreadable",
      "file.path": file.path,
      "source.path": holder,
    });
    return { kind: "failed" };
  }
  const store = hermes.store(ref.dbPath);
  if (store == null) {
    return { kind: "failed" };
  }
  let loaded: HermesLoadedSession | null;
  try {
    loaded = store.loadSession(ref.sessionId);
  } catch (error) {
    logger.warning("Source file could not be read.", {
      "event.name": "decant.ingest.source_read_failed",
      "file.path": file.path,
      "error.type": "hermes_read",
      "error.message":
        error instanceof HermesStoreError
          ? error.message
          : `Hermes session could not be read (${errorCode(error)})`,
    });
    return { kind: "failed" };
  }
  if (loaded == null) {
    return { kind: "skipped" };
  }
  const parsed = parseHermesSession(loaded.session, loaded.messages, loaded.modelUsage);
  const prepared: Prepared = {
    file,
    lineCount: loaded.messages.length,
    mtime: Math.trunc(ref.activity),
    size: 0,
    hash: ref.fingerprint,
  };
  const outcome = writeIngestedFile(db, prepared, parsed, hermes);
  return outcome.kind === "tombstoned"
    ? { kind: "tombstoned" }
    : { kind: "ingested", issues: parsed.issues, sessionIds: [outcome.sessionId] };
}

function unreadableArchivedCopy(
  db: Database,
  file: SourceFile,
  ref: HermesSessionRef,
  hermes: HermesRun,
): string | null {
  const partial = file.hermesPartialDiscovery;
  const unreadable = [
    ...(file.hermesUnreadable ?? []),
    ...(partial == null
      ? []
      : [...hermes.sourceDatabases()].filter((database) => !partial.listed.has(database))),
  ];
  for (const database of unreadable) {
    const candidate = `${database}#${ref.sessionId}`;
    if (
      candidate !== file.path &&
      queryRow(db, "SELECT 1 FROM ingest_source WHERE path = ?1 AND tool = 'hermes'", [
        candidate,
      ]) != null
    ) {
      return candidate;
    }
  }
  return null;
}

/** A Cursor CLI chat is a SQLite store, with `meta.json` beside it for a chat
 * the user opened. Its change key covers `meta.json` and the `-wal` too,
 * because a running chat appends to the WAL without touching `store.db`. A
 * store that cannot be read fails alone and is retried on the next sync. */
function syncCursorStore(db: Database, file: SourceFile): SessionSyncOutcome {
  let signature: CursorStoreSignature;
  try {
    signature = cursorStoreSignature(file.path);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { kind: "skipped" }
      : { kind: "failed" };
  }
  const prior = queryRow<{ hash: string | null; ingest_revision: number }>(
    db,
    "SELECT hash, ingest_revision FROM ingest_source WHERE path = ?1",
    [file.path],
  );
  if (
    prior != null &&
    prior.hash?.startsWith(`${signature.key}#`) === true &&
    prior.ingest_revision === INGEST_PIPELINE_REVISION
  ) {
    return { kind: "skipped" };
  }
  let source: CursorSource;
  try {
    source = readCursorSource(file.path);
  } catch (error) {
    logger.warning("Source file could not be read.", {
      "event.name": "decant.ingest.source_read_failed",
      "file.path": file.path,
      "error.type": "cursor_read",
      "error.message":
        error instanceof CursorSourceError
          ? error.message
          : `Cursor store could not be read (${errorCode(error)})`,
    });
    return { kind: "failed" };
  }
  if (source.fileMeta == null && get(source.storeMeta, "subagentInfo") == null) {
    return { kind: "skipped" };
  }
  const parsed = parseCursorSession(pathBasename(dirname(file.path)), source);
  parsed.session.isArchived = file.archived;
  const prepared: Prepared = {
    file,
    lineCount: parsed.session.messages.length,
    mtime: signature.mtime,
    size: signature.size,
    hash: `${signature.key}#${parsed.session.sourceSessionId}`,
  };
  const outcome = writeIngestedFile(db, prepared, parsed);
  return outcome.kind === "tombstoned"
    ? { kind: "tombstoned" }
    : { kind: "ingested", issues: parsed.issues, sessionIds: [outcome.sessionId] };
}

function syncAtifFile(db: Database, file: SourceFile): SessionSyncOutcome {
  let fd: number;
  try {
    fd = openSync(file.path, "r");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { kind: "skipped" }
      : { kind: "failed" };
  }
  let stats: Stats;
  let content: string;
  let changeKey: string;
  try {
    stats = fstatSync(fd);
    changeKey = `mtime-ms:${stats.mtimeMs}`;
    const prior = queryRow<{
      size: number;
      mtime: number;
      ingest_revision: number;
      hash: string | null;
    }>(db, "SELECT size, mtime, ingest_revision, hash FROM ingest_source WHERE path = ?1", [
      file.path,
    ]);
    if (
      prior != null &&
      prior.size === stats.size &&
      prior.mtime === mtimeSecs(stats) &&
      prior.hash === changeKey &&
      prior.ingest_revision === INGEST_PIPELINE_REVISION
    ) {
      return { kind: "skipped" };
    }
    const limited = readSourceFile(fd);
    if (limited === null) {
      logger.warning("Source file could not be read.", {
        "event.name": "decant.ingest.source_read_failed",
        "file.path": file.path,
        "error.message": FILE_LIMIT_MESSAGE,
      });
      return { kind: "failed" };
    }
    content = limited;
  } catch (error) {
    logger.warning("Source file could not be read.", {
      "event.name": "decant.ingest.source_read_failed",
      "file.path": file.path,
      "error.type": (error as { code?: string }).code ?? "unknown",
      "error.message": error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed" };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }

  const document = parseAtifDocument(atifFallbackId(file.path), content, {
    sourcePath: file.path,
    projectPath: harborJobDir(file.path),
  });
  const mtime = mtimeSecs(stats);
  const issues: Issue[] = [];
  const subSessionIds: number[] = [];
  const subagentPaths = new Set<string>();
  let root: ParsedSession | null = null;
  const rootId = document.sessions.find((session) => session.key == null)?.parsed.session
    .sourceSessionId;
  const superseded =
    rootId == null
      ? null
      : queryRow<{ source_path: string | null }>(
          db,
          "SELECT source_path FROM session WHERE tool = 'atif' AND source_session_id = ?1",
          [rootId],
        )?.source_path;
  if (superseded != null && superseded !== file.path) {
    releaseRemovedAtifSubagents(db, superseded, new Set());
  }
  for (const { key, parsed } of document.sessions) {
    if (key == null) {
      root = parsed;
      continue;
    }
    const path = `${file.path}#${key}`;
    subagentPaths.add(path);
    const prepared: Prepared = {
      file: { tool: "atif", path, archived: false },
      lineCount: parsed.session.messages.length,
      mtime,
      size: stats.size,
      hash: changeKey,
    };
    const subOutcome = writeIngestedFile(db, prepared, parsed);
    if (subOutcome.kind === "ingested") {
      issues.push(...parsed.issues);
      subSessionIds.push(subOutcome.sessionId);
    }
  }
  releaseRemovedAtifSubagents(db, file.path, subagentPaths);
  if (root == null) {
    return { kind: "failed" };
  }
  const prepared: Prepared = {
    file,
    lineCount: lineCount(content),
    mtime,
    size: stats.size,
    hash: changeKey,
  };
  const rootOutcome = writeIngestedFile(db, prepared, root);
  if (rootOutcome.kind === "tombstoned") {
    return { kind: "tombstoned" };
  }
  return {
    kind: "ingested",
    issues: [...root.issues, ...issues],
    sessionIds: [rootOutcome.sessionId, ...subSessionIds],
  };
}

function releaseRemovedAtifSubagents(db: Database, path: string, current: Set<string>): void {
  const prefix = `${path}#`;
  const escaped = prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
  // LIKE ignores ASCII case, so the prefix is checked again exactly.
  const stale = queryRows<{ path: string; session_id: number | null }>(
    db,
    "SELECT path, session_id FROM ingest_source WHERE tool = 'atif' AND path LIKE ?1 ESCAPE '\\'",
    [`${escaped}%`],
  ).filter((row) => row.path.startsWith(prefix) && !current.has(row.path));
  if (stale.length === 0) {
    return;
  }
  withImmediateTransaction(db, () => {
    for (const row of stale) {
      if (row.session_id != null) {
        deleteSessionRow(db, row.session_id);
      }
      runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [row.path]);
      runStatement(db, "DELETE FROM ingest_source WHERE path = ?1", [row.path]);
    }
  });
}

/** ATIF files carry no fixed name, so a `.json` file counts when its head
 * declares an ATIF schema version. Harbor's own names are accepted without
 * that check, in case a producer writes a large `agent` object first. */
const ATIF_SNIFF_BYTES = 64 * 1024;
const ATIF_SCHEMA_PATTERN = /"schema_version"\s*:\s*"ATIF-v/;
const HARBOR_TRAJECTORY_NAME = /^trajectory(?:\.cont-\d+|\.summarization-[^/\\]+)?\.json$/;

export function isAtifDocument(path: string): boolean {
  const name = pathBasename(path);
  if (!name.endsWith(".json")) {
    return false;
  }
  if (HARBOR_TRAJECTORY_NAME.test(name) || name.endsWith(".atif.json")) {
    return true;
  }
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(ATIF_SNIFF_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return ATIF_SCHEMA_PATTERN.test(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

/** Harbor writes a trial's trajectory to `<jobs>/<job>/<trial>/agent/`. The
 * job directory groups a run's trials the way a project groups sessions; a
 * container working directory recorded in the trajectory names nothing on
 * this machine. */
export function harborJobDir(path: string): string | null {
  const agentDir = dirname(path);
  if (pathBasename(agentDir) !== "agent") {
    return null;
  }
  const trialDir = dirname(agentDir);
  const jobDir = dirname(trialDir);
  return jobDir === trialDir ? null : jobDir;
}

/** Identity for a document that names neither a `trajectory_id` nor a
 * `session_id`. Harbor names every trial's file `trajectory.json`, so the
 * file name alone would collide; a digest of the path keeps it stable. */
function atifFallbackId(path: string): string {
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `${fileStem(path)}-${digest}`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unknown error";
}

const CURSOR_STORE_NAME = "store.db";

interface CursorStoreSignature {
  /** Per-file existence, size, and nanosecond mtime, stored in
   * `ingest_source.hash` followed by `#` and the agent ID read with it, so an
   * identity change can still name the old one after its session row is
   * gone. A checkpoint can move bytes from the WAL into
   * `store.db` and a new commit can follow within the same second, so a
   * combined size or whole-second mtime can repeat across different
   * content. */
  key: string;
  size: number;
  mtime: number;
}

function cursorStoreSignature(path: string): CursorStoreSignature {
  const parts: string[] = [];
  let size = 0;
  let mtime = 0;
  for (const [name, file] of [
    ["store", path],
    ["wal", `${path}-wal`],
    ["meta", cursorMetaPath(path)],
  ] as const) {
    let stats: BigIntStats;
    try {
      stats = statSync(file, { bigint: true });
    } catch (error) {
      if (name === "store") throw error;
      parts.push(`${name}=-`);
      continue;
    }
    parts.push(`${name}=${stats.size}@${stats.mtimeNs}`);
    size += Number(stats.size);
    mtime = Math.max(mtime, Number(stats.mtimeNs / 1_000_000_000n));
  }
  return { key: `cursor:v1;${parts.join(";")}`, size, mtime };
}

function cursorMetaPath(path: string): string {
  return join(dirname(path), "meta.json");
}

/** Cursor creates a store for every chat it opens; only those whose
 * `meta.json` says a conversation happened hold a transcript. A subagent's
 * store has no `meta.json`, so a store without one stays a candidate and
 * `syncCursorStore` keeps it only when it names a parent agent. */
function isCursorConversationStore(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(cursorMetaPath(path), "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  try {
    return get(JSON.parse(text) as Json, "hasConversation") === true;
  } catch {
    return false;
  }
}

type OpenCodeLoaded =
  | ({ format: "v2" } & OpenCodeLoadedSession)
  | ({ format: "v1" } & OpenCodeLegacyLoadedSession);

function readOpenCodeSession(
  store: OpenCodeStore,
  ref: OpenCodeSessionRef,
  sourcePath: string,
): OpenCodeLoaded | null | "failed" {
  try {
    if (ref.format === "v1") {
      const loaded = store.loadLegacySession(ref.sessionId);
      return loaded == null ? null : { format: "v1", ...loaded };
    }
    const loaded = store.loadSession(ref.sessionId);
    return loaded == null ? null : { format: "v2", ...loaded };
  } catch (error) {
    logger.warning("Source file could not be read.", {
      "event.name": "decant.ingest.source_read_failed",
      "file.path": sourcePath,
      "error.type": "opencode_read",
      "error.message": error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/** OpenCode names a child session only inside the parent's spawn tool
 * result, so the child's spawn link is resolved once both sides are stored,
 * before lineage resolution reads it. 2.x writes `subagent` with
 * `state.metadata.sessionID`; 1.x, and 2.x rows the migrator copied from 1.x
 * (it never renames them in data), write `task` with `state.metadata.sessionId`.
 * A 1.x result's `raw` is the tool part, whose `id` is the part id and whose
 * `callID` is the call; a 2.x result's `id` is the call. */
function resolveOpenCodeSpawnLinks(db: Database): void {
  runStatement(
    db,
    `UPDATE session
        SET spawn_tool_use_id = (
          SELECT COALESCE(json_extract(${MESSAGE_METADATA_SQL}, '$.callID'), json_extract(${MESSAGE_METADATA_SQL}, '$.id'))
            FROM message m
            JOIN session parent ON parent.id = m.session_id
           WHERE parent.tool = 'opencode'
             AND parent.source_session_id = json_extract(session.raw_meta, '$.parentSessionId')
             AND m.role = 'tool'
             AND json_valid(${MESSAGE_METADATA_SQL})
             AND ((json_extract(${MESSAGE_METADATA_SQL}, '$.name') = 'subagent'
                   AND json_extract(${MESSAGE_METADATA_SQL}, '$.state.metadata.sessionID') = session.source_session_id)
               OR (COALESCE(json_extract(${MESSAGE_METADATA_SQL}, '$.tool'), json_extract(${MESSAGE_METADATA_SQL}, '$.name')) = 'task'
                   AND json_extract(${MESSAGE_METADATA_SQL}, '$.state.metadata.sessionId') = session.source_session_id))
           ORDER BY m.id
           LIMIT 1)
      WHERE tool = 'opencode'
        AND is_subagent = 1
        AND spawn_tool_use_id IS NULL
        AND raw_meta IS NOT NULL
        AND json_valid(raw_meta)`,
  );
}

export function seedModelPricing(db: Database): void {
  const stored = new Map(
    queryRows<{
      model: string;
      input_per_mtok: number | null;
      output_per_mtok: number | null;
      cache_read_per_mtok: number | null;
      cache_write_per_mtok: number | null;
      cache_write_1h_per_mtok: number | null;
      source: string | null;
    }>(
      db,
      `SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
              cache_write_per_mtok, cache_write_1h_per_mtok, source
         FROM model_pricing`,
    ).map((row) => [row.model, row]),
  );
  const pending = [...defaultPricing()].filter(([model, price]) => {
    const row = stored.get(model);
    return (
      row == null ||
      (row.source === "seed" &&
        (row.input_per_mtok !== price.inputPerMtok ||
          row.output_per_mtok !== price.outputPerMtok ||
          row.cache_read_per_mtok !== price.cacheReadPerMtok ||
          row.cache_write_per_mtok !== price.cacheWritePerMtok ||
          row.cache_write_1h_per_mtok !== price.cacheWrite1hPerMtok))
    );
  });
  if (pending.length === 0) {
    return;
  }
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
     WHERE model_pricing.source = 'seed'
       AND (model_pricing.input_per_mtok IS NOT excluded.input_per_mtok
         OR model_pricing.output_per_mtok IS NOT excluded.output_per_mtok
         OR model_pricing.cache_read_per_mtok IS NOT excluded.cache_read_per_mtok
         OR model_pricing.cache_write_per_mtok IS NOT excluded.cache_write_per_mtok
         OR model_pricing.cache_write_1h_per_mtok IS NOT excluded.cache_write_1h_per_mtok)`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const [model, price] of pending) {
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
  const rows = queryRows<{
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
    parent_session_id: number | null;
    first_fields: string | null;
  }>(
    db,
    `SELECT s.id, s.source_session_id, s.raw_meta, s.source_path, s.spawn_tool_use_id,
              s.agent_id, s.agent_type, s.spawn_depth, s.is_subagent, s.parent_session_id,
              s.tool,
              (SELECT CASE WHEN json_valid(${MESSAGE_METADATA_SQL})
                           THEN json_extract(${MESSAGE_METADATA_SQL}, '$.isSidechain', '$.sessionId', '$.agentId')
                      END
               FROM message m
               WHERE m.session_id = s.id
               ORDER BY m.seq
               LIMIT 1) AS first_fields
       FROM session s
       WHERE s.tool IN ('claude_code', 'codex', 'gemini', 'opencode', 'cursor', 'atif', 'hermes')`,
  );

  const sessionBySource = new Map<string, number>();
  const rootByClaudeSession = new Map<string, number>();
  const rootByChild = new Map<number, number>();
  const inferred = new Map<number, InferredSubagent>();
  const atifFileRefs = atifFileRefParents(rows);
  for (const row of rows) {
    const info = row.tool === "atif" ? inferAtifSubagent(row, atifFileRefs) : inferSubagent(row);
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
      (rootKey == null || row.tool === "atif" ? null : rootByClaudeSession.get(rootKey)) ??
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
     FROM block call INDEXED BY idx_block_tool
     JOIN block result
       ON result.session_id = call.session_id
      AND result.tool_use_id = call.tool_use_id
      AND result.type = 'tool_result'
     WHERE call.session_id = ?1
       AND call.type = 'tool_use'
       AND call.tool_name = 'spawn_agent'
       AND result.tool_result LIKE ?2
     ORDER BY call.id DESC
     LIMIT 1`,
  );
  const clearAtif = db.prepare(
    `UPDATE session
     SET is_subagent = 0, parent_session_id = NULL, spawn_tool_use_id = NULL,
         agent_id = NULL, agent_type = NULL, spawn_depth = NULL
     WHERE id = ?1`,
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
          if (row.tool === "atif" && row.is_subagent !== 0) {
            clearAtif.run(row.id);
          }
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
        // ATIF call IDs are only unique within a document, so an archive-wide
        // lookup could name another trial's session. The parser already
        // named the parent, which is the session that made the call.
        if (spawnToolUseId != null && row.tool !== "atif") {
          const spawner = findSpawner.get(spawnToolUseId) as { session_id: number } | null;
          if (spawner != null && spawner.session_id !== row.id) {
            parentId = spawner.session_id;
          }
        }
        parentId ??= rootId;
        const nextParent = parentId === row.id ? null : parentId;
        // Rewriting identical values still dirties the session pages, so a
        // resolved archive would log a WAL write per subagent on every pass.
        if (
          row.is_subagent === 1 &&
          row.parent_session_id === nextParent &&
          row.spawn_tool_use_id === (row.spawn_tool_use_id ?? spawnToolUseId) &&
          row.agent_id === (row.agent_id ?? info.agentId) &&
          row.agent_type === (row.agent_type ?? info.agentType) &&
          row.spawn_depth === (row.spawn_depth ?? info.spawnDepth)
        ) {
          continue;
        }
        update.run(
          1,
          nextParent,
          spawnToolUseId,
          info.agentId,
          info.agentType,
          info.spawnDepth,
          row.id,
        );
      }
    });
  } finally {
    clearAtif.finalize();
    update.finalize();
    findCodexSpawner.finalize();
    findSpawner.finalize();
  }
}

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

  const efforts: ({ id: number } & ReasoningEffortSummary)[] = [];
  for (const row of rows) {
    if (row.source_path == null) {
      efforts.push({ id: row.id, summary: null, levels: [] });
      continue;
    }
    try {
      efforts.push({ id: row.id, ...reasoningEffortFromSource(row.tool, row.source_path) });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        efforts.push({ id: row.id, summary: null, levels: [] });
      }
    }
  }
  if (efforts.length === 0) {
    return 0;
  }

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
  return efforts.length;
}

interface ReasoningEffortSummary {
  summary: string | null;
  levels: string[];
}

function reasoningEffortFromSource(tool: Tool, path: string): ReasoningEffortSummary {
  if (tool === "cursor" || tool === "atif") {
    return { summary: null, levels: [] };
  }
  const efforts = new Set<string>();
  const scan: EffortScan = { tool, efforts, sawMeta: false, historyStart: null };
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
        collectReasoningEffort(scan, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    collectReasoningEffort(scan, pending + decoder.end());
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  const levels = reasoningEffortLevels(efforts);
  return { summary: summarizeReasoningEfforts(levels), levels };
}

interface EffortScan {
  tool: Tool;
  efforts: Set<string>;
  sawMeta: boolean;
  historyStart: number | null;
}

function collectReasoningEffort(scan: EffortScan, line: string): void {
  if (line.trim() === "") {
    return;
  }
  try {
    const value = JSON.parse(line) as Json;
    const typ = asString(get(value, "type"));
    if (scan.tool === "codex" && typ === "session_meta" && !scan.sawMeta) {
      scan.sawMeta = true;
      scan.historyStart = forkHistoryStart(get(value, "payload"));
    }
    const ordinal = asInteger(get(value, "ordinal"));
    if (scan.historyStart != null && ordinal != null && ordinal < scan.historyStart) {
      return;
    }
    const effort =
      scan.tool === "claude_code"
        ? recordedReasoningEffort(get(value, "effort"))
        : recordedReasoningEffort(get(get(value, "payload"), "effort"));
    if (effort != null && (scan.tool === "claude_code" || typ === "turn_context")) {
      scan.efforts.add(effort);
    }
  } catch {}
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
  first_fields: string | null;
}): InferredSubagent {
  const meta = parseObject(row.raw_meta);
  const first = firstMessageFields(row.first_fields);
  const source = get(meta, "source");
  const cursorStore = get(meta, "store");
  const cursorSubagent = get(cursorStore, "subagentInfo");
  const subagentSource = get(source, "subagent");
  const threadSpawn = get(subagentSource, "thread_spawn");
  const parentThreadId =
    asString(get(meta, "parent_thread_id")) ??
    asString(get(threadSpawn, "parent_thread_id")) ??
    asString(get(meta, "parentSessionId"));
  const fromPath =
    row.tool !== "hermes" &&
    row.source_path != null &&
    /(?:^|[/\\])subagents(?:[/\\])/.test(row.source_path);
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
      parentThreadId ??
      asString(get(cursorSubagent, "rootParentAgentId")) ??
      asString(get(cursorSubagent, "parentAgentId")) ??
      asString(get(meta, "sessionId")) ??
      asString(get(first, "sessionId")),
    spawnToolUseId:
      row.spawn_tool_use_id ??
      asString(get(meta, "spawnToolUseId")) ??
      asString(get(meta, "toolUseId")) ??
      asString(get(cursorSubagent, "toolCallId")),
    agentId:
      row.agent_id ??
      asString(get(meta, "agent_nickname")) ??
      asString(get(threadSpawn, "agent_nickname")) ??
      asString(get(meta, "agentId")) ??
      asString(get(cursorStore, "agentId")) ??
      asString(get(first, "agentId")) ??
      (isSubagent && row.tool === "codex" ? row.source_session_id : null),
    agentType:
      row.agent_type ??
      asString(get(meta, "agent_role")) ??
      asString(get(threadSpawn, "agent_role")) ??
      asString(subagentSource) ??
      asString(get(meta, "agentType")) ??
      asString(get(meta, "subagentType")) ??
      asString(get(meta, "subagent_type")) ??
      asString(get(cursorSubagent, "typeName")),
    spawnDepth:
      row.spawn_depth ?? asInteger(get(threadSpawn, "depth")) ?? asInteger(get(meta, "spawnDepth")),
  };
}

type SubagentRow = Parameters<typeof inferSubagent>[0];

/** A subagent stored in its own file (Harbor's Terminus 2 writes each
 * summarization subagent beside the main trajectory) is named only by its
 * parent's `trajectory_path` ref. The parser resolves those refs to paths, so
 * the child is found by the path its own session was read from. */
function atifFileRefParents(
  rows: readonly SubagentRow[],
): Map<string, { parent: string; spawnToolUseId: string | null }> {
  const parents = new Map<string, { parent: string; spawnToolUseId: string | null }>();
  for (const row of rows) {
    if (row.tool !== "atif") {
      continue;
    }
    const refs = get(parseObject(row.raw_meta), "subagentFileRefs");
    if (!Array.isArray(refs)) {
      continue;
    }
    for (const ref of refs) {
      const path = asString(get(ref, "path"));
      if (path != null && !parents.has(path)) {
        parents.set(path, {
          parent: row.source_session_id,
          spawnToolUseId: asString(get(ref, "spawnToolUseId")),
        });
      }
    }
  }
  return parents;
}

function inferAtifSubagent(
  row: SubagentRow,
  fileRefs: ReadonlyMap<string, { parent: string; spawnToolUseId: string | null }>,
): InferredSubagent {
  const meta = parseObject(row.raw_meta);
  const parent = asString(get(meta, "parentSessionId"));
  const fileRef = row.source_path == null ? undefined : fileRefs.get(row.source_path);
  if (parent == null && fileRef == null) {
    return {
      isSubagent: false,
      rootKey: null,
      spawnToolUseId: row.spawn_tool_use_id,
      agentId: row.agent_id,
      agentType: row.agent_type,
      spawnDepth: row.spawn_depth,
    };
  }
  return {
    isSubagent: true,
    rootKey: parent ?? fileRef?.parent ?? null,
    spawnToolUseId: row.spawn_tool_use_id ?? fileRef?.spawnToolUseId ?? null,
    agentId: row.agent_id ?? asString(get(meta, "session_id")) ?? row.source_session_id,
    agentType: row.agent_type ?? asString(get(get(meta, "agent"), "name")),
    spawnDepth: row.spawn_depth,
  };
}

function writeIngestedFile(
  db: Database,
  prepared: Prepared,
  parsed: ParsedSession,
  sources?: SourceDatabaseRun,
  checkpointFull?: FullParseWithCheckpointResult,
): { kind: "ingested"; sessionId: number } | { kind: "tombstoned" } {
  return withImmediateTransaction(db, () => {
    releaseMisfiledFork(db, prepared.file.path, parsed);
    releaseReplacedCursorIdentity(db, prepared.file.path, parsed);
    const ref = prepared.file.opencode ?? prepared.file.hermes;
    if (ref != null && sources != null) {
      const databases = sources.sourceDatabases();
      releaseSupersededSources(
        db,
        prepared.file.tool,
        prepared.file.path,
        ref.sessionId,
        databases,
      );
      databases.add(ref.dbPath);
    }
    runStatement(db, "UPDATE ingest_source SET session_id = NULL WHERE path = ?1", [
      prepared.file.path,
    ]);
    const artifactOut: { value?: FullWriteArtifact } | undefined =
      checkpointFull != null ? {} : undefined;
    const sessionId = writeSession(
      db,
      parsed,
      prepared.file.path,
      prepared.mtime,
      prepared.size,
      prepared.hash ?? null,
      artifactOut,
      true,
    );
    if (sessionId == null) {
      runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [prepared.file.path]);
      runStatement(db, "DELETE FROM ingest_checkpoint WHERE path = ?1", [prepared.file.path]);
      writeIngestSource(db, prepared, null, "skipped_deleted");
      return { kind: "tombstoned" };
    }
    runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [prepared.file.path]);
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
    if (checkpointFull != null && artifactOut?.value != null) {
      buildAndPersistCheckpointAfterFullWrite(
        db,
        prepared.file.path,
        checkpointFull,
        artifactOut.value,
      );
    } else {
      runStatement(db, "DELETE FROM ingest_checkpoint WHERE path = ?1", [prepared.file.path]);
    }
    return { kind: "ingested", sessionId };
  });
}

function releaseMisfiledFork(db: Database, path: string, parsed: ParsedSession): void {
  const parent = parsed.session.rootSourceSessionId;
  if (parsed.session.tool !== "codex" || parent == null) {
    return;
  }
  const misfiled = queryRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = 'codex' AND source_session_id = ?1 AND source_path = ?2",
    [parent, path],
  );
  if (misfiled != null) {
    deleteSessionRow(db, misfiled.id);
  }
}

function releaseReplacedCursorIdentity(db: Database, path: string, parsed: ParsedSession): void {
  if (parsed.session.tool !== "cursor") {
    return;
  }
  const next = parsed.session.sourceSessionId;
  const prior = queryRow<{ hash: string | null; source_session_id: string | null }>(
    db,
    `SELECT i.hash, s.source_session_id
       FROM ingest_source i LEFT JOIN session s ON s.id = i.session_id
      WHERE i.path = ?1`,
    [path],
  );
  const separator = prior?.hash?.indexOf("#") ?? -1;
  const previous =
    separator < 0
      ? (prior?.source_session_id ?? null)
      : (prior?.hash?.slice(separator + 1) ?? null);
  if (previous == null || previous === next) {
    return;
  }
  runStatement(
    db,
    `INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
     SELECT tool, ?2, state, updated_at FROM session_user_state
      WHERE tool = 'cursor' AND source_session_id = ?1
     ON CONFLICT(tool, source_session_id) DO NOTHING`,
    [previous, next],
  );
  const stale = queryRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = 'cursor' AND source_session_id = ?1",
    [previous],
  );
  if (stale != null) {
    deleteSessionRow(db, stale.id);
  }
  runStatement(
    db,
    `UPDATE ingest_source SET hash = NULL
      WHERE tool = 'cursor' AND path != ?1
        AND substr(hash, instr(hash, '#') + 1) = ?2`,
    [path, previous],
  );
}

function releaseSupersededSources(
  db: Database,
  tool: Tool,
  path: string,
  sessionId: string,
  databases: ReadonlySet<string>,
): void {
  if (sessionId.includes("#")) {
    return;
  }
  for (const database of databases) {
    const candidate = `${database}#${sessionId}`;
    if (
      candidate === path ||
      queryRow(db, "SELECT 1 FROM ingest_source WHERE path = ?1 AND tool = ?2", [
        candidate,
        tool,
      ]) == null
    ) {
      continue;
    }
    runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [candidate]);
    runStatement(db, "DELETE FROM ingest_source WHERE path = ?1", [candidate]);
  }
}

function deleteSessionRow(db: Database, id: number): void {
  releaseBilledRequests(db, [id]);
  deleteSessionRowKeepingBilledClaims(db, id);
}

function deleteSessionRowKeepingBilledClaims(db: Database, id: number): void {
  runStatement(db, "UPDATE session SET parent_session_id = NULL WHERE parent_session_id = ?1", [
    id,
  ]);
  runStatement(db, "DELETE FROM session WHERE id = ?1", [id]);
}

function writeIngestSource(
  db: Database,
  prepared: Prepared,
  sessionId: number | null,
  status: "ok" | "ok_with_issues" | "skipped_deleted",
): void {
  runStatement(
    db,
    `INSERT INTO ingest_source(
       path, tool, size, mtime, ingest_revision, session_id, line_count, status,
       last_ingested_at, hash
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), ?9)
     ON CONFLICT(path) DO UPDATE SET
       tool = ?2, size = ?3, mtime = ?4, hash = ?9, ingest_revision = ?5,
       session_id = ?6, line_count = ?7, status = ?8, error = NULL,
       last_ingested_at = datetime('now')`,
    [
      prepared.file.path,
      prepared.file.tool,
      prepared.size,
      prepared.mtime,
      INGEST_PIPELINE_REVISION,
      sessionId,
      prepared.lineCount,
      status,
      prepared.hash ?? null,
    ],
  );
}

function rawBytesEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a !== "string" && typeof b !== "string") {
    return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
  }
  return false;
}

function writeSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string | null = null,
  artifactOut?: { value?: FullWriteArtifact },
  diffExisting = false,
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
    runStatement(
      db,
      `INSERT INTO project(path, name, first_seen_at, last_seen_at)
       VALUES (?1, ?2, datetime('now'), datetime('now'))
       ON CONFLICT(path) DO UPDATE SET last_seen_at = datetime('now')`,
      [s.projectPath, basename(s.projectPath)],
    );
    projectId =
      queryRow<{ id: number }>(db, "SELECT id FROM project WHERE path = ?1", [s.projectPath])?.id ??
      null;
  }

  const existing = queryRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = ?1 AND source_session_id = ?2",
    [s.tool, s.sourceSessionId],
  );
  const useDiff = existing != null && diffExisting;
  let unsettled: string[] = [];
  if (existing != null) {
    unsettled = unsettledRequests(db, existing.id);
    if (useDiff) {
      runStatement(
        db,
        `DELETE FROM ingest_checkpoint
          WHERE path IN (SELECT path FROM ingest_source WHERE session_id = ?1 AND path != ?2)`,
        [existing.id, sourcePath],
      );
      runStatement(
        db,
        "UPDATE ingest_source SET session_id = NULL WHERE session_id = ?1 AND path != ?2",
        [existing.id, sourcePath],
      );
      runStatement(db, "DELETE FROM billed_request WHERE session_id = ?1", [existing.id]);
      runStatement(db, "DELETE FROM unbilled_request WHERE session_id = ?1", [existing.id]);
    } else {
      deleteSessionRowKeepingBilledClaims(db, existing.id);
    }
  }

  const refs = fileRefs(s);
  const gotFacets = facets(s);
  const gotOutcome = outcome(s);
  const gotWorkType = workType(s, refs);
  let replyCount = 0;
  let toolCallCount = 0;
  let searchCount = 0;
  for (const msg of s.messages) {
    if (isRenderableReply(msg)) replyCount += 1;
    toolCallCount += countToolUseBlocks(msg);
    for (const blk of msg.blocks) {
      if (blk.blockType === "tool_use") {
        const name = blk.toolName ?? "";
        if (isSearchCandidateTool(name)) {
          const inputStr = blk.toolInput === undefined ? null : canonicalJson(blk.toolInput);
          searchCount += countSearchCandidateToolCall(name, inputStr);
        }
        for (const inner of blk.innerToolCalls ?? []) {
          if (isSearchCandidateTool(inner.toolName)) {
            const innerInput =
              inner.toolInput === undefined ? null : canonicalJson(inner.toolInput);
            searchCount += countSearchCandidateToolCall(inner.toolName, innerInput);
          }
        }
      }
    }
  }

  let sessionId: number;
  if (useDiff && existing != null) {
    sessionId = existing.id;
    runStatement(
      db,
      `UPDATE session
          SET project_id = ?2,
              title = ?3,
              cwd = ?4,
              git_branch = ?5,
              model = ?6,
              cli_version = ?7,
              started_at = ?8,
              ended_at = ?9,
              message_count = ?10,
              total_input_tokens = ?11,
              total_output_tokens = ?12,
              total_cache_read_tokens = ?13,
              total_cache_creation_tokens = ?14,
              total_reasoning_tokens = ?15,
              estimated_cost_usd = 0,
              is_archived = ?16,
              is_subagent = ?17,
              parent_session_id = NULL,
              spawn_tool_use_id = ?18,
              agent_id = ?19,
              agent_type = ?20,
              spawn_depth = ?21,
              source_path = ?22,
              raw_meta = ?23,
              ingested_at = datetime('now'),
              source_mtime = ?24,
              source_size = ?25,
              source_hash = ?26,
              turn_count = ?27,
              error_count = ?28,
              interruption_count = ?29,
              compaction_count = ?30,
              sidechain_message_count = ?31,
              agent_spawn_count = ?32,
              skill_count = ?33,
              command_count = ?34,
              thinking_block_count = ?35,
              thinking_chars = ?36,
              active_seconds = ?37,
              outcome = ?38,
              work_type = ?39,
              est_reasoning_tokens = ?40,
              reasoning_source = ?41,
              total_cache_creation_1h_tokens = ?42,
              reasoning_effort = ?43,
              reasoning_effort_levels = ?44,
              reasoning_effort_checked = 1,
              context_window_tokens = NULL,
              peak_context_tokens = NULL,
              reply_count = ?45,
              tool_call_count = ?46,
              search_count = ?47
        WHERE id = ?1`,
      [
        sessionId,
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
        Number(s.isArchived),
        Number(s.isSubagent),
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
        s.totals.cacheCreation1h,
        s.reasoningEffort,
        canonicalJson(s.reasoningEffortLevels),
        replyCount,
        toolCallCount,
        searchCount,
      ],
    );
  } else {
    sessionId = runStatement(
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
         reasoning_effort, reasoning_effort_levels, reasoning_effort_checked,
         reply_count, tool_call_count, search_count
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
               ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, datetime('now'), ?27, ?28, ?29, ?30, ?31,
               ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, 1,
               ?49, ?50, ?51)`,
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
        0,
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
        replyCount,
        toolCallCount,
        searchCount,
      ],
    );
  }

  const results = new Map<
    string,
    {
      blockId: number;
      order: number;
      isError: boolean | null;
      text: string;
      timestamp: string | null;
    }[]
  >();
  const toolUseBlocks: ToolUseBlock[] = [];
  const messageIds: number[] = [];
  const blockIdsByMsgAndOrd = artifactOut != null ? new Map<string, number>() : null;
  const insertedCalls: FullWriteArtifact["insertedCalls"] | null = artifactOut != null ? [] : null;
  const resultBlockCallInfo =
    artifactOut != null ? new Map<number, { toolName: string; input: string | null }>() : null;

  interface ExistingMsgRow {
    id: number;
    seq: number;
    source_uuid: string | null;
    parent_source_uuid: string | null;
    role: string | null;
    model: string | null;
    stop_reason: string | null;
    timestamp: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    raw: string | Uint8Array;
    raw_meta: string | null;
    raw_bytes: number | null;
  }
  interface ExistingBlockRow {
    id: number;
    message_id: number;
    ordinal: number;
    type: string | null;
    text: string | null;
    tool_name: string | null;
    tool_use_id: string | null;
    tool_input: string | null;
    tool_result: string | null;
  }
  interface ExistingToolCallRow {
    id: number;
    message_id: number | null;
    call_block_id: number | null;
    result_block_id: number | null;
    tool_kind: string | null;
    tool_name: string | null;
    mcp_server: string | null;
    tool_base_name: string | null;
    tool_use_id: string | null;
    input: string | null;
    input_bytes: number | null;
    is_error: number | null;
    has_result: number | null;
    output_preview: string | null;
    output_bytes: number | null;
    duration_ms: number | null;
    ordinal: number | null;
    timestamp: string | null;
  }
  interface ExistingFileRefRow {
    id: number;
    message_id: number | null;
    path: string;
    rel_path: string | null;
    ext: string | null;
    operation: string;
    timestamp: string | null;
  }

  let existingMsgBySeq: Map<number, ExistingMsgRow> | null = null;
  let existingBlocksByMsg: Map<number, Map<number, ExistingBlockRow>> | null = null;
  let existingCallsByCallBlock: Map<number | null, ExistingToolCallRow[]> | null = null;
  let existingRefsByMsg: Map<number | null, ExistingFileRefRow[]> | null = null;
  const blocksToDelete: number[] = [];
  const messagesToDelete: number[] = [];

  if (useDiff) {
    existingMsgBySeq = new Map();
    for (const row of queryRows<ExistingMsgRow>(
      db,
      `SELECT id, seq, source_uuid, parent_source_uuid, role, model, stop_reason, timestamp,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              raw, raw_meta, raw_bytes
         FROM message WHERE session_id = ?1 ORDER BY seq`,
      [sessionId],
    )) {
      existingMsgBySeq.set(row.seq, row);
    }
    existingBlocksByMsg = new Map();
    for (const row of queryRows<ExistingBlockRow>(
      db,
      `SELECT id, message_id, ordinal, type, text, tool_name, tool_use_id, tool_input, tool_result
         FROM block WHERE session_id = ?1 ORDER BY message_id, ordinal`,
      [sessionId],
    )) {
      let byOrd = existingBlocksByMsg.get(row.message_id);
      if (byOrd == null) {
        byOrd = new Map();
        existingBlocksByMsg.set(row.message_id, byOrd);
      }
      byOrd.set(row.ordinal, row);
    }
    existingCallsByCallBlock = new Map();
    for (const row of queryRows<ExistingToolCallRow>(
      db,
      `SELECT id, message_id, call_block_id, result_block_id, tool_kind, tool_name,
              mcp_server, tool_base_name, tool_use_id, input, input_bytes, is_error,
              has_result, output_preview, output_bytes, duration_ms, ordinal, timestamp
         FROM tool_call WHERE session_id = ?1 ORDER BY id`,
      [sessionId],
    )) {
      let list = existingCallsByCallBlock.get(row.call_block_id);
      if (list == null) {
        list = [];
        existingCallsByCallBlock.set(row.call_block_id, list);
      }
      list.push(row);
    }
    existingRefsByMsg = new Map();
    for (const row of queryRows<ExistingFileRefRow>(
      db,
      `SELECT id, message_id, path, rel_path, ext, operation, timestamp
         FROM file_ref WHERE session_id = ?1 ORDER BY id`,
      [sessionId],
    )) {
      let list = existingRefsByMsg.get(row.message_id);
      if (list == null) {
        list = [];
        existingRefsByMsg.set(row.message_id, list);
      }
      list.push(row);
    }
  }

  const insertMessage = db.prepare(
    `INSERT INTO message(
       session_id, seq, source_uuid, parent_source_uuid, role, model, stop_reason,
       timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw, raw_meta, raw_bytes
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  );
  const updateMessage = useDiff
    ? db.prepare(
        `UPDATE message
            SET source_uuid = ?2, parent_source_uuid = ?3, role = ?4, model = ?5,
                stop_reason = ?6, timestamp = ?7, input_tokens = ?8, output_tokens = ?9,
                cache_read_tokens = ?10, cache_creation_tokens = ?11,
                raw = ?12, raw_meta = ?13, raw_bytes = ?14
          WHERE id = ?1`,
      )
    : null;
  const insertBlock = db.prepare(
    `INSERT INTO block(
       message_id, session_id, ordinal, type, text, tool_name, tool_use_id, tool_input, tool_result
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  const updateBlock = useDiff
    ? db.prepare(
        `UPDATE block
            SET type = ?2, text = ?3, tool_name = ?4, tool_use_id = ?5,
                tool_input = ?6, tool_result = ?7
          WHERE id = ?1`,
      )
    : null;

  let blockOrder = 0;
  try {
    for (const message of s.messages) {
      const rawJson = canonicalJson(message.raw);
      const inTok = message.usage?.input ?? null;
      const outTok = message.usage?.output ?? null;
      const cacheReadTok = message.usage?.cacheRead ?? null;
      const cacheCreateTok = message.usage?.cacheCreation ?? null;
      const oldMsg = existingMsgBySeq?.get(message.seq);
      let messageId: number;
      if (oldMsg != null && existingMsgBySeq != null) {
        existingMsgBySeq.delete(message.seq);
        messageId = oldMsg.id;
        const rawUnchanged =
          (typeof oldMsg.raw === "string" && oldMsg.raw === rawJson) ||
          (typeof oldMsg.raw !== "string" &&
            oldMsg.raw_bytes === byteLength(rawJson) &&
            decodeMessageRaw(oldMsg.raw) === rawJson);
        const metaChanged =
          oldMsg.source_uuid !== message.sourceUuid ||
          oldMsg.parent_source_uuid !== message.parentSourceUuid ||
          oldMsg.role !== message.role ||
          oldMsg.model !== message.model ||
          oldMsg.stop_reason !== message.stopReason ||
          oldMsg.timestamp !== message.timestamp ||
          oldMsg.input_tokens !== inTok ||
          oldMsg.output_tokens !== outTok ||
          oldMsg.cache_read_tokens !== cacheReadTok ||
          oldMsg.cache_creation_tokens !== cacheCreateTok;
        if (metaChanged || !rawUnchanged) {
          const storedRaw = rawUnchanged
            ? { raw: oldMsg.raw, rawMeta: oldMsg.raw_meta, rawBytes: oldMsg.raw_bytes }
            : encodeMessageRaw(rawJson, message.raw);
          const changed =
            metaChanged ||
            oldMsg.raw_meta !== storedRaw.rawMeta ||
            oldMsg.raw_bytes !== storedRaw.rawBytes ||
            !rawBytesEqual(oldMsg.raw, storedRaw.raw);
          if (changed && updateMessage != null) {
            updateMessage.run(
              messageId,
              message.sourceUuid,
              message.parentSourceUuid,
              message.role,
              message.model,
              message.stopReason,
              message.timestamp,
              inTok,
              outTok,
              cacheReadTok,
              cacheCreateTok,
              storedRaw.raw,
              storedRaw.rawMeta,
              storedRaw.rawBytes,
            );
          }
        }
      } else {
        const storedRaw = encodeMessageRaw(rawJson, message.raw);
        messageId = Number(
          insertMessage.run(
            sessionId,
            message.seq,
            message.sourceUuid,
            message.parentSourceUuid,
            message.role,
            message.model,
            message.stopReason,
            message.timestamp,
            inTok,
            outTok,
            cacheReadTok,
            cacheCreateTok,
            storedRaw.raw,
            storedRaw.rawMeta,
            storedRaw.rawBytes,
          ).lastInsertRowid,
        );
      }
      messageIds.push(messageId);

      const oldBlocksForMsg = existingBlocksByMsg?.get(messageId);
      if (oldBlocksForMsg != null && existingBlocksByMsg != null) {
        existingBlocksByMsg.delete(messageId);
      }

      for (const block of message.blocks) {
        const order = blockOrder++;
        const toolInputStr = block.toolInput === undefined ? null : canonicalJson(block.toolInput);
        const oldBlk = oldBlocksForMsg?.get(block.ordinal);
        let blockId: number;
        if (oldBlk != null && oldBlocksForMsg != null) {
          oldBlocksForMsg.delete(block.ordinal);
          blockId = oldBlk.id;
          const changed =
            oldBlk.type !== block.blockType ||
            oldBlk.text !== block.text ||
            oldBlk.tool_name !== block.toolName ||
            oldBlk.tool_use_id !== block.toolUseId ||
            oldBlk.tool_input !== toolInputStr ||
            oldBlk.tool_result !== block.toolResult;
          if (changed && updateBlock != null) {
            updateBlock.run(
              blockId,
              block.blockType,
              block.text,
              block.toolName,
              block.toolUseId,
              toolInputStr,
              block.toolResult,
            );
          }
        } else {
          blockId = Number(
            insertBlock.run(
              messageId,
              sessionId,
              block.ordinal,
              block.blockType,
              block.text,
              block.toolName,
              block.toolUseId,
              toolInputStr,
              block.toolResult,
            ).lastInsertRowid,
          );
        }
        if (blockIdsByMsgAndOrd != null) {
          blockIdsByMsgAndOrd.set(`${messageId}:${block.ordinal}`, blockId);
        }
        if (block.blockType === "tool_use") {
          toolUseBlocks.push({
            messageId,
            messageSeq: message.seq,
            callBlockId: blockId,
            order,
            timestamp: block.calledAt ?? message.timestamp,
            block,
          });
        } else if (block.blockType === "tool_result" && block.toolUseId != null) {
          const queue = results.get(block.toolUseId) ?? [];
          queue.push({
            blockId,
            order,
            isError: block.isError,
            text: block.toolResult ?? "",
            timestamp: message.timestamp,
          });
          results.set(block.toolUseId, queue);
        }
      }

      if (oldBlocksForMsg != null) {
        for (const leftover of oldBlocksForMsg.values()) {
          blocksToDelete.push(leftover.id);
        }
      }
    }
    if (existingMsgBySeq != null) {
      for (const leftover of existingMsgBySeq.values()) {
        messagesToDelete.push(leftover.id);
      }
    }
  } finally {
    updateBlock?.finalize();
    insertBlock.finalize();
    updateMessage?.finalize();
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
  const updateToolCall = useDiff
    ? db.prepare(
        `UPDATE tool_call
            SET message_id = ?2, call_block_id = ?3, result_block_id = ?4, tool_kind = ?5,
                tool_name = ?6, mcp_server = ?7, tool_base_name = ?8, tool_use_id = ?9,
                input = ?10, input_bytes = ?11, is_error = ?12, has_result = ?13,
                output_preview = ?14, output_bytes = ?15, duration_ms = ?16, ordinal = ?17,
                timestamp = ?18
          WHERE id = ?1`,
      )
    : null;
  const deleteToolCall = useDiff ? db.prepare("DELETE FROM tool_call WHERE id = ?1") : null;
  const resultTaken = new Map<string, number>();
  try {
    for (const call of toolUseBlocks) {
      const name = call.block.toolName ?? "";
      const classified = classifyTool(name);
      const id = call.block.toolUseId;
      let taken = id == null ? 0 : (resultTaken.get(id) ?? 0);
      const queue = id == null ? undefined : results.get(id);
      while (queue?.[taken] != null && (queue[taken]?.order ?? 0) < call.order) {
        taken += 1;
      }
      const result = queue?.[taken];
      if (id != null) resultTaken.set(id, taken + 1);
      const resultBlockId = result?.blockId ?? null;
      const isError = result?.isError ?? null;
      const output = result?.text ?? null;
      const input = call.block.toolInput === undefined ? null : canonicalJson(call.block.toolInput);
      const inputBytes = input == null ? null : byteLength(input);
      const isErrorNum = isError == null ? null : Number(isError);
      const hasResult = Number(resultBlockId != null);
      const outputPreview = output == null ? null : previewHeadTail(output, 500);
      const outputBytes = output == null ? null : byteLength(output);
      const resultTimestamp = result?.timestamp ?? null;
      const durationMs = durationBetween(call.timestamp, resultTimestamp);

      const oldCalls = existingCallsByCallBlock?.get(call.callBlockId);
      if (oldCalls != null && existingCallsByCallBlock != null) {
        existingCallsByCallBlock.delete(call.callBlockId);
      }

      let oldIdx = 0;
      const syncCallRow = (
        msgId: number,
        callBlockId: number,
        resBlockId: number | null,
        toolKind: string,
        toolName: string,
        mcpServer: string | null,
        toolBaseName: string,
        toolUseId: string | null,
        inStr: string | null,
        inBytes: number | null,
        errNum: number | null,
        hasRes: number,
        outPrev: string | null,
        outBytes: number | null,
        durMs: number | null,
        ord: number,
        ts: string | null,
      ): number => {
        const oldRow = oldCalls?.[oldIdx++];
        if (oldRow != null) {
          const same =
            oldRow.message_id === msgId &&
            oldRow.call_block_id === callBlockId &&
            oldRow.result_block_id === resBlockId &&
            oldRow.tool_kind === toolKind &&
            oldRow.tool_name === toolName &&
            oldRow.mcp_server === mcpServer &&
            oldRow.tool_base_name === toolBaseName &&
            oldRow.tool_use_id === toolUseId &&
            oldRow.input === inStr &&
            oldRow.input_bytes === inBytes &&
            oldRow.is_error === errNum &&
            oldRow.has_result === hasRes &&
            oldRow.output_preview === outPrev &&
            oldRow.output_bytes === outBytes &&
            oldRow.duration_ms === durMs &&
            oldRow.ordinal === ord &&
            oldRow.timestamp === ts;
          if (!same && updateToolCall != null) {
            updateToolCall.run(
              oldRow.id,
              msgId,
              callBlockId,
              resBlockId,
              toolKind,
              toolName,
              mcpServer,
              toolBaseName,
              toolUseId,
              inStr,
              inBytes,
              errNum,
              hasRes,
              outPrev,
              outBytes,
              durMs,
              ord,
              ts,
            );
          }
          return oldRow.id;
        }
        return Number(
          insertToolCall.run(
            sessionId,
            msgId,
            callBlockId,
            resBlockId,
            toolKind,
            toolName,
            mcpServer,
            toolBaseName,
            toolUseId,
            inStr,
            inBytes,
            errNum,
            hasRes,
            outPrev,
            outBytes,
            durMs,
            ord,
            ts,
          ).lastInsertRowid,
        );
      };

      const toolCallId = syncCallRow(
        call.messageId,
        call.callBlockId,
        resultBlockId,
        classified.kind,
        name,
        classified.mcpServer,
        classified.baseName,
        call.block.toolUseId,
        input,
        inputBytes,
        isErrorNum,
        hasResult,
        outputPreview,
        outputBytes,
        durationMs,
        call.block.ordinal,
        call.timestamp,
      );
      if (resultBlockId != null && resultBlockCallInfo != null) {
        resultBlockCallInfo.set(resultBlockId, { toolName: name, input });
      }
      if (insertedCalls != null) {
        insertedCalls.push({
          toolCallId,
          messageId: call.messageId,
          callBlockId: call.callBlockId,
          callSeq: call.messageSeq,
          ordinal: call.block.ordinal,
          toolName: name,
          toolUseId: call.block.toolUseId,
          input,
          timestamp: call.timestamp,
          matched: resultBlockId != null,
          outputBytes: outputBytes ?? 0,
          hasInner: (call.block.innerToolCalls?.length ?? 0) > 0,
          isInner: false,
        });
      }
      for (const inner of call.block.innerToolCalls ?? []) {
        const innerClassified = classifyTool(inner.toolName);
        const innerInput = inner.toolInput === undefined ? null : canonicalJson(inner.toolInput);
        const innerInputBytes = innerInput == null ? null : byteLength(innerInput);
        const innerErrNum = inner.isError == null ? null : Number(inner.isError);
        const innerCallId = syncCallRow(
          call.messageId,
          call.callBlockId,
          null,
          innerClassified.kind,
          inner.toolName,
          innerClassified.mcpServer,
          innerClassified.baseName,
          inner.toolUseId,
          innerInput,
          innerInputBytes,
          innerErrNum,
          0,
          null,
          null,
          null,
          call.block.ordinal,
          call.timestamp,
        );
        if (insertedCalls != null) {
          insertedCalls.push({
            toolCallId: innerCallId,
            messageId: call.messageId,
            callBlockId: call.callBlockId,
            callSeq: call.messageSeq,
            ordinal: call.block.ordinal,
            toolName: inner.toolName,
            toolUseId: inner.toolUseId,
            input: innerInput,
            timestamp: call.timestamp,
            matched: false,
            outputBytes: 0,
            hasInner: false,
            isInner: true,
          });
        }
      }
      if (oldCalls != null && deleteToolCall != null) {
        for (let i = oldIdx; i < oldCalls.length; i += 1) {
          const oldCall = oldCalls[i];
          if (oldCall != null) deleteToolCall.run(oldCall.id);
        }
      }
    }
    if (existingCallsByCallBlock != null && deleteToolCall != null) {
      for (const leftoverList of existingCallsByCallBlock.values()) {
        for (const leftover of leftoverList) {
          deleteToolCall.run(leftover.id);
        }
      }
    }
  } finally {
    deleteToolCall?.finalize();
    updateToolCall?.finalize();
    insertToolCall.finalize();
  }

  const insertFileRef = db.prepare(
    `INSERT INTO file_ref(session_id, message_id, path, rel_path, ext, operation, timestamp)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );
  const updateFileRef = useDiff
    ? db.prepare(
        `UPDATE file_ref
            SET path = ?2, rel_path = ?3, ext = ?4, operation = ?5, timestamp = ?6
          WHERE id = ?1`,
      )
    : null;
  const deleteFileRef = useDiff ? db.prepare("DELETE FROM file_ref WHERE id = ?1") : null;
  try {
    if (useDiff && existingRefsByMsg != null) {
      const refsByMsg = new Map<number | null, typeof refs>();
      for (const ref of refs) {
        const msgId = messageIds[ref.messageIdx] ?? null;
        let list = refsByMsg.get(msgId);
        if (list == null) {
          list = [];
          refsByMsg.set(msgId, list);
        }
        list.push(ref);
      }
      for (const [msgId, desiredList] of refsByMsg) {
        const oldList = existingRefsByMsg.get(msgId) ?? [];
        existingRefsByMsg.delete(msgId);
        const minLen = Math.min(desiredList.length, oldList.length);
        for (let i = 0; i < minLen; i += 1) {
          const d = desiredList[i];
          const o = oldList[i];
          if (d == null || o == null) continue;
          if (
            o.path !== d.path ||
            o.rel_path !== d.relPath ||
            o.ext !== d.ext ||
            o.operation !== d.operation ||
            o.timestamp !== d.timestamp
          ) {
            updateFileRef?.run(o.id, d.path, d.relPath, d.ext, d.operation, d.timestamp);
          }
        }
        for (let i = minLen; i < desiredList.length; i += 1) {
          const d = desiredList[i];
          if (d == null) continue;
          insertFileRef.run(sessionId, msgId, d.path, d.relPath, d.ext, d.operation, d.timestamp);
        }
        for (let i = minLen; i < oldList.length; i += 1) {
          const o = oldList[i];
          if (o != null) deleteFileRef?.run(o.id);
        }
      }
      for (const leftoverList of existingRefsByMsg.values()) {
        for (const leftover of leftoverList) {
          deleteFileRef?.run(leftover.id);
        }
      }
    } else {
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
    }
  } finally {
    deleteFileRef?.finalize();
    updateFileRef?.finalize();
    insertFileRef.finalize();
  }

  if (blocksToDelete.length > 0) {
    const deleteBlock = db.prepare("DELETE FROM block WHERE id = ?1");
    try {
      for (const id of blocksToDelete) {
        deleteBlock.run(id);
      }
    } finally {
      deleteBlock.finalize();
    }
  }
  if (messagesToDelete.length > 0) {
    const deleteMessage = db.prepare("DELETE FROM message WHERE id = ?1");
    try {
      for (const id of messagesToDelete) {
        deleteMessage.run(id);
      }
    } finally {
      deleteMessage.finalize();
    }
  }

  reconcileBilledRequests(db, sessionId, { refreshReconciledSession: false, unsettled });
  const usage = materializeModelUsage(db, sessionId);
  runStatement(db, "UPDATE session SET estimated_cost_usd = ?1 WHERE id = ?2", [
    totalCost(sessionCostParts(usage, { model: s.model, usage: s.totals })),
    sessionId,
  ]);
  materializeSessionEconomics(db, sessionId);
  materializeContextWindow(db, sessionId);

  if (
    artifactOut != null &&
    insertedCalls != null &&
    blockIdsByMsgAndOrd != null &&
    resultBlockCallInfo != null
  ) {
    artifactOut.value = {
      sessionId,
      messageIds,
      insertedCalls,
      blockIdsByMsgAndOrd,
      resultBlockCallInfo,
    };
  }

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

function collectSourcePath(
  path: string,
  out: SourceFile[],
  databases: string[],
  hermesDatabases: string[],
  roots: SourceRoots,
): void {
  const { vscodeUserDirs = [] } = roots;
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isFile()) {
    if (isInVscodeStorage(path, vscodeUserDirs) && !isVscodeChatSessionFile(path)) return;
    if (pathBasename(path) === CURSOR_STORE_NAME) {
      if (isCursorConversationStore(path)) {
        out.push({ tool: "cursor", path, archived: false });
      }
      return;
    }
    if (pathBasename(path) === HERMES_DATABASE_NAME) {
      hermesDatabases.push(path);
      return;
    }
    if (path.endsWith(".db")) {
      databases.push(path);
      return;
    }
    const source = sourceFileForPath(path, roots);
    if (source != null) {
      out.push(source);
    }
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  for (const child of walk(path)) {
    if (isInVscodeStorage(child, vscodeUserDirs) && !isVscodeChatSessionFile(child)) continue;
    if (isOpenCodeDatabaseName(pathBasename(child))) {
      databases.push(child);
      continue;
    }
    if (pathBasename(child) === HERMES_DATABASE_NAME) {
      hermesDatabases.push(child);
      continue;
    }
    const source = sourceFileForPath(child, roots);
    if (source != null) {
      out.push(source);
    }
  }
}

interface SourceRoots {
  copilotDir?: string | undefined;
  vscodeUserDirs?: readonly (string | undefined)[];
  piDir?: string | undefined;
}

function sourceFileForPath(path: string, roots: SourceRoots): SourceFile | null {
  const { copilotDir, vscodeUserDirs = [], piDir } = roots;
  const name = pathBasename(path);
  if (name === CURSOR_STORE_NAME) {
    return isCursorConversationStore(path) ? { tool: "cursor", path, archived: false } : null;
  }
  if (isVscodeChatSessionFile(path)) {
    return { tool: "vscode_copilot", path, archived: false };
  }
  if (isInVscodeStorage(path, vscodeUserDirs)) return null;
  if (name.endsWith(".json")) {
    return isAtifDocument(path) ? { tool: "atif", path, archived: false } : null;
  }
  if (!isSessionJsonl(name) || name === "session_index.jsonl") {
    return null;
  }
  if (isCopilotSessionLog(path, copilotDir)) {
    return { tool: "copilot", path, archived: false };
  }
  if (isPiSessionLog(path, piDir)) {
    return { tool: "pi", path, archived: false };
  }
  if (isInCopilotSessionState(path, copilotDir)) {
    // Rotated `events.N.jsonl` archives and files a session wrote into its
    // own directory are not transcripts of any source.
    return null;
  }
  if (isCodexRollout(name)) {
    return { tool: "codex", path, archived: hasPathSegment(path, "archived_sessions") };
  }
  if (geminiSessionLayout(path) != null) {
    return { tool: "gemini", path, archived: false };
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
function isSessionJsonl(name: string): boolean {
  return name.endsWith(".jsonl") && name !== "journal.jsonl";
}

/** Copilot CLI keeps one directory per session under `session-state`, with
 * the live journal at `<session id>/events.jsonl`. */
const COPILOT_EVENTS_NAME = "events.jsonl";

function collectCopilot(copilotDir: string, out: SourceFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(copilotDir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const path = join(copilotDir, entry, COPILOT_EVENTS_NAME);
    if (existsSync(path)) {
      out.push({ tool: "copilot", path, archived: false });
    }
  }
}

/** Pi writes `<sessions>/--<cwd>--/<timestamp>_<session id>.jsonl`, with the
 * working directory's separators replaced by `-`. */
function isPiSessionLog(path: string, piDir?: string): boolean {
  const projectDir = dirname(path);
  const sessionsDir = dirname(projectDir);
  if (piDir != null && isInside(resolve(piDir), resolve(path))) {
    return true;
  }
  const project = pathBasename(projectDir);
  return (
    pathBasename(sessionsDir) === "sessions" &&
    pathBasename(dirname(sessionsDir)) === "agent" &&
    project.length > 4 &&
    project.startsWith("--") &&
    project.endsWith("--")
  );
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isCopilotSessionLog(path: string, copilotDir?: string): boolean {
  return (
    pathBasename(path) === COPILOT_EVENTS_NAME &&
    (pathBasename(dirname(dirname(path))) === "session-state" ||
      (copilotDir != null && resolve(dirname(dirname(path))) === resolve(copilotDir)))
  );
}

function isInCopilotSessionState(path: string, copilotDir?: string): boolean {
  let dir = dirname(path);
  while (dirname(dir) !== dir) {
    if (
      pathBasename(dirname(dir)) === "session-state" ||
      (copilotDir != null && resolve(dirname(dir)) === resolve(copilotDir))
    ) {
      return true;
    }
    dir = dirname(dir);
  }
  return false;
}

/** VS Code keeps a workspace window's chat sessions in
 * `workspaceStorage/<workspace id>/chatSessions/` and an empty window's in
 * `globalStorage/emptyWindowChatSessions/`. Each session is `<id>.jsonl` (a
 * mutation log, VS Code 1.109 and later) or `<id>.json` (a whole snapshot,
 * earlier builds). `transferredChatSessions` holds short-lived copies that
 * VS Code deletes once another window opens them, so it is not read. */
const VSCODE_WORKSPACE_CHAT_DIR = "chatSessions";
const VSCODE_EMPTY_WINDOW_CHAT_DIR = "emptyWindowChatSessions";

interface VscodeChatCandidate {
  file: SourceFile;
  id: string;
  log: boolean;
  mtime: number;
}

function collectVscodeCopilot(userDirs: (string | undefined)[], out: SourceFile[]): void {
  const candidates: VscodeChatCandidate[] = [];
  for (const userDir of new Set(userDirs)) {
    if (userDir == null) {
      continue;
    }
    const workspaceStorage = join(userDir, "workspaceStorage");
    for (const workspace of listDir(workspaceStorage)) {
      collectVscodeChatDir(
        join(workspaceStorage, workspace, VSCODE_WORKSPACE_CHAT_DIR),
        candidates,
      );
    }
    collectVscodeChatDir(join(userDir, "globalStorage", VSCODE_EMPTY_WINDOW_CHAT_DIR), candidates);
  }
  out.push(...newestVscodeCopies(candidates));
}

function collectVscodeChatDir(dir: string, candidates: VscodeChatCandidate[]): void {
  for (const name of listDir(dir)) {
    const log = name.endsWith(".jsonl");
    if (!log && !name.endsWith(".json")) {
      continue;
    }
    const path = join(dir, name);
    let mtime: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) {
        continue;
      }
      mtime = stats.mtimeMs;
    } catch {
      continue;
    }
    candidates.push({
      file: { tool: "vscode_copilot", path, archived: false },
      id: fileStem(name),
      log,
      mtime,
    });
  }
}

/**
 * One file per chat session. VS Code reads `<id>.jsonl` before `<id>.json`,
 * and leaves the older `.json` behind after it switches a session to the log,
 * so the log wins. Opening an empty window's chat in a folder copies its file
 * into that workspace's storage and keeps the original, so of two copies of
 * one session the more recently written one wins.
 */
function newestVscodeCopies(candidates: VscodeChatCandidate[]): SourceFile[] {
  const best = new Map<string, VscodeChatCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.id);
    if (
      current == null ||
      (candidate.log && !current.log) ||
      (candidate.log === current.log && candidate.mtime > current.mtime)
    ) {
      best.set(candidate.id, candidate);
    }
  }
  return [...best.values()]
    .map((candidate) => candidate.file)
    .sort((a, b) => compareCodePoints(a.path, b.path));
}

function preferVscodeLogs(files: SourceFile[]): SourceFile[] {
  const logs = new Set(
    files
      .filter((file) => file.tool === "vscode_copilot" && file.path.endsWith(".jsonl"))
      .map((file) => file.path.slice(0, -".jsonl".length)),
  );
  return files.filter(
    (file) =>
      file.tool !== "vscode_copilot" ||
      !file.path.endsWith(".json") ||
      !logs.has(file.path.slice(0, -".json".length)),
  );
}

function isInVscodeStorage(path: string, userDirs: readonly (string | undefined)[]): boolean {
  const segments = path.split(/[\\/]+/);
  if (
    segments.some(
      (segment, i) =>
        segment === "User" &&
        (segments[i + 1] === "workspaceStorage" || segments[i + 1] === "globalStorage"),
    )
  )
    return true;
  const absolute = resolve(path);
  return userDirs.some(
    (userDir) =>
      userDir != null &&
      ["workspaceStorage", "globalStorage"].some((storage) =>
        absolute.startsWith(`${resolve(join(userDir, storage))}${sep}`),
      ),
  );
}

function isVscodeChatSessionFile(path: string): boolean {
  if (!path.endsWith(".json") && !path.endsWith(".jsonl")) {
    return false;
  }
  const dir = dirname(path);
  const dirName = pathBasename(dir);
  if (dirName === VSCODE_WORKSPACE_CHAT_DIR) {
    return pathBasename(dirname(dirname(dir))) === "workspaceStorage";
  }
  return dirName === VSCODE_EMPTY_WINDOW_CHAT_DIR && pathBasename(dirname(dir)) === "globalStorage";
}

/** `workspace.json` beside a workspace's `chatSessions` directory names the
 * folder or `.code-workspace` file the window had open. */
function readVscodeWorkspace(path: string): Json | null {
  const dir = dirname(path);
  if (pathBasename(dir) !== VSCODE_WORKSPACE_CHAT_DIR) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(dir), "workspace.json"), "utf8")) as Json;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort(compareCodePoints);
  } catch {
    return [];
  }
}

interface GeminiSessionLayout {
  chatsDir: string;
  parentSessionId: string | null;
}

function collectGemini(geminiDir: string, out: SourceFile[]): void {
  if (!existsSync(geminiDir)) {
    return;
  }
  for (const path of walk(geminiDir)) {
    if (geminiSessionLayout(path) != null) {
      out.push({ tool: "gemini", path, archived: false });
    }
  }
}

/** Gemini CLI writes chats to `<project>/chats/session-<ts>-<hash>.jsonl` and
 * subagent chats to `<project>/chats/<parent-session-id>/<session-id>.jsonl`.
 * Requiring the `chats` segment keeps `--path` and directory discovery from
 * claiming a Claude Code file that merely starts with `session-`. */
function geminiSessionLayout(path: string): GeminiSessionLayout | null {
  const name = pathBasename(path);
  if (!name.endsWith(".jsonl")) {
    return null;
  }
  const parent = dirname(path);
  if (pathBasename(parent) === "chats") {
    return name.startsWith("session-") ? { chatsDir: parent, parentSessionId: null } : null;
  }
  const grandparent = dirname(parent);
  if (pathBasename(grandparent) === "chats") {
    return { chatsDir: grandparent, parentSessionId: pathBasename(parent) };
  }
  return null;
}

function geminiProjectPath(layout: GeminiSessionLayout | null): string | null {
  if (layout == null) {
    return null;
  }
  const rootFile = join(dirname(layout.chatsDir), ".project_root");
  try {
    const root = readFileSync(rootFile, "utf8").trim();
    if (root !== "") {
      return root;
    }
  } catch {}
  return null;
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
    } catch {}
  }
  return titles;
}

function fileStem(path: string): string {
  const base = pathBasename(path);
  const ext = extname(base);
  return ext === "" ? base : base.slice(0, -ext.length);
}

export function lineCount(content: string): number {
  if (content === "") {
    return 0;
  }
  let newlines = 0;
  for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) {
    newlines += 1;
  }
  return content.endsWith("\n") ? newlines : newlines + 1;
}

function mtimeSecs(stats: Stats): number {
  return Math.trunc(stats.mtimeMs / 1000);
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

/** Multi-path json_extract keeps JSON types, so `true` stays distinct from `1`. */
function firstMessageFields(value: string | null): Json | undefined {
  const fields = parseObject(value);
  if (!Array.isArray(fields)) {
    return undefined;
  }
  return {
    isSidechain: fields[0] ?? null,
    sessionId: fields[1] ?? null,
    agentId: fields[2] ?? null,
  };
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
