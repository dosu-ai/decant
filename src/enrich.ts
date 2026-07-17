import type { NormalizedBlock, NormalizedMessage, NormalizedSession } from "./model.ts";

export type Operation = "read" | "edit" | "write" | "delete";

export interface FileRef {
  messageIdx: number;
  path: string;
  relPath: string | null;
  ext: string | null;
  operation: Operation;
  timestamp: string | null;
}

export interface Facets {
  turnCount: number;
  errorCount: number;
  interruptionCount: number;
  compactionCount: number;
  sidechainMessageCount: number;
  agentSpawnCount: number;
  skillCount: number;
  commandCount: number;
  thinkingBlockCount: number;
  thinkingChars: number;
  activeSeconds: number;
}

const ACTIVE_GAP_CAP_SECONDS = 300;
const INTERRUPTION_MARKER = "[Request interrupted by user";
const COMMAND_MARKER = "<command-name>";
const encoder = new TextEncoder();

export function fileRefs(session: NormalizedSession): FileRef[] {
  const refs: FileRef[] = [];
  for (const [messageIdx, message] of session.messages.entries()) {
    for (const block of message.blocks) {
      if (block.blockType !== "tool_use") {
        continue;
      }
      if (session.tool === "claude_code") {
        claudeRef(messageIdx, message, block, session.cwd, refs);
      } else {
        codexRefs(messageIdx, message, block, session.cwd, refs);
      }
    }
  }
  return refs;
}

function claudeRef(
  messageIdx: number,
  message: NormalizedMessage,
  block: NormalizedBlock,
  cwd: string | null,
  refs: FileRef[],
): void {
  const pair =
    block.toolName === "Read"
      ? ({ key: "file_path", operation: "read" } as const)
      : block.toolName === "Edit"
        ? ({ key: "file_path", operation: "edit" } as const)
        : block.toolName === "Write"
          ? ({ key: "file_path", operation: "write" } as const)
          : block.toolName === "NotebookEdit"
            ? ({ key: "notebook_path", operation: "edit" } as const)
            : null;
  if (pair == null || !isObject(block.toolInput)) {
    return;
  }
  const path = block.toolInput[pair.key];
  if (typeof path !== "string") {
    return;
  }
  refs.push(makeRef(messageIdx, message, path, pair.operation, cwd));
}

function codexRefs(
  messageIdx: number,
  message: NormalizedMessage,
  block: NormalizedBlock,
  cwd: string | null,
  refs: FileRef[],
): void {
  if (block.toolName !== "apply_patch" || typeof block.toolInput !== "string") {
    return;
  }
  for (const line of block.toolInput.split(/\n/)) {
    const parsed = line.startsWith("*** Add File: ")
      ? ({ path: line.slice("*** Add File: ".length).trim(), operation: "write" } as const)
      : line.startsWith("*** Update File: ")
        ? ({ path: line.slice("*** Update File: ".length).trim(), operation: "edit" } as const)
        : line.startsWith("*** Delete File: ")
          ? ({ path: line.slice("*** Delete File: ".length).trim(), operation: "delete" } as const)
          : null;
    if (parsed != null && parsed.path !== "") {
      refs.push(makeRef(messageIdx, message, parsed.path, parsed.operation, cwd));
    }
  }
}

function makeRef(
  messageIdx: number,
  message: NormalizedMessage,
  path: string,
  operation: Operation,
  cwd: string | null,
): FileRef {
  return {
    messageIdx,
    path,
    relPath: relativize(path, cwd),
    ext: extension(path),
    operation,
    timestamp: message.timestamp,
  };
}

export function relativize(path: string, cwd: string | null): string | null {
  if (!path.startsWith("/")) {
    return path;
  }
  if (cwd == null) {
    return null;
  }
  const normalizedCwd = cwd.replace(/\/+$/, "");
  const prefix = `${normalizedCwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) || null : null;
}

export function extension(path: string): string | null {
  const leaf = path.split("/").at(-1) ?? path;
  const index = leaf.lastIndexOf(".");
  if (index <= 0 || index === leaf.length - 1) {
    return null;
  }
  return leaf.slice(index + 1).toLowerCase();
}

export function facets(session: NormalizedSession): Facets {
  const got: Facets = {
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
  };
  let previousTimestamp: number | null = null;

  for (const message of session.messages) {
    const sidechain = rawBoolean(message.raw, "isSidechain") === true;
    const compactSummary = rawBoolean(message.raw, "isCompactSummary") === true;
    if (sidechain) {
      got.sidechainMessageCount += 1;
    }
    if (
      rawString(message.raw, "subtype") === "compact_boundary" ||
      rawString(message.raw, "type") === "compacted"
    ) {
      got.compactionCount += 1;
    }

    let hasRealText = false;
    for (const block of message.blocks) {
      if (block.blockType === "text") {
        const text = block.text ?? "";
        if (text.startsWith(INTERRUPTION_MARKER)) {
          got.interruptionCount += 1;
        } else if (text.includes(COMMAND_MARKER)) {
          got.commandCount += 1;
        } else if (text.trim() !== "") {
          hasRealText = true;
        }
      } else if (block.blockType === "thinking") {
        got.thinkingBlockCount += 1;
        got.thinkingChars += byteLength(block.text ?? "");
      } else if (block.blockType === "tool_use") {
        if (block.toolName === "Agent" || block.toolName === "Task") {
          got.agentSpawnCount += 1;
        } else if (block.toolName === "Skill") {
          got.skillCount += 1;
        }
      } else if (block.blockType === "tool_result" && block.isError === true) {
        got.errorCount += 1;
      }
    }

    // Sidechain rows embedded in a parent belong to a child agent, but a
    // standalone subagent file uses those rows as its primary conversation.
    // Machine-generated compaction summaries continue a turn rather than
    // starting a new one.
    if (
      message.role === "user" &&
      hasRealText &&
      (!sidechain || session.isSubagent) &&
      !compactSummary
    ) {
      got.turnCount += 1;
    }

    const timestamp = message.timestamp == null ? null : epochSecs(message.timestamp);
    if (timestamp != null) {
      if (previousTimestamp != null) {
        const gap = timestamp - previousTimestamp;
        if (gap > 0) {
          got.activeSeconds += Math.min(gap, ACTIVE_GAP_CAP_SECONDS);
        }
      }
      previousTimestamp = timestamp;
    }
  }

  return got;
}

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export function epochSecs(timestamp: string): number | null {
  if (!timestamp.endsWith("Z")) {
    return null;
  }
  const withoutZone = timestamp.slice(0, -1);
  const [date, timeWithFraction] = withoutZone.split("T");
  if (date == null || timeWithFraction == null) {
    return null;
  }
  const dateParts = date.split("-").map((part) => Number.parseInt(part, 10));
  const timeParts = (timeWithFraction.split(".")[0] ?? "")
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const [year, month, day] = dateParts;
  const [hour, minute, second] = timeParts;
  if ([year, month, day, hour, minute, second].some((part) => !Number.isFinite(part))) {
    return null;
  }
  if (
    year == null ||
    month == null ||
    day == null ||
    hour == null ||
    minute == null ||
    second == null
  ) {
    return null;
  }
  return Math.trunc(Date.UTC(year, month - 1, day, hour, minute, second) / 1000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawBoolean(raw: unknown, key: string): boolean | null {
  if (!isObject(raw)) {
    return null;
  }
  const value = raw[key];
  return typeof value === "boolean" ? value : null;
}

function rawString(raw: unknown, key: string): string | null {
  if (!isObject(raw)) {
    return null;
  }
  const value = raw[key];
  return typeof value === "string" ? value : null;
}
