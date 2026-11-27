import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CorpusProfile = "pi" | "small";

export interface CorpusManifest {
  profile: CorpusProfile;
  seed: number;
  outDir: string;
  claudeDir: string;
  codexDir: string;
  copilotDir: string;
  liveSession: {
    filePath: string;
    sessionId: string;
    projectDir: string;
    initialBytes: number;
    lastUuid: string;
    lastTimestampMs: number;
    turnIndex: number;
  };
  stats: {
    totalFiles: number;
    totalBytes: number;
    claudeFiles: number;
    claudeBytes: number;
    codexFiles: number;
    codexBytes: number;
    copilotFiles: number;
    copilotBytes: number;
    filesOver1MB: number;
    filesOver10MB: number;
    largestFileBytes: number;
  };
  scalingFiles?: Array<{
    label: string;
    targetMb: number;
    claudeDir: string;
    filePath: string;
    sessionId: string;
    lastUuid: string;
    lastTimestampMs: number;
    bytes: number;
  }>;
}

export interface GenerateCorpusOptions {
  outDir: string;
  profile: CorpusProfile;
  seed?: number;
  withScaling?: boolean;
}

export interface LiveAppenderState {
  sessionId: string;
  projectDir: string;
  lastUuid: string;
  lastTimestampMs: number;
  turnIndex: number;
}

export interface LiveAppendOptions {
  kind: "tool_burst" | "assistant_turn";
  marker?: string;
  seed?: number;
}

export interface LiveAppendChunk {
  lines: string[];
  nextState: LiveAppenderState;
  marker?: string;
}

const DEFAULT_SEED = 20261125;
const MB = 1_000_000;
const FLUSH_BYTES = 1 << 20;
const BASE_MS = Date.UTC(2026, 10, 1);
const CLAUDE_VERSION = "2.1.0";
const GIT_BRANCH = "main";
const CLAUDE_MODELS = ["claude-opus-4-7", "claude-sonnet-4-5"];
const CODEX_MODEL = "gpt-5.4";
const COPILOT_MODELS = ["claude-sonnet-4.5", "gpt-5.4"];
const SCALING_SIZES = [
  { label: "1mb", targetMb: 1 },
  { label: "5mb", targetMb: 5 },
  { label: "20mb", targetMb: 20 },
  { label: "60mb", targetMb: 60 },
];
const SYNTHETIC_WORK_ROOT = "/synthetic-decant-bench/work";
const SYNTHETIC_PROJECT_DIR_PREFIX = `${SYNTHETIC_WORK_ROOT.replaceAll("/", "-")}-`;
const SCALE_PROJECT_DIR = `${SYNTHETIC_PROJECT_DIR_PREFIX}scale`;

const PROJECTS = ["atlas", "ledger", "orbit", "forge", "relay", "quill", "harbor", "summit"];
const DIRS = ["src", "src/sources", "src/ui", "test", "scripts", "docs", "lib", "packages/core"];
const MODULES = [
  "ingest",
  "claude",
  "codex",
  "copilot",
  "db",
  "schema",
  "server",
  "cost",
  "query",
  "stats",
  "watch",
  "cli",
  "util",
  "buckets",
  "render",
  "cache",
];
const EXTS = [".ts", ".ts", ".ts", ".tsx", ".sql", ".md", ".json", ".go"];
const VERBS = [
  "parse",
  "load",
  "render",
  "sync",
  "cache",
  "index",
  "fetch",
  "merge",
  "build",
  "resolve",
  "compact",
  "emit",
  "decode",
  "track",
  "score",
  "normalize",
  "reconcile",
];
const NOUNS = [
  "Session",
  "Message",
  "Usage",
  "Cost",
  "Batch",
  "Record",
  "Chunk",
  "Config",
  "Path",
  "Token",
  "Event",
  "Summary",
  "Diagnostic",
  "Cursor",
];
const TYPES = [
  "string",
  "number",
  "boolean",
  "Map<string, number>",
  "ReadonlyArray<Message>",
  "Promise<void>",
  "Json",
  "SessionRow | null",
];
const TABLES = ["session", "message", "tool_call", "ingest_issue", "model_usage"];
const LEVELS = ["INFO", "DEBUG", "WARN", "ERROR"];
const WORDS = [
  "the",
  "parser",
  "keeps",
  "a",
  "cursor",
  "for",
  "each",
  "session",
  "file",
  "and",
  "resumes",
  "from",
  "the",
  "last",
  "offset",
  "when",
  "new",
  "lines",
  "arrive",
  "we",
  "should",
  "avoid",
  "rereading",
  "whole",
  "archive",
  "during",
  "sync",
  "because",
  "large",
  "transcripts",
  "can",
  "exceed",
  "memory",
  "budget",
  "so",
  "batch",
  "inserts",
  "inside",
  "one",
  "transaction",
  "that",
  "commits",
  "only",
  "after",
  "validation",
  "passes",
  "check",
  "migration",
  "order",
  "before",
  "schema",
  "version",
  "bump",
  "reviewers",
  "asked",
  "for",
  "clearer",
  "error",
  "messages",
  "on",
  "malformed",
  "records",
  "tool",
  "result",
  "includes",
  "stack",
  "trace",
  "output",
  "usage",
  "tokens",
  "cache",
  "read",
  "write",
  "creation",
  "model",
  "pricing",
  "tier",
  "prompt",
  "response",
  "reasoning",
  "summary",
  "diff",
  "hunk",
  "renames",
  "config",
  "loader",
  "falls",
  "back",
  "to",
  "defaults",
  "when",
  "environment",
  "variable",
  "unset",
  "test",
  "suite",
  "covers",
  "edge",
  "cases",
  "fixture",
  "golden",
  "snapshot",
  "index",
  "search",
  "query",
  "ranking",
  "latency",
  "throughput",
  "warning",
  "retry",
  "timeout",
  "socket",
  "stream",
  "event",
  "queue",
  "worker",
  "thread",
  "lock",
  "checkpoint",
  "vacuum",
  "pragma",
  "journal",
  "size",
  "limit",
  "guard",
  "boundary",
  "symlink",
  "directory",
  "watcher",
  "debounce",
  "subagent",
  "parent",
  "child",
  "spawn",
  "compact",
  "context",
  "window",
  "projection",
  "bucket",
  "daily",
  "rollup",
  "estimate",
  "rate",
  "card",
  "the",
  "a",
  "of",
  "with",
  "without",
  "into",
  "across",
  "per",
  "each",
];

class Rng {
  constructor(public state: number) {
    this.state = state >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  token(length: number): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += alphabet[Math.floor(this.next() * alphabet.length)];
    }
    return out;
  }

  uuid(): string {
    const hex = Array.from({ length: 32 }, () => Math.floor(this.next() * 16).toString(16)).join(
      "",
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

interface TextPools {
  prose: string[];
  code: string[];
  log: string[];
  data: string[];
}

let poolCache: TextPools | undefined;

function textPools(): TextPools {
  if (poolCache === undefined) {
    const rng = new Rng(subSeed(0, "text-pools"));
    poolCache = {
      prose: Array.from({ length: 12000 }, () => prosePara(rng)),
      code: Array.from({ length: 12000 }, () => codePara(rng)),
      log: Array.from({ length: 10000 }, () => logPara(rng)),
      data: Array.from({ length: 6000 }, () => dataPara(rng)),
    };
  }
  return poolCache;
}

function subSeed(seed: number, label: string): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stamp(ctx: { rng: Rng; ms: number }): string {
  ctx.ms += ctx.rng.int(300, 9000);
  return iso(ctx.ms);
}

function identifier(rng: Rng): string {
  const verb = rng.pick(VERBS);
  return verb + rng.pick(NOUNS);
}

function filePath(rng: Rng, root: string): string {
  return `${root}/${rng.pick(DIRS)}/${rng.pick(MODULES)}${rng.pick(EXTS)}`;
}

function logUniform(rng: Rng, low: number, high: number): number {
  return Math.round(Math.exp(rng.float(Math.log(low), Math.log(high))));
}

function sentence(rng: Rng): string {
  const count = rng.int(7, 16);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(rng.chance(0.08) ? identifier(rng) : rng.pick(WORDS));
  }
  const text = words.join(" ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function prosePara(rng: Rng): string {
  const count = rng.int(3, 6);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(sentence(rng));
  }
  return parts.join(" ");
}

function codeLine(rng: Rng, variable: string): string {
  switch (rng.int(0, 5)) {
    case 0:
      return `const ${variable} = input.${rng.pick(WORDS)} ?? ${rng.int(0, 512)};`;
    case 1:
      return `if (${variable} === ${rng.int(0, 99)}) return ${variable};`;
    case 2:
      return `for (const item of ${variable}) total += item.${rng.pick(WORDS)};`;
    case 3:
      return `db.prepare("SELECT ${rng.pick(WORDS)}, ${rng.pick(WORDS)} FROM ${rng.pick(TABLES)} WHERE id = ?1").all(${variable});`;
    case 4:
      return `throw new Error("unexpected ${rng.pick(WORDS)} " + ${variable});`;
    default:
      return `// ${sentence(rng)}`;
  }
}

function codePara(rng: Rng): string {
  const name = identifier(rng);
  const lines = [
    `export function ${name}(input: ${rng.pick(TYPES)}, options: ParseOptions = {}): ${rng.pick(TYPES)} {`,
  ];
  const count = rng.int(5, 12);
  for (let i = 0; i < count; i += 1) {
    lines.push(`  ${codeLine(rng, identifier(rng))}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function stampText(rng: Rng): string {
  return `2026-11-${pad(rng.int(1, 28))}T${pad(rng.int(0, 23))}:${pad(rng.int(0, 59))}:${pad(rng.int(0, 59))}.${pad(rng.int(0, 999), 3)}Z`;
}

function logPara(rng: Rng): string {
  const module = rng.pick(MODULES);
  const count = rng.int(4, 12);
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    switch (rng.int(0, 4)) {
      case 0:
        lines.push(
          `[${stampText(rng)}] ${rng.pick(LEVELS)} ${module}: ${rng.pick(VERBS)} ${rng.int(1, 4000)} rows in ${rng.int(1, 900)}ms`,
        );
        break;
      case 1:
        lines.push(`PASS test/${module}.test.ts (${rng.int(1, 60)} tests, ${rng.int(3, 4000)}ms)`);
        break;
      case 2:
        lines.push(
          `FAIL test/${module}.test.ts > ${identifier(rng)} expected ${rng.pick(TYPES)} received ${rng.pick(TYPES)}`,
        );
        break;
      case 3:
        lines.push(
          `src/${module}.ts(${rng.int(1, 900)},${rng.int(1, 120)}): error TS${rng.int(2300, 2900)}: Type '${rng.pick(TYPES)}' is not assignable to type '${rng.pick(TYPES)}'.`,
        );
        break;
      default:
        lines.push(
          rng.chance(0.4) ? "Author: Dev Example <dev@example.com>" : `  ${sentence(rng)}`,
        );
    }
  }
  return lines.join("\n");
}

function dataPara(rng: Rng): string {
  switch (rng.int(0, 2)) {
    case 0:
      return [
        "SELECT s.id, s.tool, COUNT(m.id) AS messages, SUM(m.output_tokens) AS output_tokens",
        "FROM session s JOIN message m ON m.session_id = s.id",
        `WHERE s.started_at >= ?1 AND s.tool = '${rng.pick(["claude_code", "codex", "copilot"])}'`,
        `GROUP BY s.id ORDER BY output_tokens DESC LIMIT ${rng.int(5, 200)};`,
      ].join("\n");
    case 1:
      return JSON.stringify(
        {
          id: rng.uuid(),
          path: filePath(rng, `${SYNTHETIC_WORK_ROOT}/atlas`),
          bytes: rng.int(1024, 900000),
          tokens: { input: rng.int(1, 9000), output: rng.int(1, 4000) },
          flags: [rng.pick(WORDS), rng.pick(WORDS)],
        },
        null,
        2,
      );
    default: {
      const lines = [
        `@@ -${rng.int(1, 400)},${rng.int(3, 12)} +${rng.int(1, 400)},${rng.int(3, 14)} @@`,
      ];
      const count = rng.int(3, 10);
      for (let i = 0; i < count; i += 1) {
        lines.push(`-  ${codeLine(rng, identifier(rng))}`);
        lines.push(`+  ${codeLine(rng, identifier(rng))}`);
      }
      return lines.join("\n");
    }
  }
}

type TextMix = "prose" | "tool";

function paragraph(pools: TextPools, rng: Rng, mix: TextMix): string {
  const roll = rng.next();
  if (mix === "prose") {
    return roll < 0.75 ? rng.pick(pools.prose) : rng.pick(pools.code);
  }
  if (roll < 0.4) {
    return rng.pick(pools.code);
  }
  return roll < 0.75 ? rng.pick(pools.log) : rng.pick(pools.data);
}

function textOf(rng: Rng, mix: TextMix, target: number): string {
  const pools = textPools();
  const parts: string[] = [];
  let length = 0;
  while (length < target) {
    const part = paragraph(pools, rng, mix);
    parts.push(part);
    length += part.length + 1;
  }
  return parts.join("\n").slice(0, target);
}

class CorpusWriter {
  private fd: number;
  private chunks: string[] = [];
  private pending = 0;
  private written = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, "wx", 0o600);
  }

  bytesWritten(): number {
    return this.written;
  }

  line(text: string): void {
    const chunk = `${text}\n`;
    this.chunks.push(chunk);
    this.pending += chunk.length;
    this.written += chunk.length;
    if (this.pending >= FLUSH_BYTES) {
      this.flush();
    }
  }

  flush(): void {
    if (this.chunks.length === 0) {
      return;
    }
    writeSync(this.fd, this.chunks.join(""));
    this.chunks = [];
    this.pending = 0;
  }

  close(): void {
    try {
      this.flush();
    } finally {
      closeSync(this.fd);
    }
  }
}

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeContext {
  rng: Rng;
  sessionId: string;
  projectDir: string;
  cwd: string;
  model: string;
  lastUuid: string | null;
  ms: number;
  turnIndex: number;
}

function cwdForProjectDir(projectDir: string): string {
  return `${SYNTHETIC_WORK_ROOT}/${projectDir.slice(SYNTHETIC_PROJECT_DIR_PREFIX.length)}`;
}

function claudeModelFor(sessionId: string): string {
  return CLAUDE_MODELS[subSeed(0, sessionId) % CLAUDE_MODELS.length] ?? CLAUDE_MODELS[0] ?? "";
}

function claudeRecord(
  ctx: ClaudeContext,
  type: "user" | "assistant",
  message: Record<string, unknown>,
  requestId?: string,
): string {
  const uuid = ctx.rng.uuid();
  const line = JSON.stringify({
    parentUuid: ctx.lastUuid,
    isSidechain: false,
    userType: "external",
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    version: CLAUDE_VERSION,
    gitBranch: GIT_BRANCH,
    type,
    message,
    ...(requestId === undefined ? {} : { requestId }),
    uuid,
    timestamp: stamp(ctx),
  });
  ctx.lastUuid = uuid;
  return line;
}

function claudeToolUse(ctx: ClaudeContext): ToolUse {
  const { rng } = ctx;
  const id = `toolu_${rng.token(24)}`;
  const path = filePath(rng, ctx.cwd);
  switch (rng.int(0, 3)) {
    case 0:
      return {
        id,
        name: "Bash",
        input: { command: `bun test ${path}`, description: sentence(rng) },
      };
    case 1:
      return { id, name: "Read", input: { file_path: path } };
    case 2:
      return {
        id,
        name: "Grep",
        input: { pattern: identifier(rng), path: `${ctx.cwd}/src`, output_mode: "content" },
      };
    default:
      return {
        id,
        name: "Edit",
        input: {
          file_path: path,
          old_string: codeLine(rng, identifier(rng)),
          new_string: codeLine(rng, identifier(rng)),
        },
      };
  }
}

interface AssistantSpec {
  thinking: string | null;
  text: string;
  tools: ToolUse[];
  stop: "tool_use" | "end_turn";
}

function claudeAssistant(ctx: ClaudeContext, spec: AssistantSpec): string[] {
  const { rng } = ctx;
  const requestId = `req_011C${rng.token(20)}`;
  const messageId = `msg_01${rng.token(22)}`;
  const content: unknown[] = [];
  if (spec.thinking !== null) {
    content.push({ type: "thinking", thinking: spec.thinking, signature: rng.token(96) });
  }
  if (spec.text !== "") {
    content.push({ type: "text", text: spec.text });
  }
  for (const tool of spec.tools) {
    content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
  }
  const usage = {
    input_tokens: rng.int(1, 900),
    cache_creation_input_tokens: rng.int(0, 4000),
    cache_read_input_tokens: rng.int(2000, 90000),
    service_tier: "standard",
  };
  const outputTokens = rng.int(180, 2400);
  const message = (output: number): Record<string, unknown> => ({
    id: messageId,
    type: "message",
    role: "assistant",
    model: ctx.model,
    content,
    stop_reason: spec.stop,
    stop_sequence: null,
    usage: { ...usage, output_tokens: output },
  });
  const lines = [claudeRecord(ctx, "assistant", message(outputTokens), requestId)];
  if (rng.chance(0.12)) {
    const streamedContent = content.filter(
      (block) => (block as { type: string }).type !== "tool_use",
    );
    lines.push(
      claudeRecord(
        ctx,
        "assistant",
        { ...message(outputTokens + rng.int(20, 300)), content: streamedContent },
        requestId,
      ),
    );
  }
  return lines;
}

function claudeToolResults(ctx: ClaudeContext, tools: ToolUse[]): string {
  const content = tools.map((tool) => ({
    type: "tool_result",
    tool_use_id: tool.id,
    content: textOf(ctx.rng, "tool", logUniform(ctx.rng, 1024, 24576)),
    is_error: false,
  }));
  return claudeRecord(ctx, "user", { role: "user", content });
}

function claudeTurn(ctx: ClaudeContext): string[] {
  const { rng } = ctx;
  const lines: string[] = [];
  const promptSize = rng.chance(0.6) ? rng.int(60, 240) : rng.int(300, 900);
  lines.push(
    claudeRecord(ctx, "user", { role: "user", content: textOf(rng, "prose", promptSize) }),
  );
  const tools = Array.from({ length: rng.chance(0.4) ? 2 : 1 }, () => claudeToolUse(ctx));
  lines.push(
    ...claudeAssistant(ctx, {
      thinking: textOf(rng, "prose", rng.int(800, 1600)),
      text: textOf(rng, "prose", rng.int(300, 1200)),
      tools,
      stop: "tool_use",
    }),
  );
  lines.push(claudeToolResults(ctx, tools));
  lines.push(
    ...claudeAssistant(ctx, {
      thinking: null,
      text: textOf(rng, "prose", rng.int(800, 2400)),
      tools: [],
      stop: "end_turn",
    }),
  );
  ctx.turnIndex += 1;
  return lines;
}

function withMarker(marker: string | undefined, text: string): string {
  return marker === undefined ? text : `${marker} ${text}`;
}

function claudeToolBurst(ctx: ClaudeContext, marker: string | undefined): string[] {
  const { rng } = ctx;
  const pairs = rng.int(2, 4);
  const total = rng.int(4096, 20480);
  const perResult = Math.max(512, Math.floor(total / pairs) - 700);
  const lines: string[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const tool = claudeToolUse(ctx);
    const text = withMarker(i === 0 ? marker : undefined, textOf(rng, "prose", rng.int(160, 480)));
    lines.push(...claudeAssistant(ctx, { thinking: null, text, tools: [tool], stop: "tool_use" }));
    lines.push(
      claudeRecord(ctx, "user", {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: tool.id,
            content: textOf(rng, "tool", perResult),
            is_error: false,
          },
        ],
      }),
    );
  }
  return lines;
}

function claudeAssistantTurn(ctx: ClaudeContext, marker: string | undefined): string[] {
  const { rng } = ctx;
  const lines = [
    claudeRecord(ctx, "user", { role: "user", content: textOf(rng, "prose", rng.int(200, 400)) }),
  ];
  lines.push(
    ...claudeAssistant(ctx, {
      thinking: textOf(rng, "prose", rng.int(400, 800)),
      text: withMarker(marker, textOf(rng, "prose", rng.int(900, 3000))),
      tools: [],
      stop: "end_turn",
    }),
  );
  return lines;
}

interface SessionFileResult {
  filePath: string;
  sessionId: string;
  projectDir: string;
  cwd: string;
  lastUuid: string;
  lastTimestampMs: number;
  turnIndex: number;
  bytes: number;
}

function writeClaudeSession(
  filePath: string,
  targetBytes: number,
  rng: Rng,
  start: { sessionId: string; projectDir: string; cwd: string; startMs: number },
): SessionFileResult {
  const writer = new CorpusWriter(filePath);
  const ctx: ClaudeContext = {
    rng,
    sessionId: start.sessionId,
    projectDir: start.projectDir,
    cwd: start.cwd,
    model: claudeModelFor(start.sessionId),
    lastUuid: null,
    ms: start.startMs,
    turnIndex: 0,
  };
  try {
    while (writer.bytesWritten() < targetBytes) {
      for (const line of claudeTurn(ctx)) {
        writer.line(line);
      }
    }
  } finally {
    writer.close();
  }
  return {
    filePath,
    sessionId: ctx.sessionId,
    projectDir: ctx.projectDir,
    cwd: ctx.cwd,
    lastUuid: ctx.lastUuid ?? "",
    lastTimestampMs: ctx.ms,
    turnIndex: ctx.turnIndex,
    bytes: statSync(filePath).size,
  };
}

interface CodexContext {
  rng: Rng;
  sessionId: string;
  cwd: string;
  ms: number;
  totals: { input: number; cached: number; output: number; reasoning: number };
}

function codexTurn(ctx: CodexContext): string[] {
  const { rng } = ctx;
  const lines: string[] = [];
  const add = (type: string, payload: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ type, timestamp: stamp(ctx), payload }));
  };
  add("turn_context", {
    cwd: ctx.cwd,
    model: CODEX_MODEL,
    effort: "high",
    approval_policy: "on-request",
  });
  add("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: textOf(rng, "prose", rng.int(80, 700)) }],
  });
  add("response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: textOf(rng, "prose", rng.int(300, 1100)) }],
  });
  const callId = `call_${rng.token(24)}`;
  add("response_item", {
    type: "function_call",
    name: "exec_command",
    call_id: callId,
    arguments: JSON.stringify({
      cmd: `bun test ${filePath(rng, ctx.cwd)}`,
      workdir: ctx.cwd,
      max_output_tokens: 1024,
    }),
  });
  add("response_item", {
    type: "function_call_output",
    call_id: callId,
    output: textOf(rng, "tool", logUniform(rng, 1024, 24576)),
  });
  if (rng.chance(0.35)) {
    const patchId = `call_${rng.token(24)}`;
    add("response_item", {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: patchId,
      input: `*** Begin Patch\n*** Update File: ${filePath(rng, ctx.cwd)}\n${textOf(rng, "tool", rng.int(400, 3000))}\n*** End Patch`,
    });
    add("response_item", {
      type: "custom_tool_call_output",
      call_id: patchId,
      output: `Done. ${rng.int(1, 6)} files changed.`,
    });
  }
  ctx.totals.input += rng.int(400, 2000);
  ctx.totals.cached += rng.int(100, 900);
  ctx.totals.output += rng.int(80, 900);
  ctx.totals.reasoning += rng.int(10, 300);
  add("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: ctx.totals.input,
        cached_input_tokens: ctx.totals.cached,
        output_tokens: ctx.totals.output,
        reasoning_output_tokens: ctx.totals.reasoning,
        total_tokens: ctx.totals.input + ctx.totals.output,
      },
    },
  });
  add("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: textOf(rng, "prose", rng.int(300, 1400)) }],
  });
  return lines;
}

function writeCodexSession(
  filePath: string,
  targetBytes: number,
  rng: Rng,
  start: { sessionId: string; cwd: string; startMs: number },
): number {
  const writer = new CorpusWriter(filePath);
  const ctx: CodexContext = {
    rng,
    sessionId: start.sessionId,
    cwd: start.cwd,
    ms: start.startMs,
    totals: { input: 0, cached: 0, output: 0, reasoning: 0 },
  };
  try {
    writer.line(
      JSON.stringify({
        type: "session_meta",
        timestamp: iso(ctx.ms),
        payload: {
          id: ctx.sessionId,
          cwd: ctx.cwd,
          originator: "codex_cli_rs",
          cli_version: "0.116.0",
          source: "cli",
          model_provider: "openai",
        },
      }),
    );
    while (writer.bytesWritten() < targetBytes) {
      for (const line of codexTurn(ctx)) {
        writer.line(line);
      }
    }
  } finally {
    writer.close();
  }
  return statSync(filePath).size;
}

interface CopilotContext {
  rng: Rng;
  ms: number;
  parentId: string | null;
  model: string;
  turnId: number;
}

function copilotEvent(ctx: CopilotContext, type: string, data: Record<string, unknown>): string {
  const id = ctx.rng.uuid();
  const line = JSON.stringify({
    type,
    data,
    id,
    timestamp: stamp(ctx),
    parentId: ctx.parentId,
  });
  ctx.parentId = id;
  return line;
}

function copilotTurn(ctx: CopilotContext, cwd: string): string[] {
  const { rng } = ctx;
  const turnId = String(ctx.turnId);
  const interactionId = `int-${ctx.turnId}`;
  const lines = [
    copilotEvent(ctx, "user.message", {
      content: textOf(rng, "prose", rng.int(80, 500)),
      interactionId,
    }),
    copilotEvent(ctx, "assistant.turn_start", { turnId, interactionId }),
  ];
  if (rng.chance(0.5)) {
    lines.push(
      copilotEvent(ctx, "assistant.reasoning", {
        reasoningId: `r-${rng.token(12)}`,
        content: textOf(rng, "prose", rng.int(300, 1000)),
      }),
    );
  }
  const toolCallId = `call-${rng.token(16)}`;
  const isEdit = rng.chance(0.35);
  const path = filePath(rng, cwd);
  const toolName = isEdit ? "edit" : "bash";
  const args = isEdit
    ? { path, old_str: codeLine(rng, identifier(rng)), new_str: codeLine(rng, identifier(rng)) }
    : { command: `bun test ${path}`, description: sentence(rng) };
  lines.push(
    copilotEvent(ctx, "assistant.message", {
      messageId: `msg-${rng.token(16)}`,
      content: "",
      model: ctx.model,
      outputTokens: rng.int(20, 900),
      toolRequests: [{ toolCallId, name: toolName, arguments: args, type: "function" }],
    }),
  );
  lines.push(copilotEvent(ctx, "tool.execution_start", { toolCallId, toolName, arguments: args }));
  const result = {
    content: textOf(rng, "tool", logUniform(rng, 1024, 24576)),
  };
  lines.push(
    copilotEvent(
      ctx,
      "tool.execution_complete",
      isEdit
        ? {
            toolCallId,
            success: true,
            result,
            fileEdits: [{ kind: "edit", path }],
          }
        : { toolCallId, success: true, result, shellExecution: { exitCode: 0 } },
    ),
  );
  lines.push(
    copilotEvent(ctx, "assistant.message", {
      messageId: `msg-${rng.token(16)}`,
      content: textOf(rng, "prose", rng.int(200, 1200)),
      model: ctx.model,
      outputTokens: rng.int(30, 600),
    }),
  );
  lines.push(copilotEvent(ctx, "assistant.turn_end", { turnId }));
  ctx.turnId += 1;
  return lines;
}

function writeCopilotSession(
  filePath: string,
  targetBytes: number,
  rng: Rng,
  start: { sessionId: string; cwd: string; startMs: number; repository: string },
): number {
  const writer = new CorpusWriter(filePath);
  const ctx: CopilotContext = {
    rng,
    ms: start.startMs,
    parentId: null,
    model: rng.pick(COPILOT_MODELS),
    turnId: 0,
  };
  try {
    writer.line(
      copilotEvent(ctx, "session.start", {
        sessionId: start.sessionId,
        version: 1,
        producer: "copilot-agent",
        copilotVersion: "1.0.105",
        startTime: iso(ctx.ms),
        selectedModel: ctx.model,
        reasoningEffort: "medium",
        context: {
          cwd: start.cwd,
          gitRoot: start.cwd,
          branch: GIT_BRANCH,
          repository: start.repository,
          hostType: "github",
        },
      }),
    );
    while (writer.bytesWritten() < targetBytes) {
      for (const line of copilotTurn(ctx, start.cwd)) {
        writer.line(line);
      }
    }
    writer.line(
      copilotEvent(ctx, "session.shutdown", {
        shutdownType: "routine",
        totalPremiumRequests: ctx.turnId,
        currentModel: ctx.model,
        codeChanges: {
          linesAdded: rng.int(1, 80),
          linesRemoved: rng.int(0, 40),
          filesModified: [],
        },
      }),
    );
  } finally {
    writer.close();
  }
  return statSync(filePath).size;
}

interface PlanEntry {
  tool: "claude" | "codex" | "copilot";
  index: number;
  bytes: number;
  live: boolean;
}

function planEntries(
  tool: PlanEntry["tool"],
  sizes: number[],
  liveIndex: number | null = null,
): PlanEntry[] {
  return sizes.map((bytes, index) => ({ tool, index, bytes, live: index === liveIndex }));
}

function piPlan(seed: number): PlanEntry[] {
  const rng = new Rng(subSeed(seed, "plan:pi"));
  const large = [
    68_600_000, 28_000_000, 20_600_000, 18_000_000, 15_000_000, 12_000_000, 10_500_000,
  ];
  const smallClaude = Array.from({ length: 44 }, () => rng.int(25_000, 950_000));
  const smallCodex = Array.from({ length: 107 }, () => rng.int(25_000, 950_000));
  const weights = Array.from({ length: 169 }, () => rng.float(1, 3));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const claudeBudget =
    614 * MB -
    large.reduce((sum, bytes) => sum + bytes, 0) -
    [...smallClaude, ...smallCodex].reduce((sum, bytes) => sum + bytes, 0);
  const medium = weights.map((weight) => Math.round((weight / weightSum) * claudeBudget));
  const copilotWeights = Array.from({ length: 30 }, () => rng.float(0.6, 1.4));
  const copilotSum = copilotWeights.reduce((sum, weight) => sum + weight, 0);
  const copilot = copilotWeights.map((weight) => Math.round((weight / copilotSum) * 40 * MB));
  return [
    ...planEntries("claude", [...large, ...medium, ...smallClaude], 2),
    ...planEntries("codex", smallCodex),
    ...planEntries("copilot", copilot),
  ];
}

function smallPlan(seed: number): PlanEntry[] {
  const rng = new Rng(subSeed(seed, "plan:small"));
  const claude = [2_000_000, ...Array.from({ length: 5 }, () => rng.int(600_000, 1_000_000))];
  const codex = Array.from({ length: 3 }, () => rng.int(500_000, 900_000));
  const copilot = Array.from({ length: 3 }, () => rng.int(500_000, 700_000));
  return [
    ...planEntries("claude", claude, 0),
    ...planEntries("codex", codex),
    ...planEntries("copilot", copilot),
  ];
}

interface WrittenFile {
  tool: PlanEntry["tool"];
  path: string;
  bytes: number;
}

function sumBytes(files: WrittenFile[], tool: PlanEntry["tool"] | null): number {
  return files
    .filter((file) => tool === null || file.tool === tool)
    .reduce((sum, file) => sum + file.bytes, 0);
}

export async function generateCorpus(options: GenerateCorpusOptions): Promise<CorpusManifest> {
  const seed = options.seed ?? DEFAULT_SEED;
  const outDir = resolve(options.outDir);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`refusing to write a corpus into a non-empty directory: ${outDir}`);
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const claudeDir = join(outDir, "claude");
  const codexDir = join(outDir, "codex");
  const copilotDir = join(outDir, "copilot");
  const plan = options.profile === "pi" ? piPlan(seed) : smallPlan(seed);
  const files: WrittenFile[] = [];
  let live: SessionFileResult | undefined;

  for (const entry of plan) {
    const rng = new Rng(subSeed(seed, `${entry.tool}:${entry.index}`));
    const startMs = BASE_MS + rng.int(0, 20 * 24 * 3600 * 1000);
    if (entry.tool === "claude") {
      const sessionId = rng.uuid();
      const projectDir = `${SYNTHETIC_PROJECT_DIR_PREFIX}${PROJECTS[entry.index % PROJECTS.length] ?? "atlas"}`;
      const cwd = cwdForProjectDir(projectDir);
      const filePath = join(claudeDir, projectDir, `${sessionId}.jsonl`);
      const result = writeClaudeSession(filePath, entry.bytes, rng, {
        sessionId,
        projectDir,
        cwd,
        startMs,
      });
      files.push({ tool: "claude", path: filePath, bytes: result.bytes });
      if (entry.live) {
        live = result;
      }
    } else if (entry.tool === "codex") {
      const sessionId = rng.uuid();
      const day = pad(1 + (entry.index % 28));
      const filePath = join(
        codexDir,
        "sessions",
        "2026",
        "11",
        day,
        `rollout-2026-11-${day}T10-${pad(entry.index % 60)}-00-${sessionId}.jsonl`,
      );
      const bytes = writeCodexSession(filePath, entry.bytes, rng, {
        sessionId,
        cwd: `${SYNTHETIC_WORK_ROOT}/${PROJECTS[entry.index % PROJECTS.length] ?? "atlas"}`,
        startMs,
      });
      files.push({ tool: "codex", path: filePath, bytes });
    } else {
      const sessionId = rng.uuid();
      const project = PROJECTS[entry.index % PROJECTS.length] ?? "atlas";
      const filePath = join(copilotDir, sessionId, "events.jsonl");
      const bytes = writeCopilotSession(filePath, entry.bytes, rng, {
        sessionId,
        cwd: `${SYNTHETIC_WORK_ROOT}/${project}`,
        startMs,
        repository: `example/${project}`,
      });
      files.push({ tool: "copilot", path: filePath, bytes });
    }
  }

  if (live === undefined) {
    throw new Error("corpus plan has no live Claude session");
  }

  const scalingFiles = options.withScaling ? writeScaling(outDir, seed) : undefined;
  const mainSizes = files.filter((file) => file.tool !== "copilot").map((file) => file.bytes);
  const stats = {
    totalFiles: files.length,
    totalBytes: sumBytes(files, null),
    claudeFiles: files.filter((file) => file.tool === "claude").length,
    claudeBytes: sumBytes(files, "claude"),
    codexFiles: files.filter((file) => file.tool === "codex").length,
    codexBytes: sumBytes(files, "codex"),
    copilotFiles: files.filter((file) => file.tool === "copilot").length,
    copilotBytes: sumBytes(files, "copilot"),
    filesOver1MB: mainSizes.filter((bytes) => bytes > MB).length,
    filesOver10MB: mainSizes.filter((bytes) => bytes > 10 * MB).length,
    largestFileBytes: Math.max(...mainSizes),
  };

  return {
    profile: options.profile,
    seed,
    outDir,
    claudeDir,
    codexDir,
    copilotDir,
    liveSession: {
      filePath: live.filePath,
      sessionId: live.sessionId,
      projectDir: live.projectDir,
      initialBytes: live.bytes,
      lastUuid: live.lastUuid,
      lastTimestampMs: live.lastTimestampMs,
      turnIndex: live.turnIndex,
    },
    stats,
    ...(scalingFiles === undefined ? {} : { scalingFiles }),
  };
}

function writeScaling(outDir: string, seed: number): NonNullable<CorpusManifest["scalingFiles"]> {
  return SCALING_SIZES.map(({ label, targetMb }) => {
    const rng = new Rng(subSeed(seed, `scale:${label}`));
    const sessionId = rng.uuid();
    const claudeDir = join(outDir, "scaling", label);
    const filePath = join(claudeDir, SCALE_PROJECT_DIR, `scale-${label}.jsonl`);
    const result = writeClaudeSession(filePath, targetMb * MB, rng, {
      sessionId,
      projectDir: SCALE_PROJECT_DIR,
      cwd: cwdForProjectDir(SCALE_PROJECT_DIR),
      startMs: BASE_MS,
    });
    return {
      label,
      targetMb,
      claudeDir,
      filePath: result.filePath,
      sessionId: result.sessionId,
      lastUuid: result.lastUuid,
      lastTimestampMs: result.lastTimestampMs,
      bytes: result.bytes,
    };
  });
}

export function generateLiveAppendChunk(
  state: LiveAppenderState,
  options: LiveAppendOptions,
): LiveAppendChunk {
  const rng = new Rng(
    subSeed(options.seed ?? DEFAULT_SEED, `live:${state.sessionId}:${state.turnIndex}`),
  );
  const ctx: ClaudeContext = {
    rng,
    sessionId: state.sessionId,
    projectDir: state.projectDir,
    cwd: cwdForProjectDir(state.projectDir),
    model: claudeModelFor(state.sessionId),
    lastUuid: state.lastUuid,
    ms: state.lastTimestampMs,
    turnIndex: state.turnIndex,
  };
  const lines =
    options.kind === "tool_burst"
      ? claudeToolBurst(ctx, options.marker)
      : claudeAssistantTurn(ctx, options.marker);
  const nextState: LiveAppenderState = {
    sessionId: state.sessionId,
    projectDir: state.projectDir,
    lastUuid: ctx.lastUuid ?? state.lastUuid,
    lastTimestampMs: ctx.ms,
    turnIndex: state.turnIndex + 1,
  };
  return {
    lines,
    nextState,
    ...(options.marker === undefined ? {} : { marker: options.marker }),
  };
}

function parseArgs(argv: string[]): GenerateCorpusOptions {
  let outDir: string | undefined;
  let profile: CorpusProfile = "small";
  let seed = DEFAULT_SEED;
  let withScaling = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--out" && next !== undefined) {
      outDir = next;
      i += 1;
    } else if (arg === "--profile" && next !== undefined) {
      if (next !== "pi" && next !== "small") {
        throw new Error(`unknown profile: ${next}`);
      }
      profile = next;
      i += 1;
    } else if (arg === "--seed" && next !== undefined) {
      seed = Number(next);
      if (!Number.isInteger(seed)) {
        throw new Error(`seed must be an integer: ${next}`);
      }
      i += 1;
    } else if (arg === "--with-scaling") {
      withScaling = true;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg ?? ""}`);
    }
  }
  if (outDir === undefined) {
    throw new Error(
      "usage: bun run scripts/bench-corpus.ts --out <dir> [--profile pi|small] [--seed <n>] [--with-scaling]",
    );
  }
  return { outDir, profile, seed, withScaling };
}

if (import.meta.main) {
  try {
    const manifest = await generateCorpus(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
