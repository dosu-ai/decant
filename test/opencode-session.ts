import { emptyUsage, type NormalizedMessage, type ParsedSession } from "../src/model.ts";

export interface SyntheticRequest {
  model: string;
  /** Cost as OpenCode would record it on the assistant row. */
  cost: number;
  input: number;
  output: number;
}

/** An OpenCode session as the parser would emit it, built by hand so cost
 * tests do not depend on the parser: one prompt, one assistant row per
 * request with the recorded cost in `raw.cost`. */
export function syntheticOpenCodeSession(id: string, requests: SyntheticRequest[]): ParsedSession {
  const text = (ordinal: number, value: string) => ({
    ordinal,
    blockType: "text" as const,
    text: value,
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
  });
  const messages: NormalizedMessage[] = [
    {
      seq: 0,
      sourceUuid: `${id}_u`,
      parentSourceUuid: null,
      role: "user",
      model: null,
      stopReason: null,
      timestamp: "2026-10-12T06:20:00.000Z",
      usage: null,
      raw: { id: `${id}_u`, type: "user", seq: 1, text: "hello" },
      blocks: [text(0, "hello")],
    },
  ];
  const totals = emptyUsage();
  for (const [index, request] of requests.entries()) {
    totals.input += request.input;
    totals.output += request.output;
    messages.push({
      seq: index + 1,
      sourceUuid: `${id}_a${index}`,
      parentSourceUuid: null,
      role: "assistant",
      model: request.model,
      stopReason: "stop",
      timestamp: `2026-10-12T06:20:0${index + 1}.000Z`,
      usage: { ...emptyUsage(), input: request.input, output: request.output },
      raw: {
        id: `${id}_a${index}`,
        type: "assistant",
        seq: index + 2,
        cost: request.cost,
        model: { providerID: "example", id: request.model },
      },
      blocks: [text(0, "ok")],
    });
  }
  return {
    session: {
      tool: "opencode",
      sourceSessionId: id,
      projectPath: "/decant-fixture/example",
      title: "hello",
      cwd: "/decant-fixture/example",
      gitBranch: null,
      model: requests[0]?.model ?? null,
      reasoningEffort: null,
      reasoningEffortLevels: [],
      cliVersion: "2.0.27",
      startedAt: "2026-10-12T06:20:00.000Z",
      endedAt: "2026-10-12T06:21:00.000Z",
      isArchived: false,
      isSubagent: false,
      rootSourceSessionId: null,
      spawnToolUseId: null,
      agentId: null,
      agentType: "build",
      spawnDepth: null,
      rawMeta: { model_provider: "example" },
      totals,
      estReasoningTokens: 0,
      reasoningSource: "none",
      messages,
    },
    issues: [],
  };
}
