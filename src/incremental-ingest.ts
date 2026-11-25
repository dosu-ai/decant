import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readSync, type Stats, statSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync } from "bun";
import {
  type IncrementalBilledEntry,
  reconcileBilledRequestsIncremental,
} from "./billed-requests.ts";
import {
  ACTIVITY_BUCKETS,
  type ActivityBucket,
  blockBucket,
  countSearchCandidateToolCall,
  isCodeEditTool,
  isUserQuestionTool,
  toolBucket,
} from "./buckets.ts";
import { isWebSearchBlock, keywordWorkType, type Outcome, type WorkType } from "./classify.ts";
import {
  CONTEXT_WINDOW_USER_TEXT_PREDICATE_SQL,
  contextTokensFromUsage,
  inferClaudeContextWindowTokens,
  isCompactBoundary,
  isContextWindowRealUserText,
  type MessageRawMeta,
  materializeContextWindow,
} from "./context-window.ts";
import { isPriceable, type PriceTier, requestPriceTier } from "./cost.ts";
import { withImmediateTransaction } from "./db.ts";
import {
  ACTIVE_GAP_CAP_SECONDS,
  copiedBeforeStart,
  countToolUseBlocks,
  epochSecs,
  type Facets,
  fileRefsForMessage,
  isAgentSpawnTool,
  isRenderableReply,
} from "./enrich.ts";
import { MAX_SOURCE_FILE_BYTES } from "./ingest-limits.ts";
import {
  asBoolean,
  asInteger,
  asString,
  byteLength,
  canonicalJson,
  get,
  isObject,
} from "./json.ts";
import {
  encodeBlockToolResult,
  encodeMessageRaw,
  MESSAGE_METADATA_SQL,
} from "./message-storage.ts";
import {
  emptyUsage,
  type Issue,
  type Json,
  type NormalizedBlock,
  type NormalizedInnerToolCall,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type TokenUsage,
  type Tool,
} from "./model.ts";
import {
  type ModelUsageRow,
  materializeModelUsage,
  sessionCostParts,
  totalCost,
  writeModelUsageRows,
} from "./model-usage.ts";
import { compareCodePoints } from "./order.ts";
import {
  type ClaudeStepperState,
  claudeSessionFromState,
  claudeUnknownTypeIssues,
  compactClaudeStepper,
  createClaudeStepper,
  stepClaudeLine,
} from "./sources/claude.ts";
import {
  type CodexStepperState,
  codexSessionFromState,
  codexUnknownTypeIssues,
  createCodexStepper,
  stepCodexLine,
} from "./sources/codex.ts";
import {
  createPiStepper,
  type PiStepperState,
  piSessionFromState,
  piUnknownTypeIssues,
  stepPiLine,
} from "./sources/pi.ts";
import {
  diagnosticRawLine,
  jsonProblem,
  nullRecord,
  ownGet,
  parseSourceJson,
} from "./sources/shared.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";
import {
  bumpSyncStateGeneration,
  SYNC_STATE_DERIVED_PENDING,
  SYNC_STATE_RECOMMENDATIONS_PENDING,
} from "./sync-state.ts";
import {
  materializeSessionEconomics,
  type Phase,
  type SessionEconomicsVector,
  storeEconomicsVector,
} from "./token-economics.ts";
import { classifyTool, previewHeadTail } from "./tools.ts";

export type IncrementalTool = "claude_code" | "codex" | "pi";

const CHECKPOINT_VERSION = 6;
const ANCHOR_SAMPLE_BYTES = 32_768;
const ANCHOR_MID_BYTES = 4_096;
const CHARS_PER_TOKEN = 4;
const ACTIVE_GAP_CAP_MS = ACTIVE_GAP_CAP_SECONDS * 1000;
const INTERRUPTION_MARKER = "[Request interrupted by user";
const COMMAND_MARKER = "<command-name>";
const MODEL_INPUT_KINDS = new Set(["agent_message", "compaction"]);
const CLAUDE_RECENT_REQUEST_WINDOW = 64;
const MAX_PI_TOOL_USES_WINDOW = 64;
const MAX_CODEX_ECON_BLOCKS = 256;
const COMPACT_SET_EXACT_LIMIT = 64;
const BLOOM_HASHES = 10;
const BLOOM_MIN_BITS = 16_384;
const BLOOM_MAX_BITS = 524_288;

type CompactKeySet = { exact: string[] } | { bloom: string };

interface MutableCompactKeySet {
  exact: Set<string> | null;
  bits: Uint8Array | null;
  mask: number;
}

function hashPair32(key: string): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca77);
    h2 ^= h2 >>> 13;
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x7feb352d);
  h1 ^= h1 >>> 15;
  h2 ^= h2 >>> 16;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  return [h1 >>> 0, (h2 | 1) >>> 0];
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function bloomBitsForCount(count: number): number {
  return Math.min(BLOOM_MAX_BITS, Math.max(BLOOM_MIN_BITS, nextPowerOfTwo(count * 48)));
}

function openCompactSet(stored?: CompactKeySet): MutableCompactKeySet {
  if (stored == null) {
    return { exact: new Set(), bits: null, mask: 0 };
  }
  if ("exact" in stored) {
    return { exact: new Set(stored.exact), bits: null, mask: 0 };
  }
  const buf = Buffer.from(stored.bloom, "base64");
  const bits = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return { exact: null, bits, mask: bits.length * 8 - 1 };
}

function buildCompactSet(keys: Iterable<string>, expectedCount: number): CompactKeySet {
  if (expectedCount <= COMPACT_SET_EXACT_LIMIT) {
    const exact: string[] = [];
    for (const k of keys) exact.push(k);
    return { exact };
  }
  const bitCount = bloomBitsForCount(expectedCount);
  const bits = new Uint8Array(bitCount >> 3);
  const mask = bitCount - 1;
  for (const k of keys) {
    const [h1, h2] = hashPair32(k);
    for (let i = 0; i < BLOOM_HASHES; i += 1) {
      const bit = (h1 + Math.imul(i, h2)) & mask;
      bits[bit >>> 3] = (bits[bit >>> 3] ?? 0) | (1 << (bit & 7));
    }
  }
  return { bloom: Buffer.from(bits).toString("base64") };
}

function compactSetHas(set: MutableCompactKeySet, key: string): boolean {
  if (set.exact != null) {
    return set.exact.has(key);
  }
  const bits = set.bits;
  if (bits == null) return false;
  const [h1, h2] = hashPair32(key);
  for (let i = 0; i < BLOOM_HASHES; i += 1) {
    const bit = (h1 + Math.imul(i, h2)) & set.mask;
    if (((bits[bit >>> 3] ?? 0) & (1 << (bit & 7))) === 0) {
      return false;
    }
  }
  return true;
}

function confirmedCompactSetHas(
  set: MutableCompactKeySet,
  key: string,
  verify: (key: string) => boolean,
): boolean {
  if (set.exact != null) {
    return set.exact.has(key);
  }
  return compactSetHas(set, key) && verify(key);
}

function hasBlockWithToolUseId(
  db: Database,
  sessionId: number,
  toolUseId: string,
  blockType: "tool_use" | "tool_result",
): boolean {
  return (
    queryRow(
      db,
      `SELECT 1 FROM block
        WHERE session_id = ?1 AND tool_use_id = ?2 AND type = ?3
        LIMIT 1`,
      [sessionId, toolUseId, blockType],
    ) != null
  );
}

function compactSetAdd(set: MutableCompactKeySet, key: string): void {
  if (set.exact != null) {
    set.exact.add(key);
    if (set.exact.size > COMPACT_SET_EXACT_LIMIT) {
      const bitCount = bloomBitsForCount(Math.max(set.exact.size * 4, 2_048));
      const bits = new Uint8Array(bitCount >> 3);
      const mask = bitCount - 1;
      for (const existing of set.exact) {
        const [h1, h2] = hashPair32(existing);
        for (let i = 0; i < BLOOM_HASHES; i += 1) {
          const bit = (h1 + Math.imul(i, h2)) & mask;
          bits[bit >>> 3] = (bits[bit >>> 3] ?? 0) | (1 << (bit & 7));
        }
      }
      set.exact = null;
      set.bits = bits;
      set.mask = mask;
    }
    return;
  }
  const bits = set.bits;
  if (bits == null) return;
  const [h1, h2] = hashPair32(key);
  for (let i = 0; i < BLOOM_HASHES; i += 1) {
    const bit = (h1 + Math.imul(i, h2)) & set.mask;
    bits[bit >>> 3] = (bits[bit >>> 3] ?? 0) | (1 << (bit & 7));
  }
}

function sealCompactSet(set: MutableCompactKeySet): CompactKeySet {
  if (set.exact != null) {
    return { exact: [...set.exact] };
  }
  return { bloom: Buffer.from(set.bits ?? new Uint8Array(0)).toString("base64") };
}

export function isIncrementalTool(tool: Tool): tool is IncrementalTool {
  return tool === "claude_code" || tool === "codex" || tool === "pi";
}

export interface ScannedLines {
  lines: { line: string; lineNo: number }[];
  parsedOffset: number;
  parsedLineCount: number;
  needsLeadingNewline: boolean;
  tornIssue: Issue | null;
  totalLines: number;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

export function scanLinesFromBuffer(
  buf: Buffer,
  startOffset: number,
  startLineNo: number,
): ScannedLines {
  if (buf.length === 0) {
    return {
      lines: [],
      parsedOffset: startOffset,
      parsedLineCount: startLineNo - 1,
      needsLeadingNewline: false,
      tornIssue: null,
      totalLines: startLineNo - 1,
    };
  }
  const lines: { line: string; lineNo: number }[] = [];
  const lastLf = buf.lastIndexOf(0x0a);
  let parsedOffset = startOffset;
  let parsedLineCount = startLineNo - 1;
  if (lastLf >= 0) {
    const completeText = buf.subarray(0, lastLf).toString("utf8");
    const split = completeText.split("\n");
    for (let i = 0; i < split.length; i += 1) {
      lines.push({ line: split[i] ?? "", lineNo: startLineNo + i });
    }
    parsedOffset = startOffset + lastLf + 1;
    parsedLineCount = startLineNo - 1 + split.length;
  }

  const tailStart = lastLf + 1;
  if (tailStart >= buf.length) {
    return {
      lines,
      parsedOffset,
      parsedLineCount,
      needsLeadingNewline: false,
      tornIssue: null,
      totalLines: parsedLineCount,
    };
  }

  const tailBuf = buf.subarray(tailStart);
  const nextLineNo = parsedLineCount + 1;
  let tailText: string;
  try {
    tailText = fatalUtf8.decode(tailBuf);
  } catch {
    const lossy = tailBuf.toString("utf8");
    return {
      lines,
      parsedOffset,
      parsedLineCount,
      needsLeadingNewline: false,
      tornIssue: {
        code: "unparsed_line",
        lineNo: nextLineNo,
        error: "record is not valid JSON",
        rawLine: lossy,
      },
      totalLines: nextLineNo,
    };
  }

  if (tailText.trim() === "") {
    return {
      lines,
      parsedOffset,
      parsedLineCount,
      needsLeadingNewline: false,
      tornIssue: null,
      totalLines: nextLineNo,
    };
  }

  try {
    parseSourceJson(tailText);
  } catch (error) {
    return {
      lines,
      parsedOffset,
      parsedLineCount,
      needsLeadingNewline: false,
      tornIssue: {
        code: "unparsed_line",
        lineNo: nextLineNo,
        error: jsonProblem(error),
        rawLine: diagnosticRawLine(error, tailText),
      },
      totalLines: nextLineNo,
    };
  }

  lines.push({ line: tailText, lineNo: nextLineNo });
  return {
    lines,
    parsedOffset: startOffset + buf.length,
    parsedLineCount: nextLineNo,
    needsLeadingNewline: true,
    tornIssue: null,
    totalLines: nextLineNo,
  };
}

export function computePrefixHash(fd: number, parsedOffset: number): string {
  const hash = createHash("sha256");
  hash.update(`v1:${parsedOffset}:`);
  if (parsedOffset <= 0) {
    return `v1:${hash.digest("hex")}`;
  }
  const headLen = Math.min(ANCHOR_SAMPLE_BYTES, parsedOffset);
  const head = readSlice(fd, 0, headLen);
  hash.update(head);
  hash.update(":");
  if (parsedOffset > ANCHOR_SAMPLE_BYTES * 2) {
    const midPos = Math.floor((parsedOffset - ANCHOR_MID_BYTES) / 2);
    hash.update(readSlice(fd, midPos, ANCHOR_MID_BYTES));
    hash.update(":");
  }
  const tailStart = Math.max(0, parsedOffset - ANCHOR_SAMPLE_BYTES);
  if (tailStart > 0) {
    hash.update(readSlice(fd, tailStart, parsedOffset - tailStart));
  }
  return `v1:${hash.digest("hex")}`;
}

export function computePrefixHashFromBuffer(buf: Buffer, parsedOffset: number): string {
  const hash = createHash("sha256");
  hash.update(`v1:${parsedOffset}:`);
  if (parsedOffset <= 0) {
    return `v1:${hash.digest("hex")}`;
  }
  const headLen = Math.min(ANCHOR_SAMPLE_BYTES, parsedOffset);
  hash.update(buf.subarray(0, headLen));
  hash.update(":");
  if (parsedOffset > ANCHOR_SAMPLE_BYTES * 2) {
    const midPos = Math.floor((parsedOffset - ANCHOR_MID_BYTES) / 2);
    hash.update(buf.subarray(midPos, midPos + ANCHOR_MID_BYTES));
    hash.update(":");
  }
  const tailStart = Math.max(0, parsedOffset - ANCHOR_SAMPLE_BYTES);
  if (tailStart > 0) {
    hash.update(buf.subarray(tailStart, parsedOffset));
  }
  return `v1:${hash.digest("hex")}`;
}

function readSlice(fd: number, position: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, out, read, length - read, position + read);
    if (count === 0) {
      return out.subarray(0, read);
    }
    read += count;
  }
  return out;
}

export function readSourceBuffer(fd: number, sizeHint?: number): Buffer | null {
  if (sizeHint != null && sizeHint > MAX_SOURCE_FILE_BYTES) {
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (total <= MAX_SOURCE_FILE_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_FILE_BYTES + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, position);
    if (count === 0) {
      return Buffer.concat(chunks, total);
    }
    total += count;
    position += count;
    if (total > MAX_SOURCE_FILE_BYTES) {
      return null;
    }
    chunks.push(chunk.subarray(0, count));
  }
  return null;
}

interface EnrichFoldState {
  facets: Facets;
  previousTimestamp: number | null;
  fileRefCount: number;
  fileReads: number;
  fileWrites: number;
  fileEdits: number;
  fileMutations: number;
  webSearches: number;
  firstUserPrompt: string | null;
  lastMain3Interrupted: boolean[];
  lastMainContent: {
    role: "user" | "assistant" | "tool";
    stopReason: string | null;
    hasToolError: boolean;
  } | null;
}

interface UnmatchedToolCall {
  toolCallId: number;
  callBlockId: number;
  callSeq: number;
  toolName: string;
  input: string | null;
  timestamp: string | null;
}

interface PiToolUseAnchor {
  messageId: number;
  callBlockId: number;
  ordinal: number;
  timestamp: string | null;
  hasInner: boolean;
}

interface ModelUsageGroupState {
  model: string;
  tier: PriceTier;
  requests: number;
  usage: TokenUsage;
  reportedCost: number;
}

interface ModelUsageFoldState {
  groups: Record<string, ModelUsageGroupState>;
  billed: TokenUsage;
  totalBilledMessages: number;
  unpricedReportedTotal: number;
  sawReported: boolean;
  hasUnrecordedModelMessage: boolean;
}

interface ContextWindowFoldState {
  turn: number;
  pointCount: number;
  compactionCount: number;
  peakTokens: number;
  lastContextSinceCompaction: number | null;
}

interface EconomicsBucketState {
  generation: number;
  contextWindow: number;
  toolCalls: number;
  touched: boolean;
  genOrientation: number;
  windowOrientation: number;
  activeMs: number;
  activeMsOrientation: number;
}

interface EconomicsFoldState {
  valid: boolean;
  firstEditSeq: number | null;
  previousLatencyMs: number | null;
  waitingOnUserMs: number;
  sawMessageOutput: boolean;
  seenResponseKeys: CompactKeySet;
  buckets: Record<ActivityBucket, EconomicsBucketState>;
  codexWeights?: {
    blocks: [number, 0 | 1, number][];
    orientationTotal: number;
    total: number;
    hasAssistantBlocks: boolean;
  };
}

interface DiagnosticsFoldState {
  seenToolUse: CompactKeySet;
  answeredToolUse: CompactKeySet;
  orphanToolResultIds: string[];
  hasLinkageIssues: boolean;
}

interface ClaudeBilledRuntime {
  messageId: number;
  model: string | null;
  tier: PriceTier;
  usage: TokenUsage;
  reportedCost: number;
  apiMessageId: string | null;
}

export interface IncrementalCheckpointState {
  version: typeof CHECKPOINT_VERSION;
  tool: IncrementalTool;
  sessionId: number;
  isArchived: boolean;
  needsLeadingNewline: boolean;
  externalKey: string;
  parser: ClaudeStepperState | CodexStepperState | PiStepperState;
  claudeBilledRuntime?: Record<string, ClaudeBilledRuntime>;
  claudeEvictedRequests?: CompactKeySet;
  codexLatestAssistantMessageId?: number | null;
  piToolUses?: Record<string, PiToolUseAnchor>;
  enrich: EnrichFoldState;
  replyCount: number;
  toolCallCount: number;
  searchCount: number;
  unmatchedCalls: Record<string, UnmatchedToolCall[]>;
  modelUsage: ModelUsageFoldState;
  contextWindow: ContextWindowFoldState;
  economics: EconomicsFoldState;
  diagnostics: DiagnosticsFoldState;
}

function createEmptyEnrich(): EnrichFoldState {
  return {
    facets: {
      turnCount: 0,
      errorCount: 0,
      interruptionCount: 0,
      compactionCount: 0,
      sidechainMessageCount: 0,
      agentSpawnCount: 0,
      skillCount: 0,
      commandCount: 0,
      thinkingBlockCount: 0,
      thinkingChars: 0,
      activeSeconds: 0,
    },
    previousTimestamp: null,
    fileRefCount: 0,
    fileReads: 0,
    fileWrites: 0,
    fileEdits: 0,
    fileMutations: 0,
    webSearches: 0,
    firstUserPrompt: null,
    lastMain3Interrupted: [],
    lastMainContent: null,
  };
}

function createEmptyModelUsage(): ModelUsageFoldState {
  return {
    groups: nullRecord<ModelUsageGroupState>(),
    billed: emptyUsage(),
    totalBilledMessages: 0,
    unpricedReportedTotal: 0,
    sawReported: false,
    hasUnrecordedModelMessage: false,
  };
}

function createEmptyContextWindow(): ContextWindowFoldState {
  return {
    turn: 0,
    pointCount: 0,
    compactionCount: 0,
    peakTokens: 0,
    lastContextSinceCompaction: null,
  };
}

function emptyEconomicsBuckets(): Record<ActivityBucket, EconomicsBucketState> {
  const out = {} as Record<ActivityBucket, EconomicsBucketState>;
  for (const bucket of ACTIVITY_BUCKETS) {
    out[bucket] = {
      generation: 0,
      contextWindow: 0,
      toolCalls: 0,
      touched: false,
      genOrientation: 0,
      windowOrientation: 0,
      activeMs: 0,
      activeMsOrientation: 0,
    };
  }
  return out;
}

function createEmptyEconomics(tool: IncrementalTool): EconomicsFoldState {
  return {
    valid: true,
    firstEditSeq: null,
    previousLatencyMs: null,
    waitingOnUserMs: 0,
    sawMessageOutput: false,
    seenResponseKeys: buildCompactSet([], 0),
    buckets: emptyEconomicsBuckets(),
    ...(tool === "codex"
      ? {
          codexWeights: {
            blocks: [],
            orientationTotal: 0,
            total: 0,
            hasAssistantBlocks: false,
          },
        }
      : {}),
  };
}

function rawBoolean(raw: unknown, key: string): boolean | null {
  if (!isObject(raw)) return null;
  const value = raw[key];
  return typeof value === "boolean" ? value : null;
}

function rawString(raw: unknown, key: string): string | null {
  if (!isObject(raw)) return null;
  const value = raw[key];
  return typeof value === "string" ? value : null;
}

function foldEnrichMessage(
  enrich: EnrichFoldState,
  tool: IncrementalTool,
  isSubagent: boolean,
  startedAt: string | null,
  message: NormalizedMessage,
  newRefsCount: number,
  newRefs: readonly { operation: string }[],
): boolean {
  let spawnedAgent = false;
  const got = enrich.facets;
  const sidechain = rawBoolean(message.raw, "isSidechain") === true;
  const compactSummary = rawBoolean(message.raw, "isCompactSummary") === true;
  if (sidechain) {
    got.sidechainMessageCount += 1;
  }
  if (
    rawString(message.raw, "subtype") === "compact_boundary" ||
    rawString(message.raw, "type") === "compacted" ||
    rawString(message.raw, "type") === "compaction"
  ) {
    got.compactionCount += 1;
  }
  if (tool === "pi" && message.stopReason === "aborted") {
    got.interruptionCount += 1;
  }

  let hasRealText = false;
  let hasInterruptionText = false;
  let hasToolError = false;
  for (const blk of message.blocks) {
    if (isWebSearchBlock(blk)) {
      enrich.webSearches += 1;
    }
    if (blk.blockType === "text") {
      const text = blk.text ?? "";
      if (text.startsWith(INTERRUPTION_MARKER)) {
        got.interruptionCount += 1;
        hasInterruptionText = true;
      } else if (text.includes(COMMAND_MARKER)) {
        got.commandCount += 1;
      } else if (text.trim() !== "") {
        hasRealText = true;
        if (message.role === "user" && enrich.firstUserPrompt == null) {
          enrich.firstUserPrompt = text.toLowerCase();
        }
      }
    } else if (blk.blockType === "thinking") {
      got.thinkingBlockCount += 1;
      got.thinkingChars += byteLength(blk.text ?? "");
    } else if (blk.blockType === "tool_use") {
      if (isAgentSpawnTool(tool, blk.toolName)) {
        got.agentSpawnCount += 1;
        spawnedAgent = true;
      } else if (blk.toolName === "Skill") {
        got.skillCount += 1;
      }
      if (tool === "codex" && blk.toolName === "spawn_agent") {
        spawnedAgent = true;
      }
    } else if (blk.blockType === "tool_result" && blk.isError === true) {
      got.errorCount += 1;
      hasToolError = true;
    }
  }

  if (message.role === "user" && hasRealText && (!sidechain || isSubagent) && !compactSummary) {
    got.turnCount += 1;
  }

  const timestamp =
    message.timestamp == null || copiedBeforeStart(tool, startedAt, message.timestamp)
      ? null
      : epochSecs(message.timestamp);
  if (timestamp != null) {
    if (enrich.previousTimestamp != null) {
      const gap = timestamp - enrich.previousTimestamp;
      if (gap > 0) {
        got.activeSeconds += Math.min(gap, ACTIVE_GAP_CAP_SECONDS);
      }
    }
    enrich.previousTimestamp =
      enrich.previousTimestamp == null ? timestamp : Math.max(enrich.previousTimestamp, timestamp);
  }

  enrich.fileRefCount += newRefsCount;
  for (const ref of newRefs) {
    if (ref.operation === "read") {
      enrich.fileReads += 1;
    } else {
      enrich.fileMutations += 1;
      if (ref.operation === "write") enrich.fileWrites += 1;
      else if (ref.operation === "edit") enrich.fileEdits += 1;
    }
  }

  if (!sidechain) {
    enrich.lastMain3Interrupted.push(hasInterruptionText);
    if (enrich.lastMain3Interrupted.length > 3) {
      enrich.lastMain3Interrupted.shift();
    }
    if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
      enrich.lastMainContent = {
        role: message.role,
        stopReason: message.stopReason,
        hasToolError,
      };
    }
  }

  return spawnedAgent;
}

function outcomeFromEnrich(enrich: EnrichFoldState): Outcome | null {
  if (enrich.lastMain3Interrupted.length === 0) {
    return null;
  }
  if (enrich.lastMain3Interrupted.some(Boolean)) {
    return "abandoned";
  }
  const last = enrich.lastMainContent;
  if (last == null) {
    return null;
  }
  if (last.role === "user") {
    return "abandoned";
  }
  if (last.role === "tool") {
    return last.hasToolError ? "failed" : "abandoned";
  }
  if (last.stopReason === "tool_use") {
    return "abandoned";
  }
  return "completed";
}

function workTypeFromEnrich(enrich: EnrichFoldState): WorkType | null {
  if (enrich.firstUserPrompt != null) {
    const keyword = keywordWorkType(enrich.firstUserPrompt);
    if (keyword != null) {
      return keyword;
    }
  }
  if (enrich.fileMutations === 0 && (enrich.fileReads > 0 || enrich.webSearches > 0)) {
    return "research";
  }
  if (enrich.fileWrites > enrich.fileEdits && enrich.fileWrites > 0) {
    return "feature";
  }
  if (enrich.fileEdits > 0) {
    return "feature";
  }
  return null;
}

function isRecordedModel(model: string | null): model is string {
  return model != null && model !== "" && !/^<.*>$/.test(model);
}

function isPriceableModel(model: string): boolean {
  return model !== "" && isPriceable(model);
}

function modelUsageKey(model: string, tier: PriceTier): string {
  return `${model}\0${tier}`;
}

function extractMessageUsageMeta(
  tool: IncrementalTool,
  raw: Json,
): { cacheCreation1h: number; speed: string | null; reportedCost: number } {
  if (tool === "claude_code") {
    const usage = get(get(raw, "message"), "usage");
    const creation = get(usage, "cache_creation");
    return {
      cacheCreation1h: asInteger(get(creation, "ephemeral_1h_input_tokens")) ?? 0,
      speed: asString(get(usage, "speed")),
      reportedCost: 0,
    };
  }
  if (tool === "pi") {
    const msgUsage = get(get(raw, "message"), "usage");
    const topUsage = get(raw, "usage");
    const c1h =
      asInteger(get(msgUsage, "cacheWrite1h")) ?? asInteger(get(topUsage, "cacheWrite1h")) ?? 0;
    const costRaw = get(get(msgUsage, "cost"), "total") ?? get(get(topUsage, "cost"), "total");
    const reportedCost =
      typeof costRaw === "number" && Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 0;
    return { cacheCreation1h: c1h, speed: null, reportedCost };
  }
  return { cacheCreation1h: 0, speed: null, reportedCost: 0 };
}

function applyModelUsageMessage(
  state: ModelUsageFoldState,
  tool: IncrementalTool,
  sessionModel: string,
  messageModel: string | null,
  usage: TokenUsage,
  raw: Json,
  sign: 1 | -1,
): { model: string; tier: PriceTier; resolvedUsage: TokenUsage; reportedCost: number } {
  const meta = extractMessageUsageMeta(tool, raw);
  const cacheCreation = usage.cacheCreation;
  const resolvedUsage: TokenUsage = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation,
    cacheCreation1h: Math.min(Math.max(0, meta.cacheCreation1h), Math.max(0, cacheCreation)),
    reasoning: 0,
  };
  const recorded = isRecordedModel(messageModel);
  if (!recorded) {
    state.hasUnrecordedModelMessage = true;
  }
  const model = recorded ? messageModel : sessionModel;
  const tier = requestPriceTier(model, resolvedUsage, meta.speed);
  applyModelUsageResolved(state, model, tier, resolvedUsage, meta.reportedCost, sign);
  return { model, tier, resolvedUsage, reportedCost: meta.reportedCost };
}

function applyModelUsageResolved(
  state: ModelUsageFoldState,
  model: string,
  tier: PriceTier,
  usage: TokenUsage,
  reportedCost: number,
  sign: 1 | -1,
): void {
  const id = modelUsageKey(model, tier);
  const entry = ownGet(state.groups, id) ?? {
    model,
    tier,
    requests: 0,
    usage: emptyUsage(),
    reportedCost: 0,
  };
  entry.requests += sign;
  entry.usage.input += sign * usage.input;
  entry.usage.output += sign * usage.output;
  entry.usage.cacheRead += sign * usage.cacheRead;
  entry.usage.cacheCreation += sign * usage.cacheCreation;
  entry.usage.cacheCreation1h += sign * usage.cacheCreation1h;
  entry.reportedCost += sign * reportedCost;
  if (
    entry.requests <= 0 &&
    entry.usage.input === 0 &&
    entry.usage.output === 0 &&
    entry.usage.cacheRead === 0 &&
    entry.usage.cacheCreation === 0
  ) {
    delete state.groups[id];
  } else {
    state.groups[id] = entry;
  }
  state.billed.input += sign * usage.input;
  state.billed.output += sign * usage.output;
  state.billed.cacheRead += sign * usage.cacheRead;
  state.billed.cacheCreation += sign * usage.cacheCreation;
  state.billed.cacheCreation1h += sign * usage.cacheCreation1h;
  state.totalBilledMessages += sign;
  if (reportedCost > 0) {
    if (sign > 0) state.sawReported = true;
    if (!isPriceableModel(model)) {
      state.unpricedReportedTotal += sign * reportedCost;
    }
  }
}

function computeModelUsageRows(
  state: ModelUsageFoldState,
  sessionModel: string,
  totals: TokenUsage,
): ModelUsageRow[] {
  const residual: TokenUsage = {
    input: totals.input - state.billed.input,
    output: totals.output - state.billed.output,
    cacheRead: totals.cacheRead - state.billed.cacheRead,
    cacheCreation: totals.cacheCreation - state.billed.cacheCreation,
    cacheCreation1h: totals.cacheCreation1h - state.billed.cacheCreation1h,
    reasoning: 0,
  };
  const nonNegative =
    residual.input >= 0 &&
    residual.output >= 0 &&
    residual.cacheRead >= 0 &&
    residual.cacheCreation >= 0 &&
    residual.cacheCreation1h >= 0;
  const groupKeys = Object.keys(state.groups);
  const single =
    groupKeys.length === 0 ||
    (groupKeys.length === 1 && groupKeys[0] === modelUsageKey(sessionModel, "standard"));
  if (single || !nonNegative) {
    const reported = isPriceableModel(sessionModel)
      ? null
      : state.unpricedReportedTotal > 0
        ? state.unpricedReportedTotal
        : null;
    return [
      {
        model: sessionModel,
        tier: "standard",
        requests: state.totalBilledMessages,
        usage: { ...totals, reasoning: 0 },
        reportedCostUsd: reported,
      },
    ];
  }
  const rows = new Map<string, ModelUsageRow>();
  for (const [k, entry] of Object.entries(state.groups)) {
    rows.set(k, {
      model: entry.model,
      tier: entry.tier,
      requests: entry.requests,
      usage: { ...entry.usage },
      reportedCostUsd: isPriceableModel(entry.model)
        ? null
        : entry.reportedCost > 0
          ? entry.reportedCost
          : null,
    });
  }
  const zeroResidual =
    residual.input === 0 &&
    residual.output === 0 &&
    residual.cacheRead === 0 &&
    residual.cacheCreation === 0 &&
    residual.cacheCreation1h === 0;
  if (!zeroResidual) {
    const k = modelUsageKey(sessionModel, "standard");
    const existing = rows.get(k);
    if (existing != null) {
      existing.usage.input += residual.input;
      existing.usage.output += residual.output;
      existing.usage.cacheRead += residual.cacheRead;
      existing.usage.cacheCreation += residual.cacheCreation;
      existing.usage.cacheCreation1h += residual.cacheCreation1h;
    } else {
      rows.set(k, {
        model: sessionModel,
        tier: "standard",
        requests: 0,
        usage: residual,
        reportedCostUsd: null,
      });
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareCodePoints(left.model, right.model) || compareCodePoints(left.tier, right.tier),
  );
}

function rebuildModelUsageFoldFromDb(
  db: Database,
  sessionId: number,
  tool: IncrementalTool,
  sessionModel: string,
): ModelUsageFoldState {
  const rebuilt = createEmptyModelUsage();
  const rows = queryRows<{
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    meta_json: string | null;
  }>(
    db,
    `SELECT m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
            ${MESSAGE_METADATA_SQL} AS meta_json
       FROM message m
      WHERE m.session_id = ?1
        AND (m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL
             OR m.cache_read_tokens IS NOT NULL OR m.cache_creation_tokens IS NOT NULL)
      ORDER BY m.seq`,
    [sessionId],
  );
  for (const row of rows) {
    let raw: Json = null;
    if (row.meta_json != null && row.meta_json !== "") {
      try {
        raw = JSON.parse(row.meta_json) as Json;
      } catch {
        raw = null;
      }
    }
    const usage: TokenUsage = {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read_tokens ?? 0,
      cacheCreation: row.cache_creation_tokens ?? 0,
      cacheCreation1h: 0,
      reasoning: 0,
    };
    applyModelUsageMessage(rebuilt, tool, sessionModel, row.model, usage, raw, 1);
  }
  return rebuilt;
}

function rebuildContextWindowFoldFromDb(
  db: Database,
  sessionId: number,
  tool: IncrementalTool,
  isSubagent: boolean,
): ContextWindowFoldState {
  const cw = createEmptyContextWindow();
  const rows = queryRows<{
    role: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    meta_json: string | null;
    has_real_user_text: number;
  }>(
    db,
    `SELECT m.role, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
            ${MESSAGE_METADATA_SQL} AS meta_json,
            CASE WHEN m.role = 'user' THEN ${CONTEXT_WINDOW_USER_TEXT_PREDICATE_SQL} ELSE 0 END AS has_real_user_text
       FROM message m
      WHERE m.session_id = ?1 AND m.role IN ('user', 'assistant', 'system')
      ORDER BY m.seq`,
    [sessionId],
  );
  for (const row of rows) {
    let raw: Json = null;
    if (row.meta_json != null && row.meta_json !== "") {
      try {
        raw = JSON.parse(row.meta_json) as Json;
      } catch {
        raw = null;
      }
    }
    const meta = messageRawMetaForContext(raw, tool);
    if (meta.isSidechain && !isSubagent) {
      continue;
    }
    if (row.role === "user") {
      if (row.has_real_user_text === 1 && !meta.isCompactSummary) {
        cw.turn += 1;
      }
      continue;
    }
    if (row.role === "system") {
      if (isCompactBoundary(meta)) {
        const pre = meta.compactPreTokens ?? cw.lastContextSinceCompaction;
        if (pre != null) {
          cw.peakTokens = Math.max(cw.peakTokens, pre);
        }
        cw.compactionCount += 1;
        cw.lastContextSinceCompaction = null;
      }
      continue;
    }
    const ctx = contextTokensFromUsage({
      input_tokens: row.input_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
    });
    if (ctx == null) {
      continue;
    }
    cw.pointCount += 1;
    cw.peakTokens = Math.max(cw.peakTokens, ctx);
    cw.lastContextSinceCompaction = ctx;
  }
  return cw;
}

function messageRawMetaForContext(raw: Json, tool: IncrementalTool): MessageRawMeta {
  const preTokens =
    tool === "pi" ? get(raw, "tokensBefore") : get(get(raw, "compactMetadata"), "preTokens");
  return {
    isSidechain: asBoolean(get(raw, "isSidechain")) === true,
    subtype: asString(get(raw, "subtype")),
    rawType: asString(get(raw, "type")),
    isCompactSummary: asBoolean(get(raw, "isCompactSummary")) === true,
    compactTrigger: asString(get(get(raw, "compactMetadata"), "trigger")),
    compactPreTokens:
      typeof preTokens === "number" && Number.isFinite(preTokens) && preTokens >= 0
        ? preTokens
        : null,
  };
}

function messageHasRealTextForContext(message: NormalizedMessage): boolean {
  for (const blk of message.blocks) {
    if (blk.blockType !== "text") continue;
    if (isContextWindowRealUserText(blk.text)) {
      return true;
    }
  }
  return false;
}

function foldContextWindowMessage(
  cw: ContextWindowFoldState,
  tool: IncrementalTool,
  isSubagent: boolean,
  message: NormalizedMessage,
): void {
  if (message.role !== "assistant" && message.role !== "system" && message.role !== "user") {
    return;
  }
  const meta = messageRawMetaForContext(message.raw, tool);
  if (meta.isSidechain && !isSubagent) {
    return;
  }
  if (message.role === "user") {
    if (messageHasRealTextForContext(message) && !meta.isCompactSummary) {
      cw.turn += 1;
    }
    return;
  }
  if (message.role === "system") {
    if (isCompactBoundary(meta)) {
      const pre = meta.compactPreTokens ?? cw.lastContextSinceCompaction;
      if (pre != null) {
        cw.peakTokens = Math.max(cw.peakTokens, pre);
      }
      cw.compactionCount += 1;
      cw.lastContextSinceCompaction = null;
    }
    return;
  }
  if (message.usage == null) {
    return;
  }
  const ctx = contextTokensFromUsage({
    input_tokens: message.usage.input,
    cache_read_tokens: message.usage.cacheRead,
    cache_creation_tokens: message.usage.cacheCreation,
  });
  if (ctx == null) {
    return;
  }
  cw.pointCount += 1;
  cw.peakTokens = Math.max(cw.peakTokens, ctx);
  cw.lastContextSinceCompaction = ctx;
}

function computeContextWindowColumns(
  cw: ContextWindowFoldState,
  tool: IncrementalTool,
  model: string | null,
  rawMeta: Json,
): {
  windowTokens: number | null;
  peakTokens: number;
  compactionCount: number;
  turnCount: number;
} {
  const explicitRaw = get(rawMeta, "model_context_window");
  const explicitWindow = typeof explicitRaw === "number" && explicitRaw > 0 ? explicitRaw : null;
  const inferred =
    cw.peakTokens <= 0
      ? null
      : tool === "claude_code"
        ? inferClaudeContextWindowTokens(model, cw.peakTokens)
        : null;
  return {
    windowTokens: explicitWindow ?? inferred,
    peakTokens: cw.peakTokens,
    compactionCount: cw.compactionCount,
    turnCount: Math.max(cw.turn, cw.pointCount > 0 ? 1 : 0),
  };
}

interface EconBlockInput {
  messageId: number;
  seq: number;
  role: string;
  outputTokens: number | null;
  responseId: string | null;
  type: string;
  toolName: string | null;
  toolInput: string | null;
  textBytes: number;
  timestamp: string | null;
  otherKind: string | null;
}

function econOtherKind(blk: NormalizedBlock): { otherKind: string | null; textBytes: number } {
  if (blk.blockType === "tool_result") {
    return { otherKind: null, textBytes: byteLength(blk.toolResult ?? "") };
  }
  const text = blk.text ?? "";
  if (blk.blockType === "other" && text !== "") {
    try {
      const parsed = JSON.parse(text) as Json;
      const kind = asString(get(parsed, "type"));
      if (kind === "agent_message") {
        const content = get(parsed, "content");
        let sum = 0;
        if (Array.isArray(content)) {
          for (const item of content) {
            const t = asString(get(item, "text"));
            if (t != null) sum += byteLength(t);
          }
        }
        return { otherKind: kind, textBytes: sum };
      }
      return { otherKind: kind, textBytes: byteLength(text) };
    } catch {
      return { otherKind: null, textBytes: byteLength(text) };
    }
  }
  return { otherKind: null, textBytes: byteLength(text) };
}

function econBlockActivity(blk: EconBlockInput): ActivityBucket | "waiting" | "skip" {
  if (blk.type === "tool_result" && isUserQuestionTool(blk.toolName, blk.toolInput ?? undefined)) {
    return "waiting";
  }
  if (blk.role === "user" && blk.type !== "tool_result") {
    return "waiting";
  }
  if (blk.role === "other") {
    return MODEL_INPUT_KINDS.has(blk.otherKind ?? "") ? "context" : "skip";
  }
  if (blk.role === "system") {
    return "skip";
  }
  if (blk.type === "other") {
    if (blk.otherKind === "fallback") {
      return "skip";
    }
    if (blk.role === "tool") {
      return "context";
    }
  }
  return blockBucket(blk.type, blk.toolName, blk.toolInput);
}

function econBlockSize(blk: EconBlockInput): number {
  if (blk.type === "tool_use") {
    return byteLength(`${blk.toolName ?? ""}\n${blk.toolInput ?? ""}`);
  }
  return blk.textBytes;
}

function econEpochMillis(timestamp: string | null): number | null {
  if (timestamp == null || !timestamp.endsWith("Z")) return null;
  const withoutZone = timestamp.slice(0, -1);
  const [date, time] = withoutZone.split("T");
  if (date == null || time == null) return null;
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const [clock, fraction] = time.split(".");
  const [hour, minute, second] = (clock ?? "").split(":").map((part) => Number.parseInt(part, 10));
  if (
    [year, month, day, hour, minute, second].some((part) => part == null || !Number.isFinite(part))
  ) {
    return null;
  }
  const millis = fraction == null ? 0 : Math.round(Number.parseFloat(`0.${fraction}`) * 1000);
  return Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
    millis,
  );
}

function econPhase(firstEditSeq: number | null, seq: number | null | undefined): Phase {
  if (seq == null) return "implementation";
  const boundary = firstEditSeq ?? Number.POSITIVE_INFINITY;
  return seq < boundary ? "orientation" : "implementation";
}

function econResponseKey(blk: EconBlockInput): string {
  return blk.responseId == null ? `#${blk.messageId}` : `id:${blk.responseId}`;
}

function addEconGen(
  buckets: Record<ActivityBucket, EconomicsBucketState>,
  bucket: ActivityBucket,
  tokens: number,
  phase: Phase,
): void {
  if (tokens <= 0) return;
  const entry = buckets[bucket];
  entry.generation += tokens;
  if (phase === "orientation") {
    entry.genOrientation += tokens;
  }
  entry.touched = true;
}

function foldEconomicsDelta(
  econ: EconomicsFoldState,
  tool: IncrementalTool,
  startedAt: string | null,
  newBlocks: readonly EconBlockInput[],
  newToolCalls: readonly {
    toolName: string;
    input: string | null;
    outputBytes: number;
    callSeq: number;
  }[],
  matchedResults: readonly {
    toolName: string;
    input: string | null;
    outputBytes: number;
    callSeq: number;
  }[],
): boolean {
  if (!econ.valid) {
    return false;
  }
  const active = newBlocks.filter((blk) => econBlockActivity(blk) !== "skip");
  let newFirstEdit = econ.firstEditSeq;
  for (const blk of active) {
    if (blk.type === "tool_use" && isCodeEditTool(blk.toolName, blk.toolInput)) {
      if (newFirstEdit == null || blk.seq < newFirstEdit) {
        newFirstEdit = blk.seq;
      }
    }
  }
  econ.firstEditSeq = newFirstEdit;

  const byMsg = new Map<
    number,
    { seq: number; timestamp: string | null; blocks: EconBlockInput[] }
  >();
  const msgOrder: number[] = [];
  for (const blk of active) {
    let entry = byMsg.get(blk.messageId);
    if (entry == null) {
      entry = { seq: blk.seq, timestamp: blk.timestamp, blocks: [] };
      byMsg.set(blk.messageId, entry);
      msgOrder.push(blk.messageId);
    }
    entry.blocks.push(blk);
  }

  if (tool === "codex" && econ.codexWeights != null) {
    for (const blk of active) {
      if (blk.role === "assistant" && blk.type !== "thinking") {
        if (econ.codexWeights.blocks.length >= MAX_CODEX_ECON_BLOCKS) {
          econ.codexWeights.blocks = [];
          return false;
        }
        const w = Math.max(1, econBlockSize(blk));
        const b = blockBucket(blk.type, blk.toolName, blk.toolInput);
        const bIdx = ACTIVITY_BUCKETS.indexOf(b);
        const phase = econPhase(econ.firstEditSeq, blk.seq);
        const isOrient: 0 | 1 = phase === "orientation" ? 1 : 0;
        econ.codexWeights.total += w;
        econ.codexWeights.hasAssistantBlocks = true;
        if (isOrient === 1) {
          econ.codexWeights.orientationTotal += w;
        }
        econ.codexWeights.blocks.push([bIdx, isOrient, w]);
      }
    }
  } else {
    const isEmptyInitial =
      econ.seenResponseKeys == null ||
      ("exact" in econ.seenResponseKeys && econ.seenResponseKeys.exact.length === 0);
    const seenResponses = isEmptyInitial ? null : openCompactSet(econ.seenResponseKeys);
    const deltaRespKeys = new Set<string>();
    const byResp = new Map<string, EconBlockInput[]>();
    const respOutput = new Map<string, number>();
    for (const blk of active) {
      const rk = econResponseKey(blk);
      if (blk.responseId != null) {
        if (seenResponses != null && compactSetHas(seenResponses, rk)) {
          return false;
        }
        deltaRespKeys.add(rk);
      }
      const list = byResp.get(rk) ?? [];
      list.push(blk);
      byResp.set(rk, list);
      if (blk.outputTokens != null && blk.outputTokens > 0) {
        respOutput.set(rk, Math.max(respOutput.get(rk) ?? 0, blk.outputTokens));
      }
    }
    if (respOutput.size > 0) {
      if (!econ.sawMessageOutput && econ.previousLatencyMs != null) {
        return false;
      }
      econ.sawMessageOutput = true;
      for (const [rk, outputTokens] of respOutput) {
        const rows = byResp.get(rk) ?? [];
        const phase = econPhase(econ.firstEditSeq, rows[0]?.seq);
        const visibleBlocks = rows.filter((r) => r.type !== "thinking");
        const hasThinking = rows.length > visibleBlocks.length;
        const visible = visibleBlocks.reduce((sum, r) => sum + econBlockSize(r), 0);
        const planning = hasThinking ? Math.max(0, outputTokens - visible / CHARS_PER_TOKEN) : 0;
        addEconGen(econ.buckets, "planning", planning, phase);
        const rest = Math.max(0, outputTokens - planning);
        if (rest > 0 && visibleBlocks.length > 0) {
          const weighted = visibleBlocks.map((r) => ({ r, w: Math.max(1, econBlockSize(r)) }));
          const totalW = weighted.reduce((sum, item) => sum + item.w, 0);
          for (const item of weighted) {
            addEconGen(
              econ.buckets,
              blockBucket(item.r.type, item.r.toolName, item.r.toolInput),
              rest * (item.w / totalW),
              phase,
            );
          }
        }
      }
    } else if (!econ.sawMessageOutput && active.length > 0) {
      return false;
    }
    if (seenResponses == null) {
      if (deltaRespKeys.size > 0) {
        const expected =
          deltaRespKeys.size > COMPACT_SET_EXACT_LIMIT
            ? Math.max(deltaRespKeys.size, 2_048)
            : deltaRespKeys.size;
        econ.seenResponseKeys = buildCompactSet(deltaRespKeys, expected);
      }
    } else if (deltaRespKeys.size > 0) {
      if (
        seenResponses.exact != null &&
        seenResponses.exact.size + deltaRespKeys.size > COMPACT_SET_EXACT_LIMIT
      ) {
        for (const rk of deltaRespKeys) {
          seenResponses.exact.add(rk);
        }
        econ.seenResponseKeys = buildCompactSet(
          seenResponses.exact,
          Math.max(seenResponses.exact.size, 2_048),
        );
      } else {
        for (const rk of deltaRespKeys) {
          compactSetAdd(seenResponses, rk);
        }
        econ.seenResponseKeys = sealCompactSet(seenResponses);
      }
    }
  }

  for (const id of msgOrder) {
    const msg = byMsg.get(id);
    if (msg == null) continue;
    const at = econEpochMillis(msg.timestamp);
    if (at == null || copiedBeforeStart(tool, startedAt, msg.timestamp)) {
      continue;
    }
    if (econ.previousLatencyMs != null) {
      const gap = Math.min(Math.max(0, at - econ.previousLatencyMs), ACTIVE_GAP_CAP_MS);
      if (gap > 0 && msg.blocks.length > 0) {
        const phase = econPhase(econ.firstEditSeq, msg.seq);
        const weighted = msg.blocks.map((blk) => ({ blk, w: Math.max(1, econBlockSize(blk)) }));
        const totalW = weighted.reduce((sum, item) => sum + item.w, 0);
        for (const item of weighted) {
          const shareMs = gap * (item.w / totalW);
          const activity = econBlockActivity(item.blk);
          if (activity === "waiting") {
            econ.waitingOnUserMs += shareMs;
          } else if (activity !== "skip" && shareMs > 0) {
            const entry = econ.buckets[activity];
            entry.activeMs += shareMs;
            if (phase === "orientation") {
              entry.activeMsOrientation += shareMs;
            }
          }
        }
      }
    }
    econ.previousLatencyMs =
      econ.previousLatencyMs == null ? at : Math.max(econ.previousLatencyMs, at);
  }

  for (const blk of active) {
    if (blk.role === "other" && blk.otherKind === "agent_message") {
      const tokens = blk.textBytes / CHARS_PER_TOKEN;
      const entry = econ.buckets.context;
      entry.contextWindow += tokens;
      entry.touched = true;
      if (econPhase(econ.firstEditSeq, blk.seq) === "orientation") {
        entry.windowOrientation += tokens;
      }
    }
  }

  for (const tc of newToolCalls) {
    const bucket = toolBucket(tc.toolName, tc.input);
    const entry = econ.buckets[bucket];
    const tokens = tc.outputBytes / CHARS_PER_TOKEN;
    entry.contextWindow += tokens;
    entry.toolCalls += 1;
    entry.touched = true;
    if (econPhase(econ.firstEditSeq, tc.callSeq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }
  for (const res of matchedResults) {
    const bucket = toolBucket(res.toolName, res.input);
    const entry = econ.buckets[bucket];
    const tokens = res.outputBytes / CHARS_PER_TOKEN;
    entry.contextWindow += tokens;
    if (econPhase(econ.firstEditSeq, res.callSeq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }

  return true;
}

function buildEconomicsVector(
  econ: EconomicsFoldState,
  sessionId: number,
  session: NormalizedSession,
  modelUsageRows: readonly ModelUsageRow[],
): SessionEconomicsVector {
  const parts = sessionCostParts([...modelUsageRows], {
    model: session.model,
    usage: session.totals,
  });
  const buckets = {} as SessionEconomicsVector["buckets"];
  if (session.tool === "codex" && econ.codexWeights != null) {
    const cw = econ.codexWeights;
    const totalOut = session.totals.output;
    const planning = Math.min(totalOut, session.totals.reasoning || session.estReasoningTokens);
    const totalW = cw.total || 1;
    const planOrient = planning * (cw.orientationTotal / totalW);
    const planImpl = planning * (1 - cw.orientationTotal / totalW);
    const rest = Math.max(0, totalOut - planning);
    const genTotalByBucket = {} as Record<ActivityBucket, number>;
    const genOrientByBucket = {} as Record<ActivityBucket, number>;
    const genTouchedByBucket = {} as Record<ActivityBucket, boolean>;
    for (const bucket of ACTIVITY_BUCKETS) {
      genTotalByBucket[bucket] = 0;
      genOrientByBucket[bucket] = 0;
      genTouchedByBucket[bucket] = false;
    }
    if (planOrient > 0) {
      genTotalByBucket.planning += planOrient;
      genOrientByBucket.planning += planOrient;
      genTouchedByBucket.planning = true;
    }
    if (planImpl > 0) {
      genTotalByBucket.planning += planImpl;
      genTouchedByBucket.planning = true;
    }
    if (rest > 0) {
      if (!cw.hasAssistantBlocks) {
        const phase = econ.firstEditSeq != null ? "implementation" : "orientation";
        genTotalByBucket.communicating += rest;
        if (phase === "orientation") genOrientByBucket.communicating += rest;
        genTouchedByBucket.communicating = true;
      } else {
        for (const [bIdx, isOrient, w] of cw.blocks) {
          const bucket = ACTIVITY_BUCKETS[bIdx];
          if (bucket == null) continue;
          const share = rest * (w / totalW);
          if (share <= 0) continue;
          genTotalByBucket[bucket] += share;
          if (isOrient === 1) genOrientByBucket[bucket] += share;
          genTouchedByBucket[bucket] = true;
        }
      }
    }
    for (const bucket of ACTIVITY_BUCKETS) {
      const b = econ.buckets[bucket];
      buckets[bucket] = {
        generation: genTotalByBucket[bucket],
        context_window: b.contextWindow,
        tool_calls: b.toolCalls,
        touched: b.touched || genTouchedByBucket[bucket] || b.activeMs > 0,
        generation_orientation: genOrientByBucket[bucket],
        context_window_orientation: b.windowOrientation,
        active_ms: b.activeMs,
        active_ms_orientation: b.activeMsOrientation,
      };
    }
  } else {
    for (const bucket of ACTIVITY_BUCKETS) {
      const b = econ.buckets[bucket];
      buckets[bucket] = {
        generation: b.generation,
        context_window: b.contextWindow,
        tool_calls: b.toolCalls,
        touched: b.touched || b.activeMs > 0,
        generation_orientation: b.genOrientation,
        context_window_orientation: b.windowOrientation,
        active_ms: b.activeMs,
        active_ms_orientation: b.activeMsOrientation,
      };
    }
  }
  return {
    id: sessionId,
    started_at: session.startedAt,
    input_cost: parts.input + parts.cacheRead + parts.cacheCreation,
    output_cost: parts.output,
    reported_cost: parts.reported,
    billed_input_tokens:
      session.totals.input + session.totals.cacheRead + session.totals.cacheCreation,
    waiting_on_user_ms: econ.waitingOnUserMs,
    buckets,
  };
}

function saveCheckpoint(
  db: Database,
  path: string,
  parsedOffset: number,
  parsedLineCount: number,
  prefixHash: string,
  state: IncrementalCheckpointState,
): void {
  const compressed = zstdCompressSync(JSON.stringify(state), { level: 3 });
  const stmt = db.prepare(
    `INSERT INTO ingest_checkpoint(path, parsed_offset, parsed_line_count, prefix_hash, state_blob)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(path) DO UPDATE SET
       parsed_offset = excluded.parsed_offset,
       parsed_line_count = excluded.parsed_line_count,
       prefix_hash = excluded.prefix_hash,
       state_blob = excluded.state_blob`,
  );
  try {
    stmt.run(path, parsedOffset, parsedLineCount, prefixHash, compressed);
  } finally {
    stmt.finalize();
  }
}

function hydrateCheckpointDictionaries(state: IncrementalCheckpointState): void {
  state.unmatchedCalls = nullRecord(state.unmatchedCalls);
  state.modelUsage.groups = nullRecord(state.modelUsage.groups);
  if (state.claudeBilledRuntime != null) {
    state.claudeBilledRuntime = nullRecord(state.claudeBilledRuntime);
  }
  if (state.piToolUses != null) {
    state.piToolUses = nullRecord(state.piToolUses);
  }
  state.parser.unknownTypes = nullRecord(state.parser.unknownTypes);
  if (state.tool === "claude_code") {
    const p = state.parser as ClaudeStepperState;
    p.modelCounts = nullRecord(p.modelCounts);
    p.billed = nullRecord(p.billed);
    p.turns = nullRecord(p.turns);
  } else if (state.tool === "pi") {
    const p = state.parser as PiStepperState;
    p.outputByModel = nullRecord(p.outputByModel);
  }
}

function compactPiToolUses(
  anchors: Record<string, PiToolUseAnchor> | undefined,
  maxRecent: number,
): void {
  if (anchors == null) {
    return;
  }
  const keys = Object.keys(anchors);
  if (keys.length <= maxRecent) {
    return;
  }
  const evict = keys.length - maxRecent;
  for (let i = 0; i < evict; i += 1) {
    const key = keys[i];
    if (key != null) {
      delete anchors[key];
    }
  }
}

function lookupPiToolUseAnchor(
  db: Database,
  sessionId: number,
  anchors: Record<string, PiToolUseAnchor> | undefined,
  toolCallId: string,
): PiToolUseAnchor | null {
  const cached = ownGet(anchors, toolCallId);
  if (cached != null) {
    return cached;
  }
  const row = queryRow<{
    call_block_id: number;
    message_id: number;
    ordinal: number;
    timestamp: string | null;
    call_count: number;
  }>(
    db,
    `SELECT b.id AS call_block_id, b.message_id, b.ordinal, m.timestamp,
            (SELECT COUNT(*) FROM tool_call tc WHERE tc.call_block_id = b.id) AS call_count
       FROM block b
       JOIN message m ON m.id = b.message_id
      WHERE b.session_id = ?1 AND b.tool_use_id = ?2 AND b.type = 'tool_use'
      ORDER BY m.seq DESC, b.ordinal DESC
      LIMIT 1`,
    [sessionId, toolCallId],
  );
  if (row == null) {
    return null;
  }
  return {
    messageId: row.message_id,
    callBlockId: row.call_block_id,
    ordinal: row.ordinal,
    timestamp: row.timestamp,
    hasInner: row.call_count > 1,
  };
}

function loadCheckpoint(
  db: Database,
  path: string,
): {
  parsedOffset: number;
  parsedLineCount: number;
  prefixHash: string;
  state: IncrementalCheckpointState;
} | null {
  const row = queryRow<{
    parsed_offset: number;
    parsed_line_count: number;
    prefix_hash: string;
    state_blob: Uint8Array;
  }>(
    db,
    "SELECT parsed_offset, parsed_line_count, prefix_hash, state_blob FROM ingest_checkpoint WHERE path = ?1",
    [path],
  );
  if (row == null) {
    return null;
  }
  try {
    const json = zstdDecompressSync(row.state_blob).toString("utf8");
    const state = JSON.parse(json) as IncrementalCheckpointState;
    if (state.version !== CHECKPOINT_VERSION) {
      return null;
    }
    hydrateCheckpointDictionaries(state);
    return {
      parsedOffset: row.parsed_offset,
      parsedLineCount: row.parsed_line_count,
      prefixHash: row.prefix_hash,
      state,
    };
  } catch {
    return null;
  }
}

export function deleteCheckpoint(db: Database, path: string): void {
  runStatement(db, "DELETE FROM ingest_checkpoint WHERE path = ?1", [path]);
}

function externalKeyFor(
  tool: IncrementalTool,
  sidecarMeta: Json | null,
  codexTitle: string | null,
): string {
  if (tool === "claude_code") {
    return sidecarMeta == null ? "" : canonicalJson(sidecarMeta);
  }
  if (tool === "codex") {
    return codexTitle ?? "";
  }
  return "";
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (start == null || end == null) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function claudeApiMessageId(raw: Json): string | null {
  return asString(get(get(raw, "message"), "id"));
}

function claudeRequestId(raw: Json): string | null {
  return (
    asString(get(raw, "requestId")) ?? asString(get(raw, "request_id")) ?? claudeApiMessageId(raw)
  );
}

export interface FullParseWithCheckpointInput {
  tool: IncrementalTool;
  sourcePath: string;
  stem: string;
  rawBuffer: Buffer;
  archived: boolean;
  sidecarMeta: Json | null;
  codexTitles: ReadonlyMap<string, string>;
}

export interface FullParseWithCheckpointResult {
  parsed: ParsedSession;
  scanned: ScannedLines;
  stepper: ClaudeStepperState | CodexStepperState | PiStepperState;
  prefixHash: string;
  externalKey: string;
}

export function parseFullForCheckpoint(
  input: FullParseWithCheckpointInput,
): FullParseWithCheckpointResult {
  const scanned = scanLinesFromBuffer(input.rawBuffer, 0, 1);
  const issues: Issue[] = [];
  const messages: NormalizedMessage[] = [];
  let stepper: ClaudeStepperState | CodexStepperState | PiStepperState;
  let session: NormalizedSession;

  if (input.tool === "claude_code") {
    const st = createClaudeStepper(input.stem, {
      sourcePath: input.sourcePath,
      sidecarMeta: input.sidecarMeta ?? undefined,
    });
    for (const { line, lineNo } of scanned.lines) {
      const step = stepClaudeLine(st, line, lineNo, issues);
      if (step.unbilledPrevious != null) {
        const prev = messages[step.unbilledPrevious.seq];
        if (prev != null) {
          messages[step.unbilledPrevious.seq] = { ...prev, usage: null };
        }
      }
      if (step.message != null) {
        messages.push(step.message);
      }
    }
    if (scanned.tornIssue != null) issues.push(scanned.tornIssue);
    issues.push(...claudeUnknownTypeIssues(st));
    session = claudeSessionFromState(st, messages, input.archived);
    stepper = st;
  } else if (input.tool === "codex") {
    const st = createCodexStepper(input.stem);
    for (const { line, lineNo } of scanned.lines) {
      const step = stepCodexLine(st, line, lineNo, issues);
      if (step.stampedAssistant != null) {
        const prev = messages[step.stampedAssistant.seq];
        if (prev != null) {
          messages[step.stampedAssistant.seq] = { ...prev, usage: step.stampedAssistant.usage };
        }
      }
      for (const msg of step.messages) {
        messages.push(msg);
      }
    }
    if (scanned.tornIssue != null) issues.push(scanned.tornIssue);
    issues.push(...codexUnknownTypeIssues(st));
    session = codexSessionFromState(st, input.codexTitles, messages, input.archived);
    stepper = st;
  } else {
    const st = createPiStepper(input.stem);
    const toolUses = new Map<string, NormalizedBlock>();
    for (const { line, lineNo } of scanned.lines) {
      const step = stepPiLine(st, line, lineNo, issues);
      if (step.nestedCalls != null) {
        const wrapper = toolUses.get(step.nestedCalls.toolCallId);
        if (wrapper != null) {
          wrapper.innerToolCalls = step.nestedCalls.inner;
        }
      }
      if (step.message != null) {
        for (const blk of step.message.blocks) {
          if (blk.blockType === "tool_use" && blk.toolUseId != null) {
            toolUses.set(blk.toolUseId, blk);
          }
        }
        messages.push(step.message);
      }
    }
    if (scanned.tornIssue != null) issues.push(scanned.tornIssue);
    issues.push(...piUnknownTypeIssues(st));
    session = piSessionFromState(st, messages, input.archived);
    stepper = st;
  }

  const seenUse = new Set<string>();
  const answered = new Set<string>();
  for (const msg of session.messages) {
    for (const blk of msg.blocks) {
      if (blk.blockType === "tool_use" && blk.toolUseId != null) {
        if (seenUse.has(blk.toolUseId)) {
          issues.push({
            code: "duplicate_tool_use_id",
            lineNo: null,
            error: `tool_use id "${blk.toolUseId}" appears more than once (${blk.toolName ?? "unknown tool"})`,
            rawLine: null,
          });
        }
        seenUse.add(blk.toolUseId);
      }
    }
  }
  for (const msg of session.messages) {
    for (const blk of msg.blocks) {
      if (blk.blockType === "tool_result" && blk.toolUseId != null) {
        if (!seenUse.has(blk.toolUseId)) {
          issues.push({
            code: "orphan_tool_result",
            lineNo: null,
            error: `tool_result references tool_use id "${blk.toolUseId}" absent from the session`,
            rawLine: null,
          });
        }
        if (answered.has(blk.toolUseId)) {
          issues.push({
            code: "duplicate_tool_result",
            lineNo: null,
            error: `tool_use id "${blk.toolUseId}" received more than one result`,
            rawLine: null,
          });
        }
        answered.add(blk.toolUseId);
      }
    }
  }

  const prefixHash = computePrefixHashFromBuffer(input.rawBuffer, scanned.parsedOffset);
  const externalKey = externalKeyFor(
    input.tool,
    input.sidecarMeta,
    input.tool === "codex" ? (input.codexTitles.get(session.sourceSessionId) ?? null) : null,
  );
  return {
    parsed: { session, issues },
    scanned,
    stepper,
    prefixHash,
    externalKey,
  };
}

export interface FullWriteArtifact {
  sessionId: number;
  messageIds: number[];
  insertedCalls: {
    toolCallId: number;
    messageId: number;
    callBlockId: number;
    callSeq: number;
    ordinal: number;
    toolName: string;
    toolUseId: string | null;
    input: string | null;
    timestamp: string | null;
    matched: boolean;
    outputBytes: number;
    hasInner: boolean;
    isInner?: boolean;
  }[];
  blockIdsByMsgAndOrd: Map<string, number>;
  resultBlockCallInfo: Map<number, { toolName: string; input: string | null }>;
}

export function buildAndPersistCheckpointAfterFullWrite(
  db: Database,
  sourcePath: string,
  full: FullParseWithCheckpointResult,
  artifact: FullWriteArtifact,
): void {
  const s = full.parsed.session;
  const tool = s.tool as IncrementalTool;
  const enrich = createEmptyEnrich();
  const modelUsage = createEmptyModelUsage();
  const contextWindow = createEmptyContextWindow();
  const economics = createEmptyEconomics(tool);
  const claudeBilledRuntime: Record<string, ClaudeBilledRuntime> | undefined =
    tool === "claude_code" ? nullRecord<ClaudeBilledRuntime>() : undefined;
  const piToolUses: Record<string, PiToolUseAnchor> | undefined =
    tool === "pi" ? nullRecord<PiToolUseAnchor>() : undefined;

  const sessionModel = s.model ?? "";
  const seenToolUseIds = new Set<string>();
  const answeredToolUseIds = new Set<string>();
  const orphanToolResultIds = new Set<string>();
  let hasLinkageIssues = false;

  const econBlocks: EconBlockInput[] = [];
  let replyCount = 0;
  let toolCallCount = 0;
  for (let i = 0; i < s.messages.length; i += 1) {
    const msg = s.messages[i];
    const msgId = artifact.messageIds[i];
    if (msg == null || msgId == null) continue;
    if (isRenderableReply(msg)) replyCount += 1;
    toolCallCount += countToolUseBlocks(msg);
    const refs = fileRefsForMessage(tool, i, msg, s.cwd);
    foldEnrichMessage(enrich, tool, s.isSubagent, s.startedAt, msg, refs.length, refs);
    foldContextWindowMessage(contextWindow, tool, s.isSubagent, msg);

    if (msg.usage != null) {
      const applied = applyModelUsageMessage(
        modelUsage,
        tool,
        sessionModel,
        msg.model,
        msg.usage,
        msg.raw,
        1,
      );
      if (tool === "claude_code" && claudeBilledRuntime != null) {
        const reqId = claudeRequestId(msg.raw);
        if (reqId != null) {
          claudeBilledRuntime[reqId] = {
            messageId: msgId,
            model: applied.model,
            tier: applied.tier,
            usage: applied.resolvedUsage,
            reportedCost: applied.reportedCost,
            apiMessageId: claudeApiMessageId(msg.raw),
          };
        }
      }
    }

    const respId = msg.role === "assistant" ? claudeApiMessageId(msg.raw) : null;
    for (const blk of msg.blocks) {
      const blockId = artifact.blockIdsByMsgAndOrd.get(`${msgId}:${blk.ordinal}`);
      const toolInputStr = blk.toolInput === undefined ? null : canonicalJson(blk.toolInput);
      const { otherKind, textBytes } = econOtherKind(blk);
      const matchedCall = blockId == null ? undefined : artifact.resultBlockCallInfo.get(blockId);
      econBlocks.push({
        messageId: msgId,
        seq: msg.seq,
        role: msg.role,
        outputTokens: msg.usage?.output ?? null,
        responseId: respId,
        type: blk.blockType,
        toolName: blk.toolName ?? matchedCall?.toolName ?? null,
        toolInput:
          blk.blockType === "tool_use" ||
          blk.blockType === "tool_result" ||
          blk.blockType === "web_search"
            ? (toolInputStr ?? matchedCall?.input ?? null)
            : null,
        textBytes,
        timestamp: msg.timestamp,
        otherKind,
      });

      if (blk.blockType === "tool_use" && blk.toolUseId != null) {
        if (seenToolUseIds.has(blk.toolUseId)) hasLinkageIssues = true;
        seenToolUseIds.add(blk.toolUseId);
      }
    }
  }
  for (const msg of s.messages) {
    for (const blk of msg.blocks) {
      if (blk.blockType === "tool_result" && blk.toolUseId != null) {
        if (!seenToolUseIds.has(blk.toolUseId)) {
          orphanToolResultIds.add(blk.toolUseId);
          hasLinkageIssues = true;
        }
        if (answeredToolUseIds.has(blk.toolUseId)) {
          hasLinkageIssues = true;
        }
        answeredToolUseIds.add(blk.toolUseId);
      }
    }
  }

  const unmatchedCalls: Record<string, UnmatchedToolCall[]> = nullRecord<UnmatchedToolCall[]>();
  const econToolCalls: {
    toolName: string;
    input: string | null;
    outputBytes: number;
    callSeq: number;
  }[] = [];
  let searchCount = 0;
  for (const tc of artifact.insertedCalls) {
    searchCount += countSearchCandidateToolCall(tc.toolName, tc.input);
    econToolCalls.push({
      toolName: tc.toolName,
      input: tc.input,
      outputBytes: tc.outputBytes,
      callSeq: tc.callSeq,
    });
    if (!tc.isInner && !tc.matched && tc.toolUseId != null) {
      const list = ownGet(unmatchedCalls, tc.toolUseId) ?? [];
      list.push({
        toolCallId: tc.toolCallId,
        callBlockId: tc.callBlockId,
        callSeq: tc.callSeq,
        toolName: tc.toolName,
        input: tc.input,
        timestamp: tc.timestamp,
      });
      unmatchedCalls[tc.toolUseId] = list;
    }
    if (!tc.isInner && tool === "pi" && piToolUses != null && tc.toolUseId != null) {
      piToolUses[tc.toolUseId] = {
        messageId: tc.messageId,
        callBlockId: tc.callBlockId,
        ordinal: tc.ordinal,
        timestamp: tc.timestamp,
        hasInner: tc.hasInner,
      };
    }
  }
  compactPiToolUses(piToolUses, MAX_PI_TOOL_USES_WINDOW);

  const hasUnbilled =
    tool === "claude_code" &&
    queryRow(db, "SELECT 1 FROM unbilled_request WHERE session_id = ?1 LIMIT 1", [
      artifact.sessionId,
    ]) != null;
  if (hasUnbilled) {
    economics.valid = false;
  } else {
    const ok = foldEconomicsDelta(economics, tool, s.startedAt, econBlocks, econToolCalls, []);
    economics.valid = ok;
  }

  let codexLatestAssistantMessageId: number | null | undefined;
  if (tool === "codex") {
    const codexState = full.stepper as CodexStepperState;
    codexLatestAssistantMessageId =
      codexState.latestAssistant == null
        ? null
        : (artifact.messageIds[codexState.latestAssistant.seq] ?? null);
  }

  let claudeEvictedRequests: CompactKeySet | undefined;
  if (tool === "claude_code") {
    const evicted = new Set<string>();
    const claudeSt = full.stepper as ClaudeStepperState;
    compactClaudeStepper(claudeSt, CLAUDE_RECENT_REQUEST_WINDOW, (key) => {
      evicted.add(key);
    });
    if (claudeBilledRuntime != null) {
      for (const reqId of Object.keys(claudeBilledRuntime)) {
        if (ownGet(claudeSt.billed, reqId) == null) {
          delete claudeBilledRuntime[reqId];
        }
      }
    }
    if (evicted.size > 0) {
      claudeEvictedRequests = buildCompactSet(evicted, evicted.size);
    }
  }

  const state: IncrementalCheckpointState = {
    version: CHECKPOINT_VERSION,
    tool,
    sessionId: artifact.sessionId,
    isArchived: s.isArchived,
    needsLeadingNewline: full.scanned.needsLeadingNewline,
    externalKey: full.externalKey,
    parser: full.stepper,
    ...(claudeBilledRuntime != null ? { claudeBilledRuntime } : {}),
    ...(claudeEvictedRequests != null ? { claudeEvictedRequests } : {}),
    ...(codexLatestAssistantMessageId !== undefined ? { codexLatestAssistantMessageId } : {}),
    ...(piToolUses != null ? { piToolUses } : {}),
    enrich,
    replyCount,
    toolCallCount,
    searchCount,
    unmatchedCalls,
    modelUsage,
    contextWindow,
    economics,
    diagnostics: {
      seenToolUse: buildCompactSet(seenToolUseIds, seenToolUseIds.size),
      answeredToolUse: buildCompactSet(answeredToolUseIds, answeredToolUseIds.size),
      orphanToolResultIds: [...orphanToolResultIds],
      hasLinkageIssues,
    },
  };

  saveCheckpoint(
    db,
    sourcePath,
    full.scanned.parsedOffset,
    full.scanned.parsedLineCount,
    full.prefixHash,
    state,
  );
}

export type IncrementalAttemptResult =
  | { kind: "fallback" }
  | { kind: "conflict"; liveChanged?: boolean }
  | { kind: "oversized" }
  | { kind: "skipped" }
  | {
      kind: "ingested";
      sessionId: number;
      affectedSessionIds: number[];
      issues: Issue[];
      lineageDirty: boolean;
      projectCreated: boolean;
    };

function isLiveFileStale(
  sourcePath: string,
  stats: Stats,
  mtimeNs?: bigint,
  ctimeNs?: bigint,
): boolean {
  try {
    if (mtimeNs != null || ctimeNs != null) {
      const live = statSync(sourcePath, { bigint: true });
      const dev = BigInt(stats.dev);
      const ino = BigInt(stats.ino);
      const size = BigInt(stats.size);
      return (
        live.dev !== dev ||
        live.ino !== ino ||
        live.size < size ||
        (live.size === size &&
          ((mtimeNs != null && live.mtimeNs !== mtimeNs) ||
            (ctimeNs != null && live.ctimeNs !== ctimeNs)))
      );
    }
    const live = statSync(sourcePath);
    return (
      live.dev !== stats.dev ||
      live.ino !== stats.ino ||
      live.size < stats.size ||
      (live.size === stats.size &&
        (live.mtimeMs !== stats.mtimeMs || live.ctimeMs !== stats.ctimeMs))
    );
  } catch {
    return true;
  }
}

export interface TryIncrementalInput {
  db: Database;
  fd: number;
  stats: Stats;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
  sourcePath: string;
  tool: IncrementalTool;
  archived: boolean;
  priorSize: number;
  priorMtime: number;
  priorSessionId: number | null;
  ingestRevision: number;
  expectedRevision: number;
  sidecarMeta: Json | null;
  codexTitles: ReadonlyMap<string, string>;
}

export function tryIncrementalIngest(input: TryIncrementalInput): IncrementalAttemptResult {
  const { db, fd, stats, sourcePath, tool } = input;
  if (stats.size > MAX_SOURCE_FILE_BYTES) {
    return { kind: "oversized" };
  }
  if (input.priorSessionId == null || input.ingestRevision !== input.expectedRevision) {
    return { kind: "fallback" };
  }
  const loaded = loadCheckpoint(db, sourcePath);
  if (
    loaded == null ||
    loaded.state.tool !== tool ||
    loaded.state.sessionId !== input.priorSessionId
  ) {
    const srcNow = queryRow<{
      size: number;
      mtime: number;
      ingest_revision: number;
      session_id: number | null;
    }>(db, "SELECT size, mtime, ingest_revision, session_id FROM ingest_source WHERE path = ?1", [
      sourcePath,
    ]);
    if (
      srcNow != null &&
      (srcNow.size !== input.priorSize ||
        srcNow.mtime !== input.priorMtime ||
        srcNow.session_id !== input.priorSessionId ||
        srcNow.ingest_revision !== input.ingestRevision)
    ) {
      return { kind: "conflict" };
    }
    return { kind: "fallback" };
  }
  if (loaded.parsedOffset > input.priorSize) {
    if (isLiveFileStale(sourcePath, stats, input.mtimeNs, input.ctimeNs)) {
      return { kind: "conflict", liveChanged: true };
    }
    const srcNow = queryRow<{
      size: number;
      mtime: number;
      ingest_revision: number;
    }>(db, "SELECT size, mtime, ingest_revision FROM ingest_source WHERE path = ?1", [sourcePath]);
    if (
      srcNow != null &&
      srcNow.size === stats.size &&
      srcNow.mtime === Math.trunc(stats.mtimeMs / 1000) &&
      srcNow.ingest_revision === input.expectedRevision
    ) {
      return { kind: "skipped" };
    }
    return { kind: "conflict" };
  }
  const state = loaded.state;
  if (state.isArchived !== input.archived) {
    return { kind: "fallback" };
  }
  const sessionExists = queryRow<{
    id: number;
    project_id: number | null;
    source_session_id: string;
  }>(db, "SELECT id, project_id, source_session_id FROM session WHERE id = ?1 AND tool = ?2", [
    state.sessionId,
    tool,
  ]);
  if (sessionExists == null) {
    return { kind: "fallback" };
  }
  if (
    tool === "claude_code" &&
    queryRow(db, "SELECT 1 FROM unbilled_request WHERE session_id = ?1 LIMIT 1", [
      state.sessionId,
    ]) != null
  ) {
    return { kind: "fallback" };
  }
  if (stats.size <= input.priorSize || stats.size < loaded.parsedOffset) {
    return { kind: "fallback" };
  }
  const currentPrefixHash = computePrefixHash(fd, loaded.parsedOffset);
  if (currentPrefixHash !== loaded.prefixHash) {
    return { kind: "fallback" };
  }
  const currentExternalKey = externalKeyFor(
    tool,
    input.sidecarMeta,
    tool === "codex" ? (input.codexTitles.get(sessionExists.source_session_id) ?? null) : null,
  );
  if (currentExternalKey !== state.externalKey) {
    return { kind: "fallback" };
  }

  let readStart = loaded.parsedOffset;
  if (state.needsLeadingNewline) {
    if (stats.size === loaded.parsedOffset) {
      return { kind: "fallback" };
    }
    const peek = readSlice(fd, loaded.parsedOffset, Math.min(2, stats.size - loaded.parsedOffset));
    if (peek[0] === 0x0a) {
      readStart = loaded.parsedOffset + 1;
    } else if (peek[0] === 0x0d && peek[1] === 0x0a) {
      readStart = loaded.parsedOffset + 2;
    } else {
      return { kind: "fallback" };
    }
  }

  const deltaLen = stats.size - readStart;
  const deltaBuf = deltaLen > 0 ? readSlice(fd, readStart, deltaLen) : Buffer.alloc(0);
  const scanned = scanLinesFromBuffer(deltaBuf, readStart, loaded.parsedLineCount + 1);

  const prevCwd =
    tool === "claude_code"
      ? (state.parser as ClaudeStepperState).cwd
      : tool === "codex"
        ? (state.parser as CodexStepperState).cwd
        : (state.parser as PiStepperState).cwd;
  const prevStartedAt =
    tool === "claude_code"
      ? (state.parser as ClaudeStepperState).startedAt
      : tool === "codex"
        ? (state.parser as CodexStepperState).startedAt
        : (state.parser as PiStepperState).startedAt;
  const prevSessionSummary =
    tool === "claude_code"
      ? claudeSessionFromState(state.parser as ClaudeStepperState, [], state.isArchived)
      : tool === "codex"
        ? codexSessionFromState(
            state.parser as CodexStepperState,
            input.codexTitles,
            [],
            state.isArchived,
          )
        : piSessionFromState(state.parser as PiStepperState, [], state.isArchived);
  const prevUnknownJson = canonicalJson(state.parser.unknownTypes);

  const deltaIssues: Issue[] = [];
  const newMessages: NormalizedMessage[] = [];
  const startSeq = state.parser.seq;

  const claudeUnbilledOld: {
    seq: number;
    requestId: string;
    usage: TokenUsage;
  }[] = [];
  const claudeFinalApiIdByReqId = new Map<string, string | null>();
  let codexStampedOld: { seq: number; usage: TokenUsage; previousUsage: TokenUsage | null } | null =
    null;
  const piNestedCalls: { toolCallId: string; inner: NormalizedInnerToolCall[] }[] = [];

  const claudeEvicted = tool === "claude_code" ? openCompactSet(state.claudeEvictedRequests) : null;
  if (tool === "claude_code") {
    const st = state.parser as ClaudeStepperState;
    for (const { line, lineNo } of scanned.lines) {
      const step = stepClaudeLine(st, line, lineNo, deltaIssues);
      if (
        step.requestId != null &&
        claudeEvicted != null &&
        compactSetHas(claudeEvicted, step.requestId)
      ) {
        return { kind: "fallback" };
      }
      if (step.unbilledPrevious != null) {
        if (step.unbilledPrevious.seq >= startSeq) {
          const idx = step.unbilledPrevious.seq - startSeq;
          const prev = newMessages[idx];
          if (prev != null) {
            newMessages[idx] = { ...prev, usage: null };
          }
        } else {
          claudeUnbilledOld.push(step.unbilledPrevious);
        }
      }
      if (step.message != null) {
        if (step.message.usage != null && step.requestId != null) {
          claudeFinalApiIdByReqId.set(step.requestId, claudeApiMessageId(step.message.raw));
        }
        newMessages.push(step.message);
      }
    }
    for (const unbilled of claudeUnbilledOld) {
      const runtime = ownGet(state.claudeBilledRuntime, unbilled.requestId);
      if (
        runtime == null ||
        !claudeFinalApiIdByReqId.has(unbilled.requestId) ||
        runtime.apiMessageId !== claudeFinalApiIdByReqId.get(unbilled.requestId)
      ) {
        return { kind: "fallback" };
      }
    }
  } else if (tool === "codex") {
    const st = state.parser as CodexStepperState;
    for (const { line, lineNo } of scanned.lines) {
      const step = stepCodexLine(st, line, lineNo, deltaIssues);
      if (step.stampedAssistant != null) {
        if (step.stampedAssistant.seq >= startSeq) {
          const idx = step.stampedAssistant.seq - startSeq;
          const prev = newMessages[idx];
          if (prev != null) {
            newMessages[idx] = { ...prev, usage: step.stampedAssistant.usage };
          }
        } else {
          codexStampedOld = {
            seq: step.stampedAssistant.seq,
            usage: step.stampedAssistant.usage,
            previousUsage:
              codexStampedOld != null && codexStampedOld.seq === step.stampedAssistant.seq
                ? codexStampedOld.previousUsage
                : step.stampedAssistant.previousUsage,
          };
        }
      }
      for (const msg of step.messages) {
        newMessages.push(msg);
      }
    }
  } else {
    const st = state.parser as PiStepperState;
    const localToolUses = new Map<string, NormalizedBlock>();
    for (const { line, lineNo } of scanned.lines) {
      const step = stepPiLine(st, line, lineNo, deltaIssues);
      if (step.nestedCalls != null) {
        const localWrapper = localToolUses.get(step.nestedCalls.toolCallId);
        if (localWrapper != null) {
          localWrapper.innerToolCalls = step.nestedCalls.inner;
        } else {
          piNestedCalls.push(step.nestedCalls);
        }
      }
      if (step.message != null) {
        for (const blk of step.message.blocks) {
          if (blk.blockType === "tool_use" && blk.toolUseId != null) {
            localToolUses.set(blk.toolUseId, blk);
          }
        }
        newMessages.push(step.message);
      }
    }
  }

  if (scanned.tornIssue != null) {
    deltaIssues.push(scanned.tornIssue);
  }

  const nextSummary =
    tool === "claude_code"
      ? claudeSessionFromState(state.parser as ClaudeStepperState, [], state.isArchived)
      : tool === "codex"
        ? codexSessionFromState(
            state.parser as CodexStepperState,
            input.codexTitles,
            [],
            state.isArchived,
          )
        : piSessionFromState(state.parser as PiStepperState, [], state.isArchived);

  if (nextSummary.sourceSessionId !== prevSessionSummary.sourceSessionId) {
    return { kind: "fallback" };
  }
  if (nextSummary.isSubagent !== prevSessionSummary.isSubagent) {
    return { kind: "fallback" };
  }
  if (nextSummary.projectPath !== prevSessionSummary.projectPath) {
    return { kind: "fallback" };
  }
  if (nextSummary.cwd !== prevCwd && state.enrich.fileRefCount > 0) {
    return { kind: "fallback" };
  }
  if (
    tool === "claude_code" &&
    nextSummary.startedAt !== prevStartedAt &&
    Object.keys(state.claudeBilledRuntime ?? {}).length > 0
  ) {
    return { kind: "fallback" };
  }
  if (tool === "pi" && nextSummary.startedAt !== prevStartedAt && startSeq > 0) {
    return { kind: "fallback" };
  }
  if (tool === "pi" && piNestedCalls.length > 0) {
    for (const nc of piNestedCalls) {
      const anchor = lookupPiToolUseAnchor(db, state.sessionId, state.piToolUses, nc.toolCallId);
      if (anchor?.hasInner) {
        return { kind: "fallback" };
      }
    }
  }
  const orphanSet = new Set(state.diagnostics.orphanToolResultIds);
  const seenToolUse = openCompactSet(state.diagnostics.seenToolUse);
  const answeredToolUse = openCompactSet(state.diagnostics.answeredToolUse);
  const hasPriorToolUse = (id: string): boolean =>
    confirmedCompactSetHas(seenToolUse, id, (toolUseId) =>
      hasBlockWithToolUseId(db, state.sessionId, toolUseId, "tool_use"),
    );
  const hasPriorToolResult = (id: string): boolean =>
    confirmedCompactSetHas(answeredToolUse, id, (toolUseId) =>
      hasBlockWithToolUseId(db, state.sessionId, toolUseId, "tool_result"),
    );
  const deltaSeenIds = new Set<string>();
  const deltaAnsweredIds = new Set<string>();
  const deltaUnmatchedResults = new Set<string>();
  const deltaUnmatchedCounts = new Map<string, number>();
  for (const [id, queue] of Object.entries(state.unmatchedCalls)) {
    deltaUnmatchedCounts.set(id, queue.length);
  }
  for (const msg of newMessages) {
    for (const blk of msg.blocks) {
      if (blk.blockType === "tool_use" && blk.toolUseId != null) {
        if (
          orphanSet.has(blk.toolUseId) ||
          deltaUnmatchedResults.has(blk.toolUseId) ||
          hasPriorToolUse(blk.toolUseId) ||
          deltaSeenIds.has(blk.toolUseId)
        ) {
          return { kind: "fallback" };
        }
        deltaSeenIds.add(blk.toolUseId);
        deltaUnmatchedCounts.set(blk.toolUseId, (deltaUnmatchedCounts.get(blk.toolUseId) ?? 0) + 1);
      } else if (blk.blockType === "tool_result" && blk.toolUseId != null) {
        if (hasPriorToolResult(blk.toolUseId) || deltaAnsweredIds.has(blk.toolUseId)) {
          return { kind: "fallback" };
        }
        deltaAnsweredIds.add(blk.toolUseId);
        const avail = deltaUnmatchedCounts.get(blk.toolUseId) ?? 0;
        if (avail > 0) {
          deltaUnmatchedCounts.set(blk.toolUseId, avail - 1);
        } else if (hasPriorToolUse(blk.toolUseId) || deltaSeenIds.has(blk.toolUseId)) {
          return { kind: "fallback" };
        } else {
          deltaUnmatchedResults.add(blk.toolUseId);
        }
      }
    }
  }

  const nextPrefixHash = computePrefixHash(fd, scanned.parsedOffset);
  const mtime = Math.trunc(stats.mtimeMs / 1000);

  let lineageDirty =
    canonicalJson(nextSummary.rawMeta) !== canonicalJson(prevSessionSummary.rawMeta);

  let affectedSessionIds: number[] = [];
  let committedLinkageIssues: Issue[] = [];
  const txOutcome = withImmediateTransaction(
    db,
    (): "committed" | "skipped" | "conflict" | "conflict_live" => {
      if (isLiveFileStale(sourcePath, stats, input.mtimeNs, input.ctimeNs)) {
        return "conflict_live";
      }
      const srcNow = queryRow<{
        size: number;
        mtime: number;
        ingest_revision: number;
        session_id: number | null;
      }>(db, "SELECT size, mtime, ingest_revision, session_id FROM ingest_source WHERE path = ?1", [
        sourcePath,
      ]);
      if (
        srcNow != null &&
        srcNow.size === stats.size &&
        srcNow.mtime === mtime &&
        srcNow.ingest_revision === input.expectedRevision
      ) {
        return "skipped";
      }
      const cpNow = queryRow<{
        parsed_offset: number;
        parsed_line_count: number;
        prefix_hash: string;
      }>(
        db,
        "SELECT parsed_offset, parsed_line_count, prefix_hash FROM ingest_checkpoint WHERE path = ?1",
        [sourcePath],
      );
      if (
        srcNow == null ||
        srcNow.size !== input.priorSize ||
        srcNow.mtime !== input.priorMtime ||
        srcNow.session_id !== state.sessionId ||
        srcNow.ingest_revision !== input.expectedRevision ||
        cpNow == null ||
        cpNow.parsed_offset !== loaded.parsedOffset ||
        cpNow.parsed_line_count !== loaded.parsedLineCount ||
        cpNow.prefix_hash !== loaded.prefixHash
      ) {
        return "conflict";
      }
      if (
        tool === "claude_code" &&
        queryRow(db, "SELECT 1 FROM unbilled_request WHERE session_id = ?1 LIMIT 1", [
          state.sessionId,
        ]) != null
      ) {
        return "conflict";
      }

      const sessionId = state.sessionId;
      const modelChanged = (nextSummary.model ?? "") !== (prevSessionSummary.model ?? "");
      let needsModelUsageFallback =
        modelChanged && (state.modelUsage.hasUnrecordedModelMessage || tool === "codex");
      let needsContextWindowFallback = false;
      let needsEconomicsFallback = !state.economics.valid;

      const replacedOldMessageIds = new Set<number>();
      if (
        tool === "claude_code" &&
        claudeUnbilledOld.length > 0 &&
        state.claudeBilledRuntime != null
      ) {
        const clearUsage = db.prepare(
          `UPDATE message
            SET input_tokens = NULL, output_tokens = NULL,
                cache_read_tokens = NULL, cache_creation_tokens = NULL
          WHERE id = ?1`,
        );
        try {
          for (const unbilled of claudeUnbilledOld) {
            const runtime = ownGet(state.claudeBilledRuntime, unbilled.requestId);
            if (runtime == null) {
              needsModelUsageFallback = true;
              needsContextWindowFallback = true;
              needsEconomicsFallback = true;
              continue;
            }
            clearUsage.run(runtime.messageId);
            replacedOldMessageIds.add(runtime.messageId);
            applyModelUsageResolved(
              state.modelUsage,
              runtime.model ?? prevSessionSummary.model ?? "",
              runtime.tier,
              runtime.usage,
              runtime.reportedCost,
              -1,
            );
            const oldCtx = contextTokensFromUsage({
              input_tokens: runtime.usage.input,
              cache_read_tokens: runtime.usage.cacheRead,
              cache_creation_tokens: runtime.usage.cacheCreation,
            });
            if (oldCtx != null && oldCtx >= state.contextWindow.peakTokens) {
              needsContextWindowFallback = true;
            }
            state.contextWindow.pointCount = Math.max(0, state.contextWindow.pointCount - 1);
            needsEconomicsFallback = true;
            delete state.claudeBilledRuntime[unbilled.requestId];
          }
        } finally {
          clearUsage.finalize();
        }
      }

      if (tool === "codex" && codexStampedOld != null) {
        const targetId = state.codexLatestAssistantMessageId;
        if (targetId != null) {
          runStatement(
            db,
            `UPDATE message
              SET input_tokens = ?2, output_tokens = ?3,
                  cache_read_tokens = ?4, cache_creation_tokens = ?5
            WHERE id = ?1`,
            [
              targetId,
              codexStampedOld.usage.input,
              codexStampedOld.usage.output,
              codexStampedOld.usage.cacheRead,
              codexStampedOld.usage.cacheCreation,
            ],
          );
          const sm = nextSummary.model ?? "";
          const prevSm = prevSessionSummary.model ?? "";
          if (codexStampedOld.previousUsage != null) {
            applyModelUsageResolved(
              state.modelUsage,
              prevSm,
              "standard",
              codexStampedOld.previousUsage,
              0,
              -1,
            );
            needsContextWindowFallback = true;
          }
          applyModelUsageResolved(state.modelUsage, sm, "standard", codexStampedOld.usage, 0, 1);
          if (sm !== prevSm) {
            needsModelUsageFallback = true;
          }
          const ctx = contextTokensFromUsage({
            input_tokens: codexStampedOld.usage.input,
            cache_read_tokens: codexStampedOld.usage.cacheRead,
            cache_creation_tokens: codexStampedOld.usage.cacheCreation,
          });
          if (ctx != null && !needsContextWindowFallback) {
            state.contextWindow.pointCount += 1;
            state.contextWindow.peakTokens = Math.max(state.contextWindow.peakTokens, ctx);
            state.contextWindow.lastContextSinceCompaction = ctx;
          }
        } else {
          needsModelUsageFallback = true;
          needsContextWindowFallback = true;
        }
      }

      const insertMessage = db.prepare(
        `INSERT INTO message(
         session_id, seq, source_uuid, parent_source_uuid, role, model, stop_reason,
         timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw, raw_meta, raw_bytes
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      );
      const insertBlock = db.prepare(
        `INSERT INTO block(
         message_id, session_id, ordinal, type, text, tool_name, tool_use_id, tool_input, tool_result, tool_result_bytes
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      );
      const insertToolCall = db.prepare(
        `INSERT INTO tool_call(
         session_id, message_id, call_block_id, result_block_id, tool_kind, tool_name,
         mcp_server, tool_base_name, tool_use_id, input, input_bytes, is_error, has_result,
         output_preview, output_bytes, duration_ms, ordinal, timestamp
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      );
      const updateToolCallResult = db.prepare(
        `UPDATE tool_call
          SET result_block_id = ?2, is_error = ?3, has_result = 1,
              output_preview = ?4, output_bytes = ?5, duration_ms = ?6
        WHERE id = ?1`,
      );
      const insertFileRef = db.prepare(
        `INSERT INTO file_ref(session_id, message_id, path, rel_path, ext, operation, timestamp)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      );

      const newBilledForReconcile: IncrementalBilledEntry[] = [];
      const econBlocks: EconBlockInput[] = [];
      const econNewCalls: {
        toolName: string;
        input: string | null;
        outputBytes: number;
        callSeq: number;
      }[] = [];
      const econMatchedResults: {
        toolName: string;
        input: string | null;
        outputBytes: number;
        callSeq: number;
      }[] = [];
      const newLinkageIssues: Issue[] = [];

      const sessionModel = nextSummary.model ?? "";

      try {
        for (const message of newMessages) {
          const storedRaw = encodeMessageRaw(canonicalJson(message.raw), message.raw);
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
              storedRaw.raw,
              storedRaw.rawMeta,
              storedRaw.rawBytes,
            ).lastInsertRowid,
          );

          if (tool === "codex") {
            if (message.role === "user" || message.role === "system") {
              state.codexLatestAssistantMessageId = null;
            } else if (message.role === "assistant") {
              state.codexLatestAssistantMessageId = messageId;
            }
          }

          if (message.usage != null) {
            const applied = applyModelUsageMessage(
              state.modelUsage,
              tool,
              sessionModel,
              message.model,
              message.usage,
              message.raw,
              1,
            );
            if (tool === "claude_code") {
              const reqId = claudeRequestId(message.raw);
              const apiId = claudeApiMessageId(message.raw);
              if (reqId != null && state.claudeBilledRuntime != null) {
                state.claudeBilledRuntime[reqId] = {
                  messageId,
                  model: applied.model,
                  tier: applied.tier,
                  usage: applied.resolvedUsage,
                  reportedCost: applied.reportedCost,
                  apiMessageId: apiId,
                };
              }
              if (apiId != null && apiId !== "") {
                newBilledForReconcile.push({ messageId, requestId: apiId });
              }
            }
          }

          const refs = fileRefsForMessage(tool, message.seq, message, nextSummary.cwd);
          for (const ref of refs) {
            insertFileRef.run(
              sessionId,
              messageId,
              ref.path,
              ref.relPath,
              ref.ext,
              ref.operation,
              ref.timestamp,
            );
          }

          const spawned = foldEnrichMessage(
            state.enrich,
            tool,
            nextSummary.isSubagent,
            nextSummary.startedAt,
            message,
            refs.length,
            refs,
          );
          lineageDirty ||= spawned;
          if (isRenderableReply(message)) state.replyCount += 1;
          state.toolCallCount += countToolUseBlocks(message);
          foldContextWindowMessage(state.contextWindow, tool, nextSummary.isSubagent, message);

          const respId = message.role === "assistant" ? claudeApiMessageId(message.raw) : null;
          for (const blk of message.blocks) {
            const toolInputStr = blk.toolInput === undefined ? null : canonicalJson(blk.toolInput);
            const storedToolResult = encodeBlockToolResult(blk.toolResult);
            const blockId = Number(
              insertBlock.run(
                messageId,
                sessionId,
                blk.ordinal,
                blk.blockType,
                blk.text,
                blk.toolName,
                blk.toolUseId,
                toolInputStr,
                storedToolResult.toolResult,
                storedToolResult.toolResultBytes,
              ).lastInsertRowid,
            );

            let matchedCallForResult: { toolName: string; input: string | null } | null = null;

            if (blk.blockType === "tool_use") {
              const name = blk.toolName ?? "";
              const classified = classifyTool(name);
              const callTs = blk.calledAt ?? message.timestamp;
              const tcId = Number(
                insertToolCall.run(
                  sessionId,
                  messageId,
                  blockId,
                  null,
                  classified.kind,
                  name,
                  classified.mcpServer,
                  classified.baseName,
                  blk.toolUseId,
                  toolInputStr,
                  toolInputStr == null ? null : byteLength(toolInputStr),
                  null,
                  0,
                  null,
                  null,
                  null,
                  blk.ordinal,
                  callTs,
                ).lastInsertRowid,
              );
              state.searchCount += countSearchCandidateToolCall(name, toolInputStr);
              econNewCalls.push({
                toolName: name,
                input: toolInputStr,
                outputBytes: 0,
                callSeq: message.seq,
              });
              if (blk.toolUseId != null) {
                const queue = ownGet(state.unmatchedCalls, blk.toolUseId) ?? [];
                queue.push({
                  toolCallId: tcId,
                  callBlockId: blockId,
                  callSeq: message.seq,
                  toolName: name,
                  input: toolInputStr,
                  timestamp: callTs,
                });
                state.unmatchedCalls[blk.toolUseId] = queue;
                compactSetAdd(seenToolUse, blk.toolUseId);
              }
              if (tool === "pi" && state.piToolUses != null && blk.toolUseId != null) {
                state.piToolUses[blk.toolUseId] = {
                  messageId,
                  callBlockId: blockId,
                  ordinal: blk.ordinal,
                  timestamp: callTs,
                  hasInner: (blk.innerToolCalls?.length ?? 0) > 0,
                };
              }
              for (const inner of blk.innerToolCalls ?? []) {
                const innerClassified = classifyTool(inner.toolName);
                const innerInput =
                  inner.toolInput === undefined ? null : canonicalJson(inner.toolInput);
                insertToolCall.run(
                  sessionId,
                  messageId,
                  blockId,
                  null,
                  innerClassified.kind,
                  inner.toolName,
                  innerClassified.mcpServer,
                  innerClassified.baseName,
                  inner.toolUseId,
                  innerInput,
                  innerInput == null ? null : byteLength(innerInput),
                  inner.isError == null ? null : Number(inner.isError),
                  0,
                  null,
                  null,
                  null,
                  blk.ordinal,
                  callTs,
                );
                state.searchCount += countSearchCandidateToolCall(inner.toolName, innerInput);
                econNewCalls.push({
                  toolName: inner.toolName,
                  input: innerInput,
                  outputBytes: 0,
                  callSeq: message.seq,
                });
              }
            } else if (blk.blockType === "tool_result" && blk.toolUseId != null) {
              const queue = ownGet(state.unmatchedCalls, blk.toolUseId);
              const call = queue?.shift();
              if (queue != null && queue.length === 0) {
                delete state.unmatchedCalls[blk.toolUseId];
              }
              if (call != null) {
                const output = blk.toolResult ?? "";
                const outBytes = byteLength(output);
                updateToolCallResult.run(
                  call.toolCallId,
                  blockId,
                  blk.isError == null ? null : Number(blk.isError),
                  previewHeadTail(output, 500),
                  outBytes,
                  durationBetween(call.timestamp, message.timestamp),
                );
                matchedCallForResult = { toolName: call.toolName, input: call.input };
                econMatchedResults.push({
                  toolName: call.toolName,
                  input: call.input,
                  outputBytes: outBytes,
                  callSeq: call.callSeq,
                });
              }
              if (call == null && !hasPriorToolUse(blk.toolUseId)) {
                orphanSet.add(blk.toolUseId);
                newLinkageIssues.push({
                  code: "orphan_tool_result",
                  lineNo: null,
                  error: `tool_result references tool_use id "${blk.toolUseId}" absent from the session`,
                  rawLine: null,
                });
                state.diagnostics.hasLinkageIssues = true;
              }
              compactSetAdd(answeredToolUse, blk.toolUseId);
            }

            const { otherKind, textBytes } = econOtherKind(blk);
            econBlocks.push({
              messageId,
              seq: message.seq,
              role: message.role,
              outputTokens: message.usage?.output ?? null,
              responseId: respId,
              type: blk.blockType,
              toolName: blk.toolName ?? matchedCallForResult?.toolName ?? null,
              toolInput:
                blk.blockType === "tool_use" ||
                blk.blockType === "tool_result" ||
                blk.blockType === "web_search"
                  ? (toolInputStr ?? matchedCallForResult?.input ?? null)
                  : null,
              textBytes,
              timestamp: message.timestamp,
              otherKind,
            });
          }
        }

        if (tool === "pi" && piNestedCalls.length > 0 && state.piToolUses != null) {
          for (const nc of piNestedCalls) {
            const anchor = lookupPiToolUseAnchor(db, sessionId, state.piToolUses, nc.toolCallId);
            if (anchor == null) continue;
            anchor.hasInner = true;
            state.piToolUses[nc.toolCallId] = anchor;
            for (const inner of nc.inner) {
              const innerClassified = classifyTool(inner.toolName);
              const innerInput =
                inner.toolInput === undefined ? null : canonicalJson(inner.toolInput);
              insertToolCall.run(
                sessionId,
                anchor.messageId,
                anchor.callBlockId,
                null,
                innerClassified.kind,
                inner.toolName,
                innerClassified.mcpServer,
                innerClassified.baseName,
                inner.toolUseId,
                innerInput,
                innerInput == null ? null : byteLength(innerInput),
                inner.isError == null ? null : Number(inner.isError),
                0,
                null,
                null,
                null,
                anchor.ordinal,
                anchor.timestamp,
              );
              state.searchCount += countSearchCandidateToolCall(inner.toolName, innerInput);
              econNewCalls.push({
                toolName: inner.toolName,
                input: innerInput,
                outputBytes: 0,
                callSeq: startSeq,
              });
              needsEconomicsFallback = true;
            }
          }
        }
      } finally {
        insertFileRef.finalize();
        updateToolCallResult.finalize();
        insertToolCall.finalize();
        insertBlock.finalize();
        insertMessage.finalize();
      }

      state.diagnostics.seenToolUse = sealCompactSet(seenToolUse);
      state.diagnostics.answeredToolUse = sealCompactSet(answeredToolUse);
      state.diagnostics.orphanToolResultIds = [...orphanSet];
      if (tool === "claude_code" && claudeEvicted != null) {
        const claudeSt = state.parser as ClaudeStepperState;
        compactClaudeStepper(claudeSt, CLAUDE_RECENT_REQUEST_WINDOW, (key) => {
          compactSetAdd(claudeEvicted, key);
        });
        if (state.claudeBilledRuntime != null) {
          for (const reqId of Object.keys(state.claudeBilledRuntime)) {
            if (ownGet(claudeSt.billed, reqId) == null) {
              delete state.claudeBilledRuntime[reqId];
            }
          }
        }
        if (claudeEvicted.bits != null || (claudeEvicted.exact?.size ?? 0) > 0) {
          state.claudeEvictedRequests = sealCompactSet(claudeEvicted);
        }
      }
      compactPiToolUses(state.piToolUses, MAX_PI_TOOL_USES_WINDOW);

      const cwCols = computeContextWindowColumns(
        state.contextWindow,
        tool,
        nextSummary.model,
        nextSummary.rawMeta,
      );
      const gotOutcome = outcomeFromEnrich(state.enrich);
      const gotWorkType = workTypeFromEnrich(state.enrich);

      runStatement(
        db,
        `UPDATE session
          SET title = ?2,
              cwd = ?3,
              git_branch = ?4,
              model = ?5,
              reasoning_effort = ?6,
              reasoning_effort_levels = ?7,
              cli_version = ?8,
              started_at = ?9,
              ended_at = ?10,
              message_count = ?11,
              total_input_tokens = ?12,
              total_output_tokens = ?13,
              total_cache_read_tokens = ?14,
              total_cache_creation_tokens = ?15,
              total_cache_creation_1h_tokens = ?16,
              total_reasoning_tokens = ?17,
              est_reasoning_tokens = ?18,
              reasoning_source = ?19,
              raw_meta = ?20,
              ingested_at = datetime('now'),
              source_mtime = ?21,
              source_size = ?22,
              turn_count = ?23,
              error_count = ?24,
              interruption_count = ?25,
              compaction_count = ?26,
              sidechain_message_count = ?27,
              agent_spawn_count = ?28,
              skill_count = ?29,
              command_count = ?30,
              thinking_block_count = ?31,
              thinking_chars = ?32,
              active_seconds = ?33,
              outcome = ?34,
              work_type = ?35,
              context_window_tokens = ?36,
              peak_context_tokens = ?37,
              agent_id = COALESCE(agent_id, ?38),
              reply_count = ?39,
              tool_call_count = ?40,
              search_count = ?41
        WHERE id = ?1`,
        [
          sessionId,
          nextSummary.title,
          nextSummary.cwd,
          nextSummary.gitBranch,
          nextSummary.model,
          nextSummary.reasoningEffort,
          canonicalJson(nextSummary.reasoningEffortLevels),
          nextSummary.cliVersion,
          nextSummary.startedAt,
          nextSummary.endedAt,
          state.parser.seq,
          nextSummary.totals.input,
          nextSummary.totals.output,
          nextSummary.totals.cacheRead,
          nextSummary.totals.cacheCreation,
          nextSummary.totals.cacheCreation1h,
          nextSummary.totals.reasoning,
          nextSummary.estReasoningTokens,
          nextSummary.reasoningSource,
          canonicalJson(nextSummary.rawMeta),
          mtime,
          stats.size,
          cwCols.turnCount,
          state.enrich.facets.errorCount,
          state.enrich.facets.interruptionCount,
          cwCols.compactionCount,
          state.enrich.facets.sidechainMessageCount,
          state.enrich.facets.agentSpawnCount,
          state.enrich.facets.skillCount,
          state.enrich.facets.commandCount,
          state.enrich.facets.thinkingBlockCount,
          state.enrich.facets.thinkingChars,
          state.enrich.facets.activeSeconds,
          gotOutcome,
          gotWorkType,
          cwCols.windowTokens,
          cwCols.peakTokens,
          nextSummary.agentId,
          state.replyCount,
          state.toolCallCount,
          state.searchCount,
        ],
      );

      let ownBilledModified = false;
      if (tool === "claude_code") {
        const billedRes = reconcileBilledRequestsIncremental(
          db,
          sessionId,
          newBilledForReconcile,
          replacedOldMessageIds,
        );
        ownBilledModified = billedRes.ownSessionModified;
        affectedSessionIds = billedRes.affectedSessionIds;
        if (ownBilledModified) {
          needsModelUsageFallback = true;
          needsContextWindowFallback = true;
          needsEconomicsFallback = true;
        }
      }

      let usageRows: ModelUsageRow[];
      if (needsModelUsageFallback) {
        usageRows = materializeModelUsage(db, sessionId);
        state.modelUsage = rebuildModelUsageFoldFromDb(db, sessionId, tool, sessionModel);
      } else {
        usageRows = computeModelUsageRows(state.modelUsage, sessionModel, nextSummary.totals);
        writeModelUsageRows(db, sessionId, usageRows);
      }
      const costSession = ownBilledModified
        ? queryRow<{
            model: string | null;
            total_input_tokens: number;
            total_output_tokens: number;
            total_cache_read_tokens: number;
            total_cache_creation_tokens: number;
            total_cache_creation_1h_tokens: number;
          }>(
            db,
            `SELECT model, total_input_tokens, total_output_tokens, total_cache_read_tokens,
                  total_cache_creation_tokens, total_cache_creation_1h_tokens
             FROM session WHERE id = ?1`,
            [sessionId],
          )
        : null;
      const costUsage =
        costSession == null
          ? nextSummary.totals
          : {
              input: costSession.total_input_tokens,
              output: costSession.total_output_tokens,
              cacheRead: costSession.total_cache_read_tokens,
              cacheCreation: costSession.total_cache_creation_tokens,
              cacheCreation1h: costSession.total_cache_creation_1h_tokens,
              reasoning: 0,
            };
      runStatement(db, "UPDATE session SET estimated_cost_usd = ?1 WHERE id = ?2", [
        totalCost(sessionCostParts(usageRows, { model: nextSummary.model, usage: costUsage })),
        sessionId,
      ]);

      if (needsContextWindowFallback) {
        materializeContextWindow(db, sessionId);
        state.contextWindow = rebuildContextWindowFoldFromDb(
          db,
          sessionId,
          tool,
          nextSummary.isSubagent,
        );
      }

      if (!needsEconomicsFallback) {
        const econOk = foldEconomicsDelta(
          state.economics,
          tool,
          nextSummary.startedAt,
          econBlocks,
          econNewCalls,
          econMatchedResults,
        );
        if (econOk) {
          storeEconomicsVector(
            db,
            buildEconomicsVector(state.economics, sessionId, nextSummary, usageRows),
          );
        } else {
          needsEconomicsFallback = true;
        }
      }
      if (needsEconomicsFallback) {
        materializeSessionEconomics(db, sessionId);
        state.economics.valid = false;
      }

      runStatement(
        db,
        "DELETE FROM ingest_issue WHERE source_path = ?1 AND code = 'unparsed_line' AND line_no > ?2",
        [sourcePath, loaded.parsedLineCount],
      );
      const unknownChanged = canonicalJson(state.parser.unknownTypes) !== prevUnknownJson;
      if (unknownChanged) {
        runStatement(
          db,
          "DELETE FROM ingest_issue WHERE source_path = ?1 AND code = 'unknown_record_type'",
          [sourcePath],
        );
      }
      const unknownIssues = unknownChanged
        ? tool === "claude_code"
          ? claudeUnknownTypeIssues(state.parser as ClaudeStepperState)
          : tool === "codex"
            ? codexUnknownTypeIssues(state.parser as CodexStepperState)
            : piUnknownTypeIssues(state.parser as PiStepperState)
        : [];
      const issuesToInsert = [...deltaIssues, ...unknownIssues, ...newLinkageIssues];
      if (issuesToInsert.length > 0) {
        const insertIssue = db.prepare(
          `INSERT INTO ingest_issue(source_path, line_no, error, raw_line, code, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
        );
        try {
          for (const issue of issuesToInsert) {
            insertIssue.run(sourcePath, issue.lineNo, issue.error, issue.rawLine, issue.code);
          }
        } finally {
          insertIssue.finalize();
        }
      }

      const totalIssueCount =
        queryRow<{ n: number }>(
          db,
          "SELECT COUNT(*) AS n FROM ingest_issue WHERE source_path = ?1",
          [sourcePath],
        )?.n ?? 0;
      const status = totalIssueCount === 0 ? "ok" : "ok_with_issues";

      runStatement(
        db,
        `UPDATE ingest_source
          SET size = ?2,
              mtime = ?3,
              hash = NULL,
              ingest_revision = ?4,
              session_id = ?5,
              line_count = ?6,
              status = ?7,
              error = NULL,
              last_ingested_at = datetime('now')
        WHERE path = ?1`,
        [
          sourcePath,
          stats.size,
          mtime,
          input.expectedRevision,
          sessionId,
          scanned.totalLines,
          status,
        ],
      );

      state.needsLeadingNewline = scanned.needsLeadingNewline;
      saveCheckpoint(
        db,
        sourcePath,
        scanned.parsedOffset,
        scanned.parsedLineCount,
        nextPrefixHash,
        state,
      );
      bumpSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_PENDING);
      if (lineageDirty) {
        bumpSyncStateGeneration(db, SYNC_STATE_DERIVED_PENDING);
      }
      committedLinkageIssues = newLinkageIssues;
      return "committed";
    },
  );

  if (txOutcome === "skipped") {
    return { kind: "skipped" };
  }
  if (txOutcome === "conflict_live") {
    return { kind: "conflict", liveChanged: true };
  }
  if (txOutcome === "conflict") {
    return { kind: "conflict" };
  }

  const allReportIssues = [...deltaIssues, ...committedLinkageIssues];
  if (canonicalJson(state.parser.unknownTypes) !== prevUnknownJson) {
    allReportIssues.push(
      ...(tool === "claude_code"
        ? claudeUnknownTypeIssues(state.parser as ClaudeStepperState)
        : tool === "codex"
          ? codexUnknownTypeIssues(state.parser as CodexStepperState)
          : piUnknownTypeIssues(state.parser as PiStepperState)),
    );
  }

  return {
    kind: "ingested",
    sessionId: state.sessionId,
    affectedSessionIds,
    issues: allReportIssues,
    lineageDirty,
    projectCreated: false,
  };
}
