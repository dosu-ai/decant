import { byteLength, isObject } from "./json.ts";
import type { NormalizedBlock, NormalizedMessage, NormalizedSession, Tool } from "./model.ts";
import { atifNativeTool } from "./sources/atif.ts";

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
/** OpenCode 2.x starts a child session with `subagent`; older builds named
 * the tool `task`. Scoped to OpenCode so another source's lowercase tool of
 * the same name is not counted. */
const OPENCODE_SPAWN_TOOLS = new Set(["subagent", "task"]);
/** Copilot Chat in VS Code's general subagent and its built-in specialists. */
const VSCODE_COPILOT_SPAWN_TOOLS = new Set([
  "runSubagent",
  "search_subagent",
  "explore_subagent",
  "execution_subagent",
]);

function isAgentSpawn(tool: NormalizedSession["tool"], toolName: string | null): boolean {
  if (toolName === "Agent" || toolName === "Task") {
    return true;
  }
  if (tool === "copilot") {
    return toolName === "task";
  }
  if (tool === "hermes") {
    return toolName === "delegate_task";
  }
  if (tool === "vscode_copilot") {
    return toolName != null && VSCODE_COPILOT_SPAWN_TOOLS.has(toolName);
  }
  return tool === "opencode" && toolName != null && OPENCODE_SPAWN_TOOLS.has(toolName);
}

/** An ATIF trajectory keeps the tool names of the agent that produced it, so
 * its calls are read with that source's rules. An agent Decant does not read
 * natively is read with Claude Code's names, the most common in Harbor's
 * converters, then Codex's shell and patch rules. */
function namingTool(session: NormalizedSession): Tool {
  return session.tool === "atif" ? (atifNativeTool(session.rawMeta) ?? "atif") : session.tool;
}

export function fileRefs(session: NormalizedSession): FileRef[] {
  const tool = namingTool(session);
  if (session.tool === "copilot") {
    return copilotRefs(session);
  }
  const refs: FileRef[] = [];
  for (const [messageIdx, message] of session.messages.entries()) {
    for (const block of message.blocks) {
      if (block.blockType !== "tool_use") {
        continue;
      }
      if (tool === "atif") {
        const before = refs.length;
        keyedRef(CLAUDE_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
        if (refs.length === before) {
          codexRefs(messageIdx, message, block, session.cwd, refs);
        }
      } else if (tool === "copilot") {
        // An imported Copilot CLI trajectory has no `fileEdits` records.
        keyedRef(COPILOT_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "claude_code") {
        keyedRef(CLAUDE_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "gemini") {
        keyedRef(GEMINI_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "opencode") {
        keyedRef(OPENCODE_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "cursor") {
        keyedRef(CURSOR_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "hermes") {
        keyedRef(HERMES_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
      } else if (tool === "vscode_copilot") {
        vscodeCopilotRefs(messageIdx, message, block, session.cwd, refs);
      } else {
        codexRefs(messageIdx, message, block, session.cwd, refs);
      }
    }
  }
  return refs;
}

/** `fallbackKey` is read when `key` does not hold a string. */
type FileToolTable = Record<string, { key: string; fallbackKey?: string; operation: Operation }>;

const CLAUDE_FILE_TOOLS: FileToolTable = {
  Read: { key: "file_path", operation: "read" },
  Edit: { key: "file_path", operation: "edit" },
  Write: { key: "file_path", operation: "write" },
  NotebookEdit: { key: "notebook_path", operation: "edit" },
};

const GEMINI_FILE_TOOLS: FileToolTable = {
  read_file: { key: "file_path", operation: "read" },
  replace: { key: "file_path", operation: "edit" },
  write_file: { key: "file_path", operation: "write" },
};

// OpenCode 2.x's built-in file tools take an absolute `path`. 1.x tools take
// `filePath`, and so do 2.x rows the migrator copied from 1.x, which keep their
// input as written; `multiedit` exists only in 1.x. A `streaming` tool item
// carries its partial input as a string, which keyedRef ignores.
const OPENCODE_FILE_TOOLS: FileToolTable = {
  read: { key: "path", fallbackKey: "filePath", operation: "read" },
  edit: { key: "path", fallbackKey: "filePath", operation: "edit" },
  write: { key: "path", fallbackKey: "filePath", operation: "write" },
  multiedit: { key: "filePath", operation: "edit" },
};

// The Cursor CLI's file tools take an absolute `path`.
const CURSOR_FILE_TOOLS: FileToolTable = {
  Read: { key: "path", operation: "read" },
  StrReplace: { key: "path", operation: "edit" },
  Write: { key: "path", operation: "write" },
};

// Copilot CLI's file tools take an absolute `path`. A finished tool reports
// the files it changed in `fileEdits`, which also covers `apply_patch` and
// shell redirections, so the tool table is read only for reads and for edits
// from a build that predates `fileEdits`.
const COPILOT_FILE_TOOLS: FileToolTable = {
  view: { key: "path", operation: "read" },
  edit: { key: "path", operation: "edit" },
  create: { key: "path", operation: "write" },
};

// Hermes Agent's file tools (tools/file_tools.py) take `path`, which may be
// relative to the session's working directory. `patch` in V4A mode carries
// its paths inside the patch text instead and records no file ref.
const HERMES_FILE_TOOLS: FileToolTable = {
  read_file: { key: "path", operation: "read" },
  patch: { key: "path", operation: "edit" },
  write_file: { key: "path", operation: "write" },
};

const COPILOT_EDIT_KINDS: Record<string, Operation> = {
  create: "write",
  edit: "edit",
  delete: "delete",
};

function copilotRefs(session: NormalizedSession): FileRef[] {
  const refs: FileRef[] = [];
  const reportedEdits = new Set<string>();
  for (const message of session.messages) {
    const data = isObject(message.raw) ? message.raw.data : undefined;
    const toolCallId = isObject(data) ? data.toolCallId : undefined;
    if (
      message.role === "tool" &&
      isObject(data) &&
      Array.isArray(data.fileEdits) &&
      typeof toolCallId === "string"
    ) {
      reportedEdits.add(toolCallId);
    }
  }
  for (const [messageIdx, message] of session.messages.entries()) {
    if (message.role === "tool") {
      const data = isObject(message.raw) ? message.raw.data : undefined;
      const edits = isObject(data) && Array.isArray(data.fileEdits) ? data.fileEdits : [];
      for (const edit of edits) {
        const path = isObject(edit) ? edit.path : undefined;
        const kind = isObject(edit) ? edit.kind : undefined;
        if (typeof path === "string" && typeof kind === "string") {
          const operation = Object.hasOwn(COPILOT_EDIT_KINDS, kind)
            ? COPILOT_EDIT_KINDS[kind]
            : "edit";
          refs.push(makeRef(messageIdx, message, path, operation ?? "edit", session.cwd));
        }
      }
      continue;
    }
    for (const block of message.blocks) {
      if (block.blockType !== "tool_use") {
        continue;
      }
      if (block.toolName !== "view" && reportedEdits.has(block.toolUseId ?? "")) {
        continue;
      }
      keyedRef(COPILOT_FILE_TOOLS, messageIdx, message, block, session.cwd, refs);
    }
  }
  return refs;
}

// Copilot Chat in VS Code's file tools take an absolute `filePath`. Its
// `apply_patch` wraps a Codex-style patch in `input`, and a multi-file replace
// lists one `filePath` per replacement.
const VSCODE_COPILOT_FILE_TOOLS: FileToolTable = {
  read_file: { key: "filePath", operation: "read" },
  create_file: { key: "filePath", operation: "write" },
  replace_string_in_file: { key: "filePath", operation: "edit" },
  insert_edit_into_file: { key: "filePath", operation: "edit" },
  edit_notebook_file: { key: "filePath", operation: "edit" },
};

function vscodeCopilotRefs(
  messageIdx: number,
  message: NormalizedMessage,
  block: NormalizedBlock,
  cwd: string | null,
  refs: FileRef[],
): void {
  const input = block.toolInput;
  if (block.toolName === "apply_patch" && isObject(input) && typeof input.input === "string") {
    codexRefs(messageIdx, message, { ...block, toolInput: input.input }, cwd, refs);
    return;
  }
  if (block.toolName === "multi_replace_string_in_file" && isObject(input)) {
    const replacements = Array.isArray(input.replacements) ? input.replacements : [];
    const paths = new Set<string>();
    for (const replacement of replacements) {
      const path = isObject(replacement) ? replacement.filePath : undefined;
      if (typeof path === "string") {
        paths.add(path);
      }
    }
    for (const path of paths) {
      refs.push(makeRef(messageIdx, message, path, "edit", cwd));
    }
    return;
  }
  keyedRef(VSCODE_COPILOT_FILE_TOOLS, messageIdx, message, block, cwd, refs);
}

function keyedRef(
  table: FileToolTable,
  messageIdx: number,
  message: NormalizedMessage,
  block: NormalizedBlock,
  cwd: string | null,
  refs: FileRef[],
): void {
  const pair =
    block.toolName != null && Object.hasOwn(table, block.toolName)
      ? table[block.toolName]
      : undefined;
  if (pair == null || !isObject(block.toolInput)) {
    return;
  }
  const primary = block.toolInput[pair.key];
  const path =
    typeof primary !== "string" && pair.fallbackKey != null
      ? block.toolInput[pair.fallbackKey]
      : primary;
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
  const windows =
    /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(path) ||
    (cwd != null && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd));
  const normalize = (value: string): string => (windows ? value.replace(/\\/g, "/") : value);
  const normalizedPath = normalize(path);
  if (!normalizedPath.startsWith("/") && !/^[a-z]:\//i.test(normalizedPath)) {
    return normalizedPath;
  }
  if (cwd == null) {
    return null;
  }
  const prefix = `${normalize(cwd).replace(/\/+$/, "")}/`;
  const matches = windows
    ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedPath.startsWith(prefix);
  return matches ? normalizedPath.slice(prefix.length) || null : null;
}

export function extension(path: string): string | null {
  const leaf = path.split(/[\\/]/).at(-1) ?? path;
  const index = leaf.lastIndexOf(".");
  if (index <= 0 || index === leaf.length - 1) {
    return null;
  }
  return leaf.slice(index + 1).toLowerCase();
}

/** ATIF-v1.7's context-management convention on a system step. */
function atifCompaction(raw: NormalizedMessage["raw"]): boolean {
  const extra = isObject(raw) ? raw.extra : undefined;
  const management = isObject(extra) ? extra.context_management : undefined;
  return isObject(management) && management.type === "compaction";
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
    // Copilot CLI marks a subagent's events in the parent journal with the
    // subagent's agentId instead of isSidechain.
    const sidechain =
      rawBoolean(message.raw, "isSidechain") === true ||
      (session.tool === "copilot" && rawString(message.raw, "agentId") != null);
    // Hermes flags the summary an in-place compaction writes in its row.
    const hermesSummary =
      session.tool === "hermes" && isObject(message.raw) && message.raw._compressed_summary === 1;
    const compactSummary = rawBoolean(message.raw, "isCompactSummary") === true;
    if (sidechain) {
      got.sidechainMessageCount += 1;
    }
    if (
      rawString(message.raw, "subtype") === "compact_boundary" ||
      rawString(message.raw, "type") === "compacted" ||
      rawString(message.raw, "type") === "compaction" ||
      (session.tool === "copilot" &&
        rawString(message.raw, "type") === "session.compaction_complete") ||
      (session.tool === "atif" && atifCompaction(message.raw)) ||
      hermesSummary
    ) {
      got.compactionCount += 1;
    }
    if (session.tool === "copilot" && rawString(message.raw, "type") === "abort") {
      got.interruptionCount += 1;
    }
    if (session.tool === "vscode_copilot" && rawBoolean(message.raw, "canceled") === true) {
      got.interruptionCount += 1;
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
        if (isAgentSpawn(namingTool(session), block.toolName)) {
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
      // A backdated parallel call must not reopen time already counted.
      previousTimestamp =
        previousTimestamp == null ? timestamp : Math.max(previousTimestamp, timestamp);
    }
  }

  return got;
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
