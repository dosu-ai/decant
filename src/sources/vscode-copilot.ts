import { linkageIssues } from "../diagnostics.ts";
import { asString, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Issue,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type Role,
  reasoningEffortLevels,
  summarizeReasoningEfforts,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";
import {
  block,
  countUnknown,
  parseJsonLine,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

/** What ingest reads beside a session file, so the parser stays pure. */
export interface VscodeCopilotContext {
  /** `workspace.json` from the session's workspace storage directory:
   * `{ folder }` for a folder window, `{ workspace }` for a `.code-workspace`
   * file. Null for an empty window, whose sessions have no workspace. */
  workspace?: Json | null;
}

/** Response part kinds VS Code persists that add nothing to the normalized
 * transcript. They stay in `message.raw`. Any other kind is reported as an
 * unknown record type, Decant's format-drift signal. */
const IGNORED_PART_KINDS = new Set([
  "autoModeResolution",
  "clearToPreviousToolInvocation",
  "codeblockUri",
  "command",
  "confirmation",
  "disabledClaudeHooks",
  "elicitation",
  "elicitationSerialized",
  "extensions",
  "externalEdit",
  "externalEdits",
  "hook",
  "info",
  "mcpServersStarting",
  "move",
  "multiDiffData",
  "notebookEdit",
  "notebookEditGroup",
  "planReview",
  "prepareToolInvocation",
  "progressMessage",
  "progressTask",
  "progressTaskResult",
  "progressTaskSerialized",
  "pullRequest",
  "questionCarousel",
  "systemNotification",
  "textEdit",
  "textEditGroup",
  "treeData",
  "undoStop",
  "warning",
  "workspaceEdit",
]);

/** Copilot's contributed tool IDs, as VS Code records them, mapped to the
 * names the model calls them by. From `ContributedToolName` and `ToolName` in
 * the Copilot extension's `src/extension/tools/common/toolNames.ts`. Core tools
 * such as `run_in_terminal` and `manage_todo_list` use one name for both. */
const CONTRIBUTED_TOOL_NAMES: Record<string, string> = {
  copilot_applyPatch: "apply_patch",
  copilot_searchCodebase: "semantic_search",
  copilot_searchWorkspaceSymbols: "search_workspace_symbols",
  copilot_getVSCodeAPI: "get_vscode_api",
  copilot_findFiles: "file_search",
  copilot_findTextInFiles: "grep_search",
  copilot_readFile: "read_file",
  copilot_viewImage: "view_image",
  copilot_listDirectory: "list_dir",
  copilot_getErrors: "get_errors",
  copilot_getChangedFiles: "get_changed_files",
  copilot_readProjectStructure: "read_project_structure",
  copilot_createNewJupyterNotebook: "create_new_jupyter_notebook",
  copilot_insertEdit: "insert_edit_into_file",
  copilot_createFile: "create_file",
  copilot_replaceString: "replace_string_in_file",
  copilot_multiReplaceString: "multi_replace_string_in_file",
  copilot_editNotebook: "edit_notebook_file",
  copilot_runNotebookCell: "run_notebook_cell",
  copilot_readNotebookCellOutput: "read_notebook_cell_output",
  copilot_fetchWebPage: "fetch_webpage",
  copilot_memory: "memory",
  copilot_findTestFiles: "test_search",
  copilot_githubRepo: "github_repo",
  copilot_githubTextSearch: "github_text_search",
  copilot_createDirectory: "create_directory",
  copilot_editFiles: "edit_files",
  copilot_switchAgent: "switch_agent",
  copilot_resolveMemoryFileUri: "resolve_memory_file_uri",
  copilot_sessionStoreSql: "session_store_sql",
};

/** `ResponseModelState.Cancelled` in VS Code's `chatService.ts`. */
const RESPONSE_CANCELLED = 2;
/** `ToolConfirmKind.Denied` in VS Code's `chatService.ts`. */
const TOOL_DENIED = 0;

/** A tool call the Copilot extension recorded in `result.metadata`, which
 * keeps the model's arguments and the result text the model read. VS Code's
 * own tool record keeps neither. */
interface RecordedToolCall {
  name: string | null;
  arguments: Json | undefined;
}

interface TurnMetadata {
  calls: Map<string, RecordedToolCall>;
  results: Map<string, string>;
}

/**
 * Copilot Chat in VS Code session format.
 *
 * VS Code stores each local chat session under the window's storage: a
 * workspace's `workspaceStorage/<id>/chatSessions/<session id>.jsonl`, or an
 * empty window's `globalStorage/emptyWindowChatSessions/`. VS Code 1.109 and
 * later write the `.jsonl` file as a mutation log: the first line is
 * `{ kind: 0, v: <session> }`, and each later line sets (`kind: 1`), pushes to
 * (`kind: 2`), or deletes (`kind: 3`) the value at path `k`. Replaying the log
 * rebuilds the same session object that older builds wrote whole to
 * `<session id>.json`, so both files parse the same way after loading.
 *
 * Each request is one turn: the user's message, then the response parts in
 * order. Markdown and thinking parts become text and thinking blocks, and each
 * serialized tool invocation becomes a `tool_use` block followed by a tool
 * message with its result. The Copilot extension's `result.metadata` adds the
 * arguments and result text of each tool call by ID.
 *
 * Usage is per request and partial. `completionTokens` sums the output of
 * every model call in the turn, but `promptTokens` is only the last call's
 * prompt, cache reads included, and no cache split is written. Requests from
 * builds that predate those fields carry no usage at all.
 */
export function parseVscodeCopilotSession(
  fallbackId: string,
  content: string,
  context: VscodeCopilotContext = {},
): ParsedSession {
  const issues: Issue[] = [];
  const unknownTypes: UnknownTypes = new Map();
  // Parts are read after the log is replayed, so they have no line number.
  const unknownParts = new Map<string, number>();
  const { state, storage } = loadSession(content, issues, unknownTypes);
  const root: JsonObject = state ?? {};
  const requests = Array.isArray(root.requests) ? root.requests : [];

  const messages: NormalizedMessage[] = [];
  const efforts: string[] = [];
  const modelWeights = new Map<string, { output: number; messages: number }>();
  let firstUserText: string | null = null;
  let seq = 0;

  const push = (
    role: Role,
    raw: Json,
    blocks: NormalizedBlock[],
    timestamp: string | null,
    fields: { model?: string | null; usage?: TokenUsage | null; sourceUuid?: string | null } = {},
  ): void => {
    messages.push({
      seq,
      sourceUuid: fields.sourceUuid ?? null,
      parentSourceUuid: null,
      role,
      model: fields.model ?? null,
      stopReason: null,
      timestamp,
      usage: fields.usage ?? null,
      raw,
      blocks,
    });
    seq += 1;
  };

  for (const request of requests) {
    if (!isObject(request)) {
      continue;
    }
    const requestId = asString(request.requestId);
    const requestTime = epochIso(request.timestamp);
    const endTime = responseEndTime(request) ?? requestTime;
    const parts = responseParts(request.response);
    const model = turnModel(request, parts);
    const effort = asString(get(request.modelConfiguration, "reasoningEffort"));
    if (effort != null) {
      efforts.push(effort);
    }
    const metadata = turnMetadata(get(request.result, "metadata"));

    const { response: _response, ...userRecord } = request;
    const userText = messageText(request.message);
    if (userText !== "") {
      firstUserText ??= userText;
    }
    // A request VS Code sent on its own, such as a background terminal
    // notice, is not something the user typed.
    push(
      request.isSystemInitiated === true ? "system" : "user",
      userRecord,
      userText === "" ? [] : [block(0, "text", { text: userText })],
      requestTime,
      { sourceUuid: requestId },
    );

    // Each assistant message holds the parts read since the previous message,
    // so the raw records of a turn's messages together hold its whole response.
    let blocks: NormalizedBlock[] = [];
    let consumed: Json[] = [];
    let text = "";
    let last = requestTime;
    const stamp = (value: string | null): string | null => {
      const time = value ?? endTime;
      last = time != null && (last == null || time > last) ? time : last;
      return last;
    };
    const flushText = (): void => {
      if (text.trim() !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
      text = "";
    };
    const emitAssistant = (timestamp: string | null, usage: TokenUsage | null = null): void => {
      push("assistant", { requestId, response: consumed }, blocks, stamp(timestamp), {
        model,
        usage,
      });
      if (model != null) {
        const weight = modelWeights.get(model) ?? { output: 0, messages: 0 };
        weight.output += usage?.output ?? 0;
        weight.messages += 1;
        modelWeights.set(model, weight);
      }
      blocks = [];
      consumed = [];
    };

    for (const part of parts) {
      if (typeof part === "string") {
        // The oldest builds stored a whole response as one string.
        text += part;
        consumed.push(part);
        continue;
      }
      if (!isObject(part)) {
        continue;
      }
      const kind = asString(part.kind);
      if (kind == null) {
        // A markdown part is stored as the bare markdown string object.
        const value = asString(part.value);
        if (value != null) {
          text += value;
        } else {
          countPart(unknownParts, "response part without a kind");
        }
        consumed.push(part);
        continue;
      }
      switch (kind) {
        case "markdownContent":
        case "markdownVuln":
          text += asString(get(part.content, "value")) ?? "";
          consumed.push(part);
          break;
        case "inlineReference":
          text += inlineReferenceName(part);
          consumed.push(part);
          break;
        case "thinking": {
          flushText();
          const thought = thinkingText(part.value);
          if (thought.trim() !== "") {
            blocks.push(block(blocks.length, "thinking", { text: thought }));
          }
          consumed.push(part);
          break;
        }
        case "toolInvocationSerialized": {
          flushText();
          const toolCallId = asString(part.toolCallId);
          const recorded = lookup(metadata.calls, toolCallId);
          const calledAt = epochIso(part.startedAt);
          const toolUse = block(blocks.length, "tool_use", {
            toolName: toolName(part, recorded),
            toolUseId: toolCallId,
            toolInput: toolInput(part, recorded),
            ...(calledAt == null ? {} : { calledAt }),
          });
          blocks.push(toolUse);
          emitAssistant(calledAt);
          const result = toolResult(part, lookup(metadata.results, toolCallId));
          if (result != null && toolCallId != null) {
            push(
              "tool",
              { requestId, response: [part] },
              [
                block(0, "tool_result", {
                  toolUseId: toolCallId,
                  toolResult: result.text,
                  isError: result.isError,
                }),
              ],
              stamp(epochIso(part.completedAt) ?? calledAt),
            );
          } else {
            consumed.push(part);
          }
          break;
        }
        default:
          if (!IGNORED_PART_KINDS.has(kind)) {
            countPart(unknownParts, `response part "${kind}"`);
          }
          consumed.push(part);
      }
    }
    flushText();
    const usage = turnUsage(request);
    if (blocks.length > 0 || consumed.length > 0 || usage != null) {
      emitAssistant(endTime, usage);
    }

    const errorMessage = asString(get(get(request.result, "errorDetails"), "message"));
    if (isCancelled(request)) {
      push(
        "other",
        { requestId, canceled: true },
        [block(0, "text", { text: "Canceled" })],
        stamp(endTime),
      );
    } else if (errorMessage != null && errorMessage !== "") {
      push(
        "other",
        { requestId, errorDetails: get(request.result, "errorDetails") ?? null },
        [block(0, "text", { text: errorMessage })],
        stamp(endTime),
      );
    }
  }

  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));
  for (const [kind, count] of unknownParts) {
    issues.push({
      code: "unknown_record_type",
      lineNo: null,
      error: `unknown record type ${kind} on ${count} part(s); kept in raw`,
      rawLine: null,
    });
  }

  const totals = emptyUsage();
  for (const message of messages) {
    if (message.usage != null) {
      totals.input += message.usage.input;
      totals.output += message.usage.output;
    }
  }
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter((value): value is string => value != null)
    .sort();
  const location = workspaceLocation(context.workspace ?? null, asString(root.workingDirectory));
  const customTitle = asString(root.customTitle) ?? asString(root.computedTitle);

  const normalized: NormalizedSession = {
    tool: "vscode_copilot",
    sourceSessionId: asString(root.sessionId) ?? fallbackId,
    projectPath: location.projectPath,
    title:
      customTitle != null && customTitle.trim() !== ""
        ? customTitle.trim()
        : firstUserText == null
          ? null
          : preview(firstUserText.trim(), 120),
    cwd: location.cwd,
    gitBranch: asString(get(root.repoData, "localBranch")),
    model: sessionModel(modelWeights),
    reasoningEffort: summarizeReasoningEfforts(efforts),
    reasoningEffortLevels: reasoningEffortLevels(efforts),
    cliVersion: null,
    startedAt: epochIso(root.creationDate) ?? timestamps[0] ?? null,
    endedAt: timestamps.at(-1) ?? null,
    isArchived: false,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: rawMetaFrom(root, storage, context.workspace ?? null),
    totals,
    estReasoningTokens: 0,
    reasoningSource: "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

type Storage = "log" | "json";

/** Read a session file in either storage format. A mutation log is told
 * apart by its entries' numeric `kind`; a flat file is one JSON object. */
function loadSession(
  content: string,
  issues: Issue[],
  unknownTypes: UnknownTypes,
): { state: JsonObject | null; storage: Storage } {
  const lines = content.split(/\n/);
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) {
    return { state: null, storage: "json" };
  }
  if (filled.length === 1) {
    const only = parseJsonLine(filled[0] ?? "", lines.indexOf(filled[0] ?? "") + 1, issues);
    if (isObject(only) && typeof only.kind !== "number") {
      return { state: only, storage: "json" };
    }
    if (!isObject(only)) {
      return { state: null, storage: "json" };
    }
  } else if (!isLogEntry(filled[0] ?? "")) {
    // VS Code writes a flat file on one line; a reformatted copy spans many.
    try {
      const whole = JSON.parse(content) as Json;
      if (isObject(whole)) {
        return { state: whole, storage: "json" };
      }
    } catch {
      // Not one JSON document either: replay it and report the bad lines.
    }
  }
  return { state: replayLog(lines, issues, unknownTypes), storage: "log" };
}

function isLogEntry(line: string): boolean {
  try {
    const entry = JSON.parse(line) as Json;
    return isObject(entry) && typeof entry.kind === "number";
  } catch {
    return false;
  }
}

/** Rebuild the session from VS Code's `ObjectMutationLog`
 * (`src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts`). A
 * line that cannot be applied is reported and skipped, so one bad entry
 * never loses the rest of the session. */
function replayLog(
  lines: string[],
  issues: Issue[],
  unknownTypes: UnknownTypes,
): JsonObject | null {
  let state: JsonObject | null = null;
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const entry = parseJsonLine(line, lineNo, issues);
    if (entry === undefined) {
      continue;
    }
    if (!isObject(entry) || typeof entry.kind !== "number") {
      countUnknown(unknownTypes, "log entry without a numeric kind", lineNo);
      continue;
    }
    if (entry.kind === 0) {
      state = isObject(entry.v) ? entry.v : null;
      continue;
    }
    if (entry.kind !== 1 && entry.kind !== 2 && entry.kind !== 3) {
      countUnknown(unknownTypes, `log entry kind ${entry.kind}`, lineNo);
      continue;
    }
    const path = Array.isArray(entry.k) ? entry.k : null;
    if (state == null || path == null || path.length === 0) {
      notApplied(issues, lineNo, line, "log entry has no initial state or path to apply to");
      continue;
    }
    const parent = walk(state, path.slice(0, -1));
    const key = path.at(-1);
    if (parent == null || (typeof key !== "string" && typeof key !== "number")) {
      notApplied(issues, lineNo, line, "log entry path does not exist in the session");
      continue;
    }
    if (entry.kind === 2) {
      const existing = read(parent, key);
      const array: Json[] = Array.isArray(existing) ? existing : [];
      if (typeof entry.i === "number" && entry.i >= 0) {
        array.length = Math.min(array.length, entry.i);
      }
      if (Array.isArray(entry.v)) {
        array.push(...entry.v);
      }
      write(parent, key, array);
    } else {
      write(parent, key, entry.kind === 1 ? (entry.v ?? null) : undefined);
    }
  }
  return state;
}

function countPart(unknownParts: Map<string, number>, kind: string): void {
  unknownParts.set(kind, (unknownParts.get(kind) ?? 0) + 1);
}

function notApplied(issues: Issue[], lineNo: number, line: string, error: string): void {
  issues.push({ code: "unparsed_line", lineNo, error, rawLine: line });
}

type Container = JsonObject | Json[];

function walk(state: JsonObject, path: Json[]): Container | null {
  let current: Container = state;
  for (const key of path) {
    if (typeof key !== "string" && typeof key !== "number") {
      return null;
    }
    const next = read(current, key);
    if (!isObject(next) && !Array.isArray(next)) {
      return null;
    }
    current = next;
  }
  return current;
}

function read(container: Container, key: string | number): Json | undefined {
  if (Array.isArray(container)) {
    return typeof key === "number" ? container[key] : undefined;
  }
  return Object.hasOwn(container, String(key)) ? container[String(key)] : undefined;
}

function write(container: Container, key: string | number, value: Json | undefined): void {
  if (Array.isArray(container)) {
    if (typeof key === "number") {
      container[key] = value ?? null;
    }
    return;
  }
  if (value === undefined) {
    delete container[String(key)];
  } else {
    container[String(key)] = value;
  }
}

function responseParts(response: Json | undefined): Json[] {
  if (Array.isArray(response)) {
    return response;
  }
  return typeof response === "string" ? [response] : [];
}

/** `message` is an `IParsedChatRequest` (`{ text, parts }`) or, in the oldest
 * files, a plain string. */
function messageText(message: Json | undefined): string {
  if (typeof message === "string") {
    return message;
  }
  return asString(get(message, "text")) ?? "";
}

function thinkingText(value: Json | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("");
  }
  return "";
}

/** The name VS Code shows for a file or symbol link inside response text. */
function inlineReferenceName(part: JsonObject): string {
  const name = asString(part.name);
  if (name != null && name !== "") {
    return name;
  }
  const reference = part.inlineReference;
  const symbol = asString(get(reference, "name"));
  if (symbol != null) {
    return symbol;
  }
  const path = uriPath(get(reference, "uri") ?? reference);
  return path == null ? "" : (path.split("/").filter(Boolean).at(-1) ?? path);
}

/** Where the request's response finished: the completion VS Code recorded,
 * else the request time plus the elapsed time it measured. */
function responseEndTime(request: JsonObject): string | null {
  const completedAt = epochIso(get(request.modelState, "completedAt"));
  if (completedAt != null) {
    return completedAt;
  }
  const started = finiteNumber(request.timestamp);
  const elapsed =
    finiteNumber(get(get(request.result, "timings"), "totalElapsed")) ??
    finiteNumber(request.elapsedMs);
  if (started != null && elapsed != null && elapsed >= 0) {
    return epochIso(started + elapsed);
  }
  return epochIso(request.responseTimestamp);
}

function isCancelled(request: JsonObject): boolean {
  return (
    get(request.modelState, "value") === RESPONSE_CANCELLED ||
    (request.modelState === undefined && request.isCanceled === true)
  );
}

/** VS Code names a model `<vendor>/<id>`, or `<vendor>/<group>/<id>` for some
 * providers. Pricing matches on the provider's own model ID. */
export function vscodeModelId(identifier: string | null): string | null {
  if (identifier == null || identifier.trim() === "") {
    return null;
  }
  const slash = identifier.indexOf("/");
  if (slash < 0) {
    return identifier;
  }
  if (identifier.slice(0, slash) === "copilot") {
    return identifier.slice(slash + 1);
  }
  return identifier.slice(identifier.lastIndexOf("/") + 1) || identifier;
}

/** The model that served a turn. The "auto" model names the model it routed
 * to in an `autoModeResolution` part on current builds, and the Copilot
 * extension records the endpoint's answer in `result.metadata.resolvedModel`. */
function turnModel(request: JsonObject, parts: Json[]): string | null {
  const selected = vscodeModelId(asString(request.modelId));
  if (selected != null && selected !== "auto") {
    return selected;
  }
  let routed: string | null = null;
  for (const part of parts) {
    if (get(part, "kind") === "autoModeResolution") {
      routed = vscodeModelId(asString(get(get(part, "resolved"), "id"))) ?? routed;
    }
  }
  const resolved = vscodeModelId(asString(get(get(request.result, "metadata"), "resolvedModel")));
  return routed ?? resolved ?? selected;
}

/** Token counts VS Code wrote for the turn: output summed over every model
 * call, and the last call's prompt. Null when the build wrote neither. */
function turnUsage(request: JsonObject): TokenUsage | null {
  const prompt = tokenCount(request.promptTokens);
  const completion = tokenCount(request.completionTokens);
  if (prompt == null && completion == null) {
    return null;
  }
  return { ...emptyUsage(), input: prompt ?? 0, output: completion ?? 0 };
}

function turnMetadata(metadata: Json | undefined): TurnMetadata {
  const calls = new Map<string, RecordedToolCall>();
  const results = new Map<string, string>();
  const rounds = get(metadata, "toolCallRounds");
  for (const round of Array.isArray(rounds) ? rounds : []) {
    const toolCalls = get(round, "toolCalls");
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
      const id = asString(get(call, "id"));
      if (id == null) {
        continue;
      }
      const args = get(call, "arguments");
      calls.set(id, {
        name: asString(get(call, "name")),
        arguments: typeof args === "string" ? parseArguments(args) : args,
      });
    }
  }
  const recorded = get(metadata, "toolCallResults");
  if (isObject(recorded)) {
    for (const [id, result] of Object.entries(recorded)) {
      const text = collectText(result).join("");
      if (text !== "") {
        results.set(id, text);
      }
    }
  }
  return { calls, results };
}

/** The extension adds a `__vscode-<n>` suffix to a call ID to keep it unique,
 * and may record either form. */
function lookup<T>(map: Map<string, T>, id: string | null): T | undefined {
  if (id == null) {
    return undefined;
  }
  const exact = map.get(id);
  if (exact !== undefined) {
    return exact;
  }
  const base = id.split("__vscode-")[0] ?? id;
  for (const [key, value] of map) {
    if ((key.split("__vscode-")[0] ?? key) === base) {
      return value;
    }
  }
  return undefined;
}

function parseArguments(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

/** Text a tool result holds. A `LanguageModelToolResult` has `content` parts
 * with a string `value`, and a prompt-tsx part nests `text` pieces in a tree. */
function collectText(value: Json | undefined, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
    }
  } else if (isObject(value)) {
    if (typeof value.value === "string") {
      out.push(value.value);
    } else if (typeof value.text === "string") {
      out.push(value.text);
    } else {
      for (const key of ["content", "node", "children", "value"]) {
        if (value[key] !== undefined) {
          collectText(value[key], out);
        }
      }
    }
  }
  return out;
}

/** MCP tools are renamed `mcp__<server>__<tool>` so `classifyTool` sees
 * them. Copilot's own tools take the name the model calls them by. */
function toolName(part: JsonObject, recorded: RecordedToolCall | undefined): string | null {
  const toolId = asString(part.toolId);
  const source = part.source;
  if (isObject(source) && source.type === "mcp") {
    const label = asString(source.label);
    const serverLabel = asString(source.serverLabel);
    const server = label ?? serverLabel;
    const id = toolId ?? recorded?.name ?? null;
    if (server != null && server !== "" && id != null) {
      return `mcp__${server.replace(/\s+/g, "-")}__${mcpBaseName(id, [label, serverLabel])}`;
    }
  }
  if (recorded?.name != null && recorded.name !== "") {
    return recorded.name;
  }
  if (toolId == null) {
    return null;
  }
  return Object.hasOwn(CONTRIBUTED_TOOL_NAMES, toolId)
    ? (CONTRIBUTED_TOOL_NAMES[toolId] ?? toolId)
    : toolId;
}

/** VS Code names an MCP tool `mcp_<server prefix>_<tool>`, where the prefix
 * is the server name lowercased, cut to fit, and given a number when two
 * servers share it (`McpPrefixGenerator` in VS Code's `mcpServer.ts`). */
export function mcpBaseName(toolId: string, serverNames: (string | null)[]): string {
  if (!toolId.startsWith("mcp_")) {
    return toolId;
  }
  const rest = toolId.slice("mcp_".length);
  for (const name of serverNames) {
    if (name == null || name === "") {
      continue;
    }
    const safe = name
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .slice(0, 13);
    for (let length = safe.length; length > 0; length -= 1) {
      const match = new RegExp(`^${escapeRegExp(safe.slice(0, length))}\\d*_`).exec(rest);
      if (match != null && match[0].length < rest.length) {
        return rest.slice(match[0].length);
      }
    }
  }
  const separator = rest.indexOf("_");
  return separator >= 0 && separator < rest.length - 1 ? rest.slice(separator + 1) : rest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** VS Code's serialized invocation keeps no arguments, so they come from the
 * extension's record of the call, else from what the tool showed the user. */
function toolInput(part: JsonObject, recorded: RecordedToolCall | undefined): Json | undefined {
  if (recorded?.arguments !== undefined) {
    return recorded.arguments;
  }
  const data = part.toolSpecificData;
  switch (asString(get(data, "kind"))) {
    case "input":
      return get(data, "rawInput");
    case "terminal": {
      const commandLine = get(data, "commandLine");
      const command =
        asString(get(commandLine, "userEdited")) ??
        asString(get(commandLine, "toolEdited")) ??
        asString(get(commandLine, "original")) ??
        asString(get(data, "command"));
      return command == null ? undefined : { command };
    }
    case "subagent": {
      const input: JsonObject = {};
      for (const key of ["agentName", "description", "prompt"]) {
        const value = asString(get(data, key));
        if (value != null) {
          input[key] = value;
        }
      }
      return Object.keys(input).length === 0 ? undefined : input;
    }
  }
  const detailInput = asString(get(part.resultDetails, "input"));
  return detailInput == null ? undefined : parseArguments(detailInput);
}

/** The result as the model read it when the extension recorded it, else the
 * output VS Code kept for display. Null for a call that never finished. */
function toolResult(
  part: JsonObject,
  recorded: string | undefined,
): { text: string; isError: boolean } | null {
  const resultError = part.resultError;
  const confirmed = part.isConfirmed;
  const denied = confirmed === false || (isObject(confirmed) && confirmed.type === TOOL_DENIED);
  const isError =
    denied ||
    (typeof resultError === "string" && resultError !== "") ||
    resultError === true ||
    get(part.resultDetails, "isError") === true;
  const text =
    recorded ??
    displayedOutput(part) ??
    (typeof resultError === "string" && resultError !== "" ? resultError : null) ??
    markdownValue(part.pastTenseMessage);
  if (text == null && part.isComplete !== true && !isError) {
    return null;
  }
  return { text: text ?? "", isError };
}

function displayedOutput(part: JsonObject): string | null {
  const details = part.resultDetails;
  const output = get(details, "output");
  if (Array.isArray(output)) {
    const texts = output
      .map((item) =>
        get(item, "type") === "embed" && get(item, "isText") === true
          ? asString(get(item, "value"))
          : get(item, "type") === "ref"
            ? uriPath(get(item, "uri"))
            : null,
      )
      .filter((value): value is string => value != null);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  if (Array.isArray(details)) {
    const paths = details
      .map((item) => uriPath(get(item, "uri") ?? item))
      .filter((value): value is string => value != null);
    if (paths.length > 0) {
      return paths.join("\n");
    }
  }
  const data = part.toolSpecificData;
  switch (asString(get(data, "kind"))) {
    case "terminal":
      return asString(get(get(data, "terminalCommandOutput"), "text"));
    case "subagent":
      return asString(get(data, "result"));
    case "simpleToolInvocation":
      return asString(get(data, "output"));
  }
  return null;
}

function markdownValue(value: Json | undefined): string | null {
  if (typeof value === "string") {
    return value === "" ? null : value;
  }
  const text = asString(get(value, "value"));
  return text == null || text === "" ? null : text;
}

/** A file path from a serialized URI: `UriComponents` or a URI string. Remote
 * windows keep the remote path, which is the project's path on that host. */
export function uriPath(value: Json | undefined): string | null {
  let path: string | null = null;
  if (typeof value === "string") {
    try {
      path = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  } else if (isObject(value)) {
    path = asString(value.path);
  }
  if (path == null || path === "") {
    return null;
  }
  // `file:///c%3A/Users/...` names a Windows drive.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

function workspaceLocation(
  workspace: Json | null,
  workingDirectory: string | null,
): { projectPath: string | null; cwd: string | null } {
  const working = uriPath(workingDirectory ?? undefined);
  if (working != null) {
    return { projectPath: working, cwd: working };
  }
  const folder = uriPath(get(workspace ?? undefined, "folder"));
  if (folder != null) {
    return { projectPath: folder, cwd: folder };
  }
  // A multi-root workspace has no single working directory; the folder that
  // holds its `.code-workspace` file stands in for the project.
  const file = uriPath(get(workspace ?? undefined, "workspace"));
  if (file != null) {
    const slash = file.lastIndexOf("/");
    return { projectPath: slash > 0 ? file.slice(0, slash) : file, cwd: null };
  }
  return { projectPath: null, cwd: null };
}

/** The model that did the most work: most output tokens, else most replies. */
function sessionModel(weights: Map<string, { output: number; messages: number }>): string | null {
  let best: { model: string; output: number; messages: number } | null = null;
  for (const [model, weight] of weights) {
    if (
      best == null ||
      weight.output > best.output ||
      (weight.output === best.output && weight.messages > best.messages)
    ) {
      best = { model, ...weight };
    }
  }
  return best?.model ?? null;
}

function rawMetaFrom(root: JsonObject, storage: Storage, workspace: Json | null): Json {
  const meta: JsonObject = { storage };
  for (const key of [
    "version",
    "initialLocation",
    "responderUsername",
    "customTitle",
    "workingDirectory",
    "hasPendingEdits",
    "sessionCostInfo",
  ]) {
    const value = root[key];
    if (value !== undefined) {
      meta[key] = value;
    }
  }
  const repoData = root.repoData;
  if (isObject(repoData)) {
    // Working-tree diffs can be large and are not session metadata.
    const { diffs: _diffs, ...repo } = repoData;
    meta.repoData = repo;
  }
  if (workspace != null) {
    meta.workspace = workspace;
  }
  return meta;
}

function finiteNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenCount(value: Json | undefined): number | null {
  const number = finiteNumber(value);
  return number == null || number < 0 ? null : Math.floor(number);
}

/** VS Code records times as epoch milliseconds. */
function epochIso(value: Json | undefined): string | null {
  const ms = finiteNumber(value);
  if (ms == null || ms <= 0) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
