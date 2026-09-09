import { canonicalJson } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type ParsedSession,
  type Role,
} from "../model.ts";
import { preview } from "../tools.ts";

type JsonObject = { [key: string]: Json };

export function parseCodexSession(
  fallbackId: string,
  content: string,
  titles: ReadonlyMap<string, string>,
): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  let sourceSessionId = fallbackId;
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let model: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let title: string | null = null;
  let isSubagent = false;
  let parentThreadId: string | null = null;
  let agentId: string | null = null;
  let agentType: string | null = null;
  let spawnDepth: number | null = null;
  let totals = emptyUsage();
  let sawTokenCount = false;
  let rawMeta: Json = null;
  let seq = 0;

  for (const [index, line] of content.split(/\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }

    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch (error) {
      issues.push({
        lineNo: index + 1,
        error: error instanceof Error ? error.message : String(error),
        rawLine: line,
      });
      continue;
    }

    const typ = asString(get(value, "type")) ?? "";
    const timestamp = asString(get(value, "timestamp"));
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    const payload = get(value, "payload") ?? null;

    if (typ === "session_meta") {
      sourceSessionId = asString(get(payload, "id")) ?? sourceSessionId;
      cwd = asString(get(payload, "cwd")) ?? cwd;
      cliVersion = asString(get(payload, "cli_version")) ?? cliVersion;
      const source = get(payload, "source");
      const subagentSource = get(source, "subagent");
      const threadSpawn = get(subagentSource, "thread_spawn");
      parentThreadId =
        asString(get(payload, "parent_thread_id")) ??
        asString(get(threadSpawn, "parent_thread_id")) ??
        parentThreadId;
      isSubagent = isSubagent || subagentSource !== undefined || parentThreadId != null;
      const nickname =
        asString(get(payload, "agent_nickname")) ?? asString(get(threadSpawn, "agent_nickname"));
      const role =
        asString(get(payload, "agent_role")) ??
        asString(get(threadSpawn, "agent_role")) ??
        asString(subagentSource);
      agentId = nickname ?? agentId;
      agentType = role ?? agentType;
      spawnDepth =
        asInteger(get(threadSpawn, "depth")) ??
        asInteger(get(payload, "spawn_depth")) ??
        spawnDepth;
      rawMeta = payload;
    } else if (typ === "turn_context") {
      model = asString(get(payload, "model")) ?? model;
      cwd ??= asString(get(payload, "cwd"));
    } else if (typ === "event_msg" && asString(get(payload, "type")) === "token_count") {
      const nested = get(get(payload, "info"), "total_token_usage");
      const source = nested ?? payload;
      sawTokenCount = true;
      const cached = getInteger(source, "cached_input_tokens");
      totals = {
        input: Math.max(0, getInteger(source, "input_tokens") - cached),
        output: getInteger(source, "output_tokens"),
        cacheRead: cached,
        cacheCreation: 0,
        cacheCreation1h: 0,
        reasoning: getInteger(source, "reasoning_output_tokens"),
      };
    } else if (typ === "response_item") {
      const message = parseItem(value, payload, seq, title);
      if (message != null) {
        if (message.nextTitle != null) {
          title = message.nextTitle;
        }
        messages.push(message.message);
        seq += 1;
      }
    }
  }

  title = titles.get(sourceSessionId) ?? title;

  return {
    session: {
      tool: "codex",
      sourceSessionId,
      projectPath: cwd,
      title,
      cwd,
      gitBranch: null,
      model,
      cliVersion,
      startedAt,
      endedAt,
      isArchived: false,
      isSubagent,
      rootSourceSessionId: parentThreadId,
      spawnToolUseId: null,
      agentId: agentId ?? (isSubagent ? sourceSessionId : null),
      agentType,
      spawnDepth,
      rawMeta,
      totals,
      estReasoningTokens: 0,
      reasoningSource: sawTokenCount ? "reported" : "none",
      messages,
    },
    issues,
  };
}

interface ParsedItem {
  message: NormalizedMessage;
  nextTitle: string | null;
}

function parseItem(
  line: Json,
  payload: Json,
  seq: number,
  currentTitle: string | null,
): ParsedItem | null {
  const payloadType = asString(get(payload, "type")) ?? "";
  const timestamp = asString(get(line, "timestamp"));
  const mk = (role: Role, block: NormalizedBlock): ParsedItem => ({
    nextTitle: null,
    message: {
      seq,
      sourceUuid: null,
      parentSourceUuid: null,
      role,
      model: null,
      stopReason: null,
      timestamp,
      usage: null,
      raw: line,
      blocks: [block],
    },
  });

  if (payloadType === "message") {
    const role = messageRole(asString(get(payload, "role")));
    const text = collectText(get(payload, "content"));
    const parsed = mk(role, {
      ordinal: 0,
      blockType: "text",
      text,
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    });
    if (role === "user" && currentTitle == null && text !== "") {
      parsed.nextTitle = preview(text.trim(), 120);
    }
    return parsed;
  }

  if (payloadType === "reasoning") {
    const summary = collectText(get(payload, "summary")).trim();
    return mk("assistant", {
      ordinal: 0,
      blockType: "thinking",
      text: summary === "" ? collectText(get(payload, "content")) : summary,
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    });
  }

  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "tool_search_call" ||
    payloadType === "mcp_tool_call"
  ) {
    return mk("assistant", {
      ordinal: 0,
      blockType: "tool_use",
      text: null,
      toolName: asString(get(payload, "name")),
      toolUseId: asString(get(payload, "call_id")),
      toolInput: callInput(payload),
      toolResult: null,
      isError: null,
    });
  }

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "tool_search_output"
  ) {
    return mk("tool", {
      ordinal: 0,
      blockType: "tool_result",
      text: null,
      toolName: null,
      toolUseId: asString(get(payload, "call_id")),
      toolInput: undefined,
      toolResult: stringify(get(payload, "output")),
      isError: null,
    });
  }

  if (payloadType === "web_search_call") {
    return mk("assistant", {
      ordinal: 0,
      blockType: "web_search",
      text: null,
      toolName: "web_search",
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    });
  }

  return mk("other", {
    ordinal: 0,
    blockType: "other",
    text: canonicalJson(payload),
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
  });
}

function messageRole(role: string | null): Role {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function collectText(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        const text = asString(get(item, "text"));
        return text == null ? [] : [text];
      })
      .join("\n");
  }
  return "";
}

function stringify(value: Json | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    return canonicalJson(value);
  }
  return "";
}

function callInput(payload: Json): Json | undefined {
  if (hasKey(payload, "arguments")) {
    return get(payload, "arguments");
  }
  if (hasKey(payload, "input")) {
    return get(payload, "input");
  }
  return undefined;
}

function get(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return value[key];
}

function hasKey(value: Json, key: string): boolean {
  return isObject(value) && Object.hasOwn(value, key);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function getInteger(value: Json | undefined, key: string): number {
  return asInteger(get(value, key)) ?? 0;
}
