import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { sync } from "../src/ingest.ts";
import {
  assertDatabaseIntegrity,
  type CanonicalSnapshot,
  captureCanonicalSnapshot,
  captureFtsResults,
  type FileMutation,
  isolatedConfig,
  runDifferentialScenario,
  type ScenarioStep,
  SOURCE_ROOTS,
} from "./helpers/ingest-oracle.ts";

const CWD = "/home/dev/work/app";
const CLAUDE_PROJECT = `${SOURCE_ROOTS.claude}/-home-dev-work-app`;
const CLAUDE_MODEL = "claude-sonnet-5";

type Rec = Record<string, unknown>;

function jsonl(records: Rec[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

function rowsOf(snapshot: CanonicalSnapshot, table: keyof CanonicalSnapshot, session?: string) {
  return snapshot[table].filter((row) => session == null || row.session_key === session);
}

function sessionRow(snapshot: CanonicalSnapshot, key: string): Rec {
  const row = snapshot.session.find((s) => `${s.tool}:${s.source_session_id}` === key);
  expect(row).toBeDefined();
  return row as Rec;
}

// ---------------------------------------------------------------- Claude Code

function claudePath(session: string): string {
  return `${CLAUDE_PROJECT}/${session}.jsonl`;
}

function cUser(
  session: string,
  uuid: string,
  parent: string | null,
  at: string,
  content: unknown,
  extra: Rec = {},
): Rec {
  return {
    type: "user",
    uuid,
    parentUuid: parent,
    sessionId: session,
    timestamp: at,
    cwd: CWD,
    gitBranch: "main",
    version: "2.1.0",
    message: { role: "user", content },
    ...extra,
  };
}

interface AssistantChunk {
  requestId?: string;
  messageId?: string;
  usage?: Rec | null;
  content: unknown[];
  stop?: string | null;
  extra?: Rec;
}

function cAssistant(
  session: string,
  uuid: string,
  parent: string | null,
  at: string,
  chunk: AssistantChunk,
): Rec {
  return {
    type: "assistant",
    uuid,
    parentUuid: parent,
    sessionId: session,
    timestamp: at,
    cwd: CWD,
    gitBranch: "main",
    version: "2.1.0",
    ...(chunk.requestId == null ? {} : { requestId: chunk.requestId }),
    message: {
      ...(chunk.messageId == null ? {} : { id: chunk.messageId }),
      role: "assistant",
      model: CLAUDE_MODEL,
      stop_reason: chunk.stop ?? null,
      ...(chunk.usage === null ? {} : { usage: chunk.usage ?? usage(100, 20) }),
      content: chunk.content,
    },
    ...chunk.extra,
  };
}

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0): Rec {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function toolResult(id: string, content: string, isError = false): Rec {
  return { type: "tool_result", tool_use_id: id, is_error: isError, content };
}

function at(minute: number, second = 0): string {
  return `2026-11-01T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function append(path: string, records: Rec[]): FileMutation {
  return { op: "append", path, content: jsonl(records) };
}

function write(path: string, records: Rec[]): FileMutation {
  return { op: "write", path, content: jsonl(records) };
}

describe("incremental ingest matches a fresh ingest: Claude Code", () => {
  test("a live session appended turn by turn, with tool calls answered in the next chunk", () => {
    const S = "c1a00000-0000-4000-8000-000000000001";
    const path = claudePath(S);
    const steps: ScenarioStep[] = [
      {
        label: "prompt and a reply that reads and edits",
        mutations: [
          write(path, [
            cUser(S, "u1", null, at(0), "Refactor the greeting module"),
            cAssistant(S, "a1", "u1", at(0, 5), {
              requestId: "req_a1",
              messageId: "msg_a1",
              stop: "tool_use",
              usage: usage(1200, 180, 0, 400),
              content: [
                { type: "thinking", thinking: "Read the module, then edit it.", signature: "sig" },
                { type: "text", text: "Reading the greeting module first." },
                {
                  type: "tool_use",
                  id: "toolu_read",
                  name: "Read",
                  input: { file_path: `${CWD}/src/greet.ts` },
                },
                {
                  type: "tool_use",
                  id: "toolu_edit",
                  name: "Edit",
                  input: {
                    file_path: `${CWD}/src/greet.ts`,
                    old_string: "hi",
                    new_string: "hello",
                  },
                },
              ],
            }),
          ]),
        ],
      },
      {
        label: "tool results, one failing, and a write",
        mutations: [
          append(path, [
            cUser(S, "u2", "a1", at(1), [toolResult("toolu_read", "export const greet = 'hi';")]),
            cUser(S, "u3", "u2", at(1, 2), [
              toolResult("toolu_edit", "String to replace not found", true),
            ]),
            cAssistant(S, "a2", "u3", at(1, 10), {
              requestId: "req_a2",
              messageId: "msg_a2",
              stop: "tool_use",
              usage: usage(1500, 90, 1200),
              content: [
                {
                  type: "tool_use",
                  id: "toolu_write",
                  name: "Write",
                  input: { file_path: `${CWD}/README.md`, content: "# Greeting\n" },
                },
              ],
            }),
          ]),
        ],
      },
      {
        label: "write result, a summary, and a second prompt with a shell call",
        mutations: [
          append(path, [
            cUser(S, "u4", "a2", at(2), [toolResult("toolu_write", "File created")]),
            cAssistant(S, "a3", "u4", at(2, 5), {
              requestId: "req_a3",
              messageId: "msg_a3",
              stop: "end_turn",
              usage: usage(1600, 40, 1500),
              content: [{ type: "text", text: "Updated the greeting and wrote a README." }],
            }),
            cUser(S, "u5", "a3", at(5), "Now run the tests"),
            cAssistant(S, "a4", "u5", at(5, 4), {
              requestId: "req_a4",
              messageId: "msg_a4",
              stop: "tool_use",
              usage: usage(1700, 30, 1600),
              content: [
                { type: "thinking", thinking: "Use bun test.", signature: "sig2" },
                {
                  type: "tool_use",
                  id: "toolu_bash",
                  name: "Bash",
                  input: { command: "bun test" },
                },
              ],
            }),
          ]),
        ],
      },
      {
        label: "shell result and the final reply",
        mutations: [
          append(path, [
            cUser(S, "u6", "a4", at(6), [toolResult("toolu_bash", "12 pass\n0 fail")]),
            cAssistant(S, "a5", "u6", at(6, 3), {
              requestId: "req_a5",
              messageId: "msg_a5",
              stop: "end_turn",
              usage: usage(1800, 25, 1700),
              content: [{ type: "text", text: "All twelve tests pass." }],
            }),
          ]),
        ],
      },
    ];
    const { snapshot, fts } = runDifferentialScenario({
      name: "claude-live-append",
      steps,
      queries: ["greeting", "README", "bun test", "twelve", "Bash"],
    });
    const key = `claude_code:${S}`;
    const calls = rowsOf(snapshot, "tool_call", key);
    expect(calls.map((c) => [c.tool_name, c.has_result, c.is_error])).toEqual([
      ["Read", 1, 0],
      ["Edit", 1, 1],
      ["Write", 1, 0],
      ["Bash", 1, 0],
    ]);
    expect(rowsOf(snapshot, "file_ref", key).length).toBeGreaterThanOrEqual(2);
    expect(rowsOf(snapshot, "block", key).some((b) => b.type === "thinking")).toBe(true);
    expect(sessionRow(snapshot, key).error_count).toBe(1);
    expect(fts.every((capture) => capture.direct.length > 0)).toBe(true);
  });

  test("streamed chunks of one request whose usage grows in a later chunk", () => {
    const S = "c1b00000-0000-4000-8000-000000000002";
    const path = claudePath(S);
    const { snapshot } = runDifferentialScenario({
      name: "claude-retroactive-billing",
      steps: [
        {
          label: "first chunk of req_1 with provisional usage",
          mutations: [
            write(path, [
              cUser(S, "u1", null, at(10), "Summarize the changelog"),
              cAssistant(S, "a1", "u1", at(10, 2), {
                requestId: "req_1",
                messageId: "msg_1",
                usage: usage(900, 4),
                content: [{ type: "thinking", thinking: "Scan the changelog.", signature: "s1" }],
              }),
            ]),
          ],
        },
        {
          label: "later chunks of req_1 carry the final usage",
          mutations: [
            append(path, [
              cAssistant(S, "a1b", "a1", at(10, 3), {
                requestId: "req_1",
                messageId: "msg_1",
                usage: usage(900, 310),
                content: [{ type: "text", text: "The changelog lists three fixes." }],
              }),
              cAssistant(S, "a1c", "a1b", at(10, 4), {
                requestId: "req_1",
                messageId: "msg_1",
                usage: usage(900, 420),
                stop: "tool_use",
                content: [
                  { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "fix" } },
                ],
              }),
            ]),
          ],
        },
        {
          label: "result of the tool and the first chunk of req_2",
          mutations: [
            append(path, [
              cUser(S, "u2", "a1c", at(11), [
                toolResult("toolu_grep", "fix: one\nfix: two\nfix: three"),
              ]),
              cAssistant(S, "a2", "u2", at(11, 2), {
                requestId: "req_2",
                messageId: "msg_2",
                usage: usage(1100, 2, 900),
                content: [{ type: "text", text: "Confirmed" }],
              }),
            ]),
          ],
        },
        {
          label: "req_2 completes and a result record closes the run",
          mutations: [
            append(path, [
              cAssistant(S, "a2b", "a2", at(11, 3), {
                requestId: "req_2",
                messageId: "msg_2",
                usage: usage(1100, 95, 900),
                stop: "end_turn",
                content: [{ type: "text", text: "Confirmed three fixes in the changelog." }],
              }),
              {
                type: "result",
                subtype: "success",
                sessionId: S,
                usage: { input_tokens: 2000, output_tokens: 515 },
              },
            ]),
          ],
        },
      ],
      queries: ["changelog", "fixes", "Grep"],
    });
    const key = `claude_code:${S}`;
    expect(rowsOf(snapshot, "billed_request", key).map((r) => r.request_id)).toEqual([
      "msg_1",
      "msg_2",
    ]);
    const billedOutputs = rowsOf(snapshot, "message", key)
      .filter((m) => m.output_tokens != null)
      .map((m) => m.output_tokens);
    expect(billedOutputs).toContain(420);
    expect(billedOutputs).not.toContain(4);
  });

  test("a compaction boundary and its summary appended mid-session", () => {
    const S = "c1c00000-0000-4000-8000-000000000003";
    const path = claudePath(S);
    const { snapshot } = runDifferentialScenario({
      name: "claude-compaction",
      steps: [
        {
          label: "two turns",
          mutations: [
            write(path, [
              cUser(S, "u1", null, at(20), "Explain the cache layer"),
              cAssistant(S, "a1", "u1", at(20, 5), {
                requestId: "req_c1",
                messageId: "msg_c1",
                stop: "end_turn",
                usage: usage(40000, 300),
                content: [{ type: "text", text: "The cache layer wraps reads." }],
              }),
              cUser(S, "u2", "a1", at(21), "And the eviction policy?"),
              cAssistant(S, "a2", "u2", at(21, 5), {
                requestId: "req_c2",
                messageId: "msg_c2",
                stop: "end_turn",
                usage: usage(90000, 200),
                content: [{ type: "text", text: "Eviction is least recently used." }],
              }),
            ]),
          ],
        },
        {
          label: "compaction",
          mutations: [
            append(path, [
              {
                type: "system",
                subtype: "compact_boundary",
                uuid: "s1",
                parentUuid: "a2",
                sessionId: S,
                timestamp: at(22),
                cwd: CWD,
                content: "Conversation compacted",
                compactMetadata: { trigger: "auto", preTokens: 90200 },
              },
              cUser(
                S,
                "u3",
                "s1",
                at(22, 1),
                "This session is being continued from a previous conversation. Summary: cache layer and eviction.",
                { isCompactSummary: true },
              ),
            ]),
          ],
        },
        {
          label: "turns after compaction",
          mutations: [
            append(path, [
              cUser(S, "u4", "u3", at(23), "Write a test for eviction"),
              cAssistant(S, "a4", "u4", at(23, 5), {
                requestId: "req_c4",
                messageId: "msg_c4",
                stop: "end_turn",
                usage: usage(8000, 150),
                content: [{ type: "text", text: "Added an eviction test." }],
              }),
            ]),
          ],
        },
      ],
      queries: ["eviction", "compacted", "continued"],
    });
    expect(sessionRow(snapshot, `claude_code:${S}`).compaction_count).toBe(1);
  });

  test("a torn last line completed later, and a UTF-8 character split across chunks", () => {
    const S = "c1d00000-0000-4000-8000-000000000004";
    const path = claudePath(S);
    const reply = JSON.stringify(
      cAssistant(S, "a1", "u1", at(30, 5), {
        requestId: "req_t1",
        messageId: "msg_t1",
        stop: "end_turn",
        content: [{ type: "text", text: "The torn line is whole again." }],
      }),
    );
    const unicode = Buffer.from(
      `${JSON.stringify(
        cAssistant(S, "a2", "u2", at(31, 5), {
          requestId: "req_t2",
          messageId: "msg_t2",
          stop: "end_turn",
          content: [{ type: "text", text: "Café naïve résumé ☕ 🚀 done" }],
        }),
      )}\n`,
      "utf8",
    );
    const rocket = unicode.indexOf(Buffer.from("🚀", "utf8"));
    const splitAt = rocket + 2;
    const { snapshot } = runDifferentialScenario({
      name: "claude-torn-line",
      steps: [
        {
          label: "prompt plus half a reply with no newline",
          mutations: [
            {
              op: "write",
              path,
              content: `${JSON.stringify(cUser(S, "u1", null, at(30), "Mend the torn line"))}\n${reply.slice(0, 120)}`,
            },
          ],
        },
        {
          label: "rest of the reply and a new prompt",
          mutations: [
            {
              op: "append",
              path,
              content: `${reply.slice(120)}\n${JSON.stringify(cUser(S, "u2", "a1", at(31), "Say it in French ☕"))}\n`,
            },
          ],
        },
        {
          label: "reply cut inside a four-byte character",
          mutations: [{ op: "append", path, content: unicode.subarray(0, splitAt) }],
        },
        {
          label: "the character's remaining bytes and one more turn",
          mutations: [
            { op: "append", path, content: unicode.subarray(splitAt) },
            append(path, [cUser(S, "u3", "a2", at(32), "Merci")]),
          ],
        },
      ],
      queries: ["torn", "café", "résumé", "merci"],
    });
    const texts = rowsOf(snapshot, "block", `claude_code:${S}`).map((b) => b.text);
    expect(texts).toContain("Café naïve résumé ☕ 🚀 done");
    expect(texts).toContain("The torn line is whole again.");
  });

  test("a file truncated, rewritten with a new prefix, and rewritten at the same size", () => {
    const S = "c1e00000-0000-4000-8000-000000000005";
    const path = claudePath(S);
    const turn = (n: number, word: string): Rec[] => [
      cUser(S, `u${n}`, n === 1 ? null : `a${n - 1}`, at(40 + n), `Prompt ${n} about ${word}`),
      cAssistant(S, `a${n}`, `u${n}`, at(40 + n, 5), {
        requestId: `req_r${n}`,
        messageId: `msg_r${n}`,
        stop: "end_turn",
        usage: usage(100 * n, 10 * n),
        content: [{ type: "text", text: `Answer ${n} about ${word}` }],
      }),
    ];
    const firstTwo = jsonl([...turn(1, "alpha"), ...turn(2, "alpha")]);
    const torn = `${firstTwo}${jsonl(turn(3, "alpha")).slice(0, 90)}`;
    const sameSizeBefore = jsonl([...turn(1, "gamma"), ...turn(2, "gamma")]);
    const sameSizeAfter = jsonl([...turn(1, "delta"), ...turn(2, "delta")]);
    expect(Buffer.byteLength(sameSizeAfter)).toBe(Buffer.byteLength(sameSizeBefore));
    const { snapshot } = runDifferentialScenario({
      name: "claude-truncate-rewrite",
      steps: [
        {
          label: "three turns",
          mutations: [write(path, [...turn(1, "alpha"), ...turn(2, "alpha"), ...turn(3, "alpha")])],
        },
        {
          label: "two more turns",
          mutations: [append(path, [...turn(4, "alpha"), ...turn(5, "alpha")])],
        },
        {
          label: "truncated back to two turns",
          mutations: [{ op: "truncate", path, size: Buffer.byteLength(firstTwo) }],
        },
        { label: "truncated mid-line", mutations: [{ op: "rewrite", path, content: torn }] },
        {
          label: "rewritten larger with a changed prefix",
          mutations: [
            write(path, [
              cUser(S, "u0", null, at(40), "A brand new opening prompt about beta"),
              ...turn(1, "beta"),
              ...turn(2, "beta"),
              ...turn(3, "beta"),
            ]),
          ],
        },
        {
          label: "rewritten smaller",
          mutations: [{ op: "rewrite", path, content: sameSizeBefore }],
        },
        {
          label: "rewritten at the same size",
          mutations: [{ op: "rewrite", path, content: sameSizeAfter }],
        },
      ],
      queries: ["alpha", "beta", "gamma", "delta", "opening"],
    });
    const texts = rowsOf(snapshot, "block", `claude_code:${S}`).map((b) => b.text);
    expect(texts).toContain("Answer 2 about delta");
    expect(texts.some((t) => String(t).includes("gamma"))).toBe(false);
  });

  test("a subagent file and in-file sidechain messages that appear mid-session", () => {
    const S = "c1f00000-0000-4000-8000-000000000006";
    const path = claudePath(S);
    const agentDir = `${CLAUDE_PROJECT}/${S}/subagents`;
    const agentPath = `${agentDir}/agent-alpha.jsonl`;
    const sidechain = (
      uuid: string,
      parent: string | null,
      t: string,
      role: "user" | "assistant",
      text: string,
    ): Rec =>
      role === "user"
        ? cUser(S, uuid, parent, t, text, { isSidechain: true, agentId: "alpha" })
        : cAssistant(S, uuid, parent, t, {
            requestId: `req_${uuid}`,
            messageId: `msg_${uuid}`,
            stop: "end_turn",
            usage: usage(300, 40),
            content: [{ type: "text", text }],
            extra: { isSidechain: true, agentId: "alpha" },
          });
    const { snapshot } = runDifferentialScenario({
      name: "claude-subagent",
      steps: [
        {
          label: "root spawns a subagent",
          mutations: [
            write(path, [
              cUser(S, "u1", null, at(50), "Audit the auth flow"),
              cAssistant(S, "a1", "u1", at(50, 3), {
                requestId: "req_root1",
                messageId: "msg_root1",
                stop: "tool_use",
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_task",
                    name: "Task",
                    input: { prompt: "inspect auth", subagent_type: "explorer" },
                  },
                ],
              }),
            ]),
          ],
        },
        {
          label: "subagent file with its sidecar, and sidechain records in the root",
          mutations: [
            { op: "mkdir", path: agentDir },
            {
              op: "write",
              path: `${agentDir}/agent-alpha.meta.json`,
              content: JSON.stringify({
                toolUseId: "toolu_task",
                agentType: "explorer",
                spawnDepth: 1,
              }),
            },
            write(agentPath, [
              sidechain("sa-u1", null, at(50, 10), "user", "inspect auth"),
              sidechain("sa-a1", "sa-u1", at(50, 20), "assistant", "Found the token refresh path."),
            ]),
            append(path, [
              sidechain("sc-u1", "a1", at(50, 11), "user", "inspect auth"),
              sidechain("sc-a1", "sc-u1", at(50, 21), "assistant", "Sidechain notes on auth."),
            ]),
          ],
        },
        {
          label: "subagent finishes and the root gets its result",
          mutations: [
            append(agentPath, [
              sidechain("sa-u2", "sa-a1", at(51), "user", "anything else?"),
              sidechain(
                "sa-a2",
                "sa-u2",
                at(51, 10),
                "assistant",
                "Auth is sound; refresh is rate limited.",
              ),
            ]),
            append(path, [
              cUser(S, "u2", "a1", at(52), [
                toolResult("toolu_task", "Auth is sound; refresh is rate limited."),
              ]),
              cAssistant(S, "a2", "u2", at(52, 5), {
                requestId: "req_root2",
                messageId: "msg_root2",
                stop: "end_turn",
                content: [{ type: "text", text: "The audit found no problems." }],
              }),
            ]),
          ],
        },
      ],
      queries: ["auth", "refresh", "audit"],
    });
    const child = snapshot.session.find((s) => s.is_subagent === 1);
    expect(child?.parent_session_key).toBe(`claude_code:${S}`);
    expect(child?.agent_type).toBe("explorer");
    expect(child?.spawn_tool_use_id).toBe("toolu_task");
    expect(sessionRow(snapshot, `claude_code:${S}`).sidechain_message_count).toBeGreaterThan(0);
  });

  test("branched sessions that share request ids, arriving in separate syncs", () => {
    const ORIGINAL = "c2000000-0000-4000-8000-000000000001";
    const FORK = "c2000000-0000-4000-8000-000000000002";
    const BRANCH = "c2000000-0000-4000-8000-000000000003";
    const turn = (
      session: string,
      id: string,
      minute: number,
      input: number,
      output: number,
      from?: string,
    ): Rec[] => {
      const marker = from == null ? {} : { forkedFrom: { sessionId: from, messageUuid: `u${id}` } };
      return [
        cUser(session, `u${id}`, null, at(minute), `Prompt ${id} on the release`, marker),
        cAssistant(session, `a${id}`, `u${id}`, at(minute, 5), {
          requestId: `req_${id}`,
          messageId: `msg_${id}`,
          stop: "end_turn",
          usage: { input_tokens: input, output_tokens: output },
          content: [
            { type: "thinking", thinking: "Considering." },
            { type: "text", text: `Reply ${id} on the release.` },
          ],
          extra: from == null ? {} : { forkedFrom: { sessionId: from, messageUuid: `a${id}` } },
        }),
      ];
    };
    const { snapshot } = runDifferentialScenario({
      name: "claude-branches",
      steps: [
        {
          label: "original first turn",
          mutations: [write(claudePath(ORIGINAL), turn(ORIGINAL, "1", 1, 1000, 2000))],
        },
        {
          label: "--fork-session copy with its own turn",
          mutations: [
            write(claudePath(FORK), [
              { type: "mode", mode: "default", sessionId: FORK, timestamp: at(4) },
              ...turn(FORK, "1", 1, 1000, 2000),
              ...turn(FORK, "2", 5, 1000, 500),
            ]),
          ],
        },
        {
          label: "both grow",
          mutations: [
            append(claudePath(FORK), turn(FORK, "3", 20, 3000, 700)),
            append(claudePath(ORIGINAL), turn(ORIGINAL, "4", 30, 4000, 900)),
          ],
        },
        {
          label: "/branch copy of the original",
          mutations: [
            write(claudePath(BRANCH), [
              ...turn(BRANCH, "1", 1, 1000, 2000, ORIGINAL),
              ...turn(BRANCH, "5", 40, 2000, 300),
            ]),
          ],
        },
      ],
      queries: ["release", "Considering"],
    });
    expect(snapshot.billed_request.map((r) => [r.request_id, r.session_key])).toEqual([
      ["msg_1", `claude_code:${ORIGINAL}`],
      ["msg_2", `claude_code:${FORK}`],
      ["msg_3", `claude_code:${FORK}`],
      ["msg_4", `claude_code:${ORIGINAL}`],
      ["msg_5", `claude_code:${BRANCH}`],
    ]);
    expect(snapshot.unbilled_request.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- Codex

function codexLine(ts: string, type: string, payload: unknown, ordinal?: number): Rec {
  return { timestamp: ts, ...(ordinal == null ? {} : { ordinal }), type, payload };
}

function cxMessage(role: string, text: string): Rec {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  };
}

function tokenCount(total: Rec, last: Rec): Rec {
  return {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
  };
}

describe("incremental ingest matches a fresh ingest: Codex", () => {
  test("a rollout appended across token counts, MCP events, compaction, and a forked subagent", () => {
    const PARENT = "019a0000-0000-7000-8000-00000000c0de";
    const CHILD = "019a0000-0000-7000-8000-00000000c0df";
    const dir = `${SOURCE_ROOTS.codex}/sessions/2026/11/01`;
    const parentPath = `${dir}/rollout-2026-11-01T09-00-00-${PARENT}.jsonl`;
    const childPath = `${dir}/rollout-2026-11-01T09-10-00-${CHILD}.jsonl`;
    const t = (m: number, s = 0): string =>
      `2026-11-01T09:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
    const { snapshot } = runDifferentialScenario({
      name: "codex-append",
      steps: [
        {
          label: "meta, prompt, a shell call, and an assistant reply whose usage comes later",
          mutations: [
            write(parentPath, [
              codexLine(t(0), "session_meta", {
                id: PARENT,
                cwd: CWD,
                originator: "codex_cli_rs",
                cli_version: "0.120.0",
                git: { branch: "main" },
              }),
              codexLine(t(0, 1), "turn_context", { cwd: CWD, model: "gpt-5.4", effort: "high" }),
              codexLine(t(0, 2), "response_item", cxMessage("user", "Patch the parser")),
              codexLine(t(0, 3), "response_item", {
                type: "function_call",
                name: "exec_command",
                call_id: "call_e1",
                arguments: JSON.stringify({ cmd: "rg parser" }),
              }),
              codexLine(t(0, 4), "response_item", {
                type: "function_call_output",
                call_id: "call_e1",
                output: "src/parser.ts",
              }),
              codexLine(
                t(0, 5),
                "response_item",
                cxMessage("assistant", "Found the parser module."),
              ),
            ]),
          ],
        },
        {
          label: "token count stamps the earlier reply, and an event-only MCP call",
          mutations: [
            append(parentPath, [
              codexLine(
                t(0, 6),
                "event_msg",
                tokenCount(
                  {
                    input_tokens: 900,
                    cached_input_tokens: 700,
                    output_tokens: 60,
                    reasoning_output_tokens: 10,
                  },
                  {
                    input_tokens: 900,
                    cached_input_tokens: 700,
                    output_tokens: 60,
                    reasoning_output_tokens: 10,
                  },
                ),
              ),
              codexLine(t(1), "event_msg", {
                type: "mcp_tool_call_end",
                call_id: "mcp-call-1",
                invocation: {
                  server: "docs",
                  tool: "lookup",
                  arguments: { query: "parser grammar" },
                },
                duration: { secs: 1, nanos: 0 },
                result: {
                  Ok: { content: [{ type: "text", text: "grammar notes" }], isError: false },
                },
              }),
              codexLine(
                t(1, 2),
                "response_item",
                cxMessage("assistant", "The grammar notes confirm the fix."),
              ),
            ]),
          ],
        },
        {
          label: "compaction, then a new turn, and a forked subagent rollout appears",
          mutations: [
            append(parentPath, [
              codexLine(t(2), "compacted", {
                message: "Summary: parser patched.",
                replacement_history: [],
              }),
              codexLine(
                t(2, 1),
                "event_msg",
                tokenCount(
                  { input_tokens: 900, cached_input_tokens: 700, output_tokens: 60 },
                  { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
                ),
              ),
              codexLine(t(3), "turn_context", { cwd: CWD, model: "gpt-5.4", effort: "medium" }),
              codexLine(t(3, 1), "response_item", cxMessage("user", "Spawn a reviewer")),
            ]),
            write(childPath, [
              codexLine(
                t(10),
                "session_meta",
                {
                  id: CHILD,
                  forked_from_id: PARENT,
                  parent_thread_id: PARENT,
                  subagent_history_start_ordinal: 3,
                  cwd: CWD,
                  source: {
                    subagent: {
                      thread_spawn: {
                        parent_thread_id: PARENT,
                        depth: 1,
                        agent_nickname: "Ada",
                        agent_role: "reviewer",
                      },
                    },
                  },
                },
                0,
              ),
              codexLine(t(10, 1), "session_meta", { id: PARENT, cwd: CWD }, 1),
              codexLine(t(10, 2), "response_item", cxMessage("user", "Patch the parser"), 2),
              codexLine(
                t(10, 3),
                "turn_context",
                { cwd: CWD, model: "gpt-5.4-mini", effort: "low" },
                3,
              ),
              codexLine(t(10, 4), "response_item", cxMessage("user", "Review the parser patch"), 4),
            ]),
          ],
        },
        {
          label: "both rollouts grow",
          mutations: [
            append(childPath, [
              codexLine(
                t(10, 5),
                "response_item",
                cxMessage("assistant", "The reviewer approves the patch."),
                5,
              ),
              codexLine(
                t(10, 6),
                "event_msg",
                tokenCount(
                  { input_tokens: 300, cached_input_tokens: 0, output_tokens: 20 },
                  { input_tokens: 300, cached_input_tokens: 0, output_tokens: 20 },
                ),
                6,
              ),
            ]),
            append(parentPath, [
              codexLine(
                t(3, 5),
                "response_item",
                cxMessage("assistant", "Reviewer spawned and approved."),
              ),
              codexLine(
                t(3, 6),
                "event_msg",
                tokenCount(
                  { input_tokens: 1400, cached_input_tokens: 900, output_tokens: 90 },
                  { input_tokens: 500, cached_input_tokens: 200, output_tokens: 30 },
                ),
              ),
            ]),
          ],
        },
      ],
      queries: ["parser", "grammar", "reviewer", "lookup"],
    });
    const parentKey = `codex:${PARENT}`;
    const stamped = rowsOf(snapshot, "message", parentKey).find((m) =>
      String(m.decoded_raw).includes("Found the parser module."),
    );
    expect(stamped?.output_tokens).toBe(60);
    expect(rowsOf(snapshot, "tool_call", parentKey).map((c) => c.tool_name)).toContain(
      "mcp__docs__lookup",
    );
    expect(sessionRow(snapshot, parentKey).compaction_count).toBe(1);
    const child = sessionRow(snapshot, `codex:${CHILD}`);
    expect(child.parent_session_key).toBe(parentKey);
    expect(child.title).toBe("Review the parser patch");
  });
});

// ---------------------------------------------------------------- Pi

describe("incremental ingest matches a fresh ingest: Pi", () => {
  test("nested calls answered in a later chunk, and a fork with copied entries", () => {
    const ORIGINAL = "5a1e0000-0000-4000-8000-0000000000a1";
    const FORK = "f0e10000-0000-4000-8000-0000000000a2";
    const dir = `${SOURCE_ROOTS.pi}/--home-dev-work-app--`;
    const originalPath = `${dir}/2026-11-01T10-00-00-000Z_${ORIGINAL}.jsonl`;
    const forkPath = `${dir}/2026-11-02T09-00-00-000Z_${FORK}.jsonl`;
    const piUsage = (input: number, output: number): Rec => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const entry = (id: string, parentId: string | null, ts: string, message: Rec): Rec => ({
      type: "message",
      id,
      parentId,
      timestamp: ts,
      message: { timestamp: 0, ...message },
    });
    const opening = [
      {
        type: "model_change",
        id: "p0000001",
        parentId: null,
        timestamp: "2026-11-01T10:00:00.100Z",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
      },
      entry("p0000002", "p0000001", "2026-11-01T10:00:01.000Z", {
        role: "user",
        content: "Run the release script",
      }),
      entry("p0000003", "p0000002", "2026-11-01T10:00:03.000Z", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_run",
            name: "run_script",
            arguments: { script: "release.sh" },
          },
        ],
        provider: "anthropic",
        model: "claude-sonnet-5",
        usage: piUsage(1200, 80),
        stopReason: "toolUse",
      }),
    ];
    const nested = entry("p0000004", "p0000003", "2026-11-01T10:00:05.000Z", {
      role: "toolResult",
      toolCallId: "call_run",
      toolName: "run_script",
      content: [{ type: "text", text: "release script finished" }],
      usage: piUsage(50, 5),
      nestedCalls: {
        complete: true,
        calls: [
          { id: "inner-1", name: "read", arguments: { path: "CHANGELOG.md" }, status: "ok" },
          { id: "inner-2", name: "bash", arguments: { command: "git tag" }, status: "error" },
        ],
      },
      isError: false,
    });
    const reply = entry("p0000005", "p0000004", "2026-11-01T10:00:07.000Z", {
      role: "assistant",
      content: [{ type: "text", text: "The release script ran; tagging failed." }],
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: piUsage(1400, 30),
      stopReason: "stop",
    });
    const header = (id: string, ts: string, parent?: string): Rec => ({
      type: "session",
      version: 3,
      id,
      timestamp: ts,
      cwd: CWD,
      ...(parent == null ? {} : { parentSession: parent }),
    });
    const { snapshot } = runDifferentialScenario({
      name: "pi-append",
      steps: [
        {
          label: "header and a tool call",
          mutations: [
            write(originalPath, [header(ORIGINAL, "2026-11-01T10:00:00.000Z"), ...opening]),
          ],
        },
        {
          label: "tool result with nested calls and a reply",
          mutations: [append(originalPath, [nested, reply])],
        },
        {
          label: "a fork copying the opening entries",
          mutations: [
            write(forkPath, [
              header(
                FORK,
                "2026-11-02T09:00:00.000Z",
                `/home/dev/.pi/agent/sessions/--home-dev-work-app--/2026-11-01T10-00-00-000Z_${ORIGINAL}.jsonl`,
              ),
              ...opening,
              entry("f0000001", "p0000003", "2026-11-02T09:00:10.000Z", {
                role: "user",
                content: "Retry the tag only",
              }),
            ]),
          ],
        },
        {
          label: "both grow",
          mutations: [
            append(forkPath, [
              entry("f0000002", "f0000001", "2026-11-02T09:00:12.000Z", {
                role: "assistant",
                content: [{ type: "text", text: "Tagged the release on retry." }],
                provider: "anthropic",
                model: "claude-sonnet-5",
                usage: piUsage(600, 20),
                stopReason: "stop",
              }),
            ]),
            append(originalPath, [
              entry("p0000006", "p0000005", "2026-11-01T10:01:00.000Z", {
                role: "user",
                content: "Thanks",
              }),
            ]),
          ],
        },
      ],
      queries: ["release", "tag", "run_script"],
    });
    const calls = rowsOf(snapshot, "tool_call", `pi:${ORIGINAL}`);
    expect(calls.map((c) => c.tool_name).sort()).toEqual(["bash", "read", "run_script"]);
    expect(snapshot.session.map((s) => s.source_session_id).sort()).toEqual(
      [ORIGINAL, FORK].sort(),
    );
  });
});

// ---------------------------------------------------------------- Copilot CLI

describe("incremental ingest matches a fresh ingest: Copilot CLI", () => {
  test("usage records, tool executions, checkpoints, shutdowns, and replayed event ids", () => {
    const S = "c0b11000-0000-4000-8000-000000000001";
    const path = `${SOURCE_ROOTS.copilot}/${S}/events.jsonl`;
    let counter = 0;
    const ev = (type: string, data: Rec, seconds: number, id?: string): Rec => {
      counter += 1;
      return {
        type,
        data,
        id: id ?? `00000000-0000-4000-8000-2000000000${String(counter).padStart(2, "0")}`,
        timestamp: `2026-11-01T11:00:${String(seconds).padStart(2, "0")}.000Z`,
        parentId: null,
      };
    };
    const usageRecord = (call: string, input: number, output: number, seconds: number): Rec =>
      ev(
        "session.usage_record",
        {
          usage: {
            model: "claude-sonnet-4.5",
            apiCallId: call,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            maxPromptTokens: 200000,
          },
        },
        seconds,
      );
    const first = [
      ev(
        "session.start",
        {
          sessionId: S,
          version: 1,
          producer: "copilot-agent",
          copilotVersion: "1.0.110",
          startTime: "2026-11-01T11:00:00.000Z",
          selectedModel: "claude-sonnet-4.5",
          context: { cwd: CWD, gitRoot: CWD, branch: "main" },
        },
        0,
      ),
      ev("user.message", { content: "Fix the flaky login test", interactionId: "int-1" }, 1),
      ev("assistant.turn_start", { turnId: "0", interactionId: "int-1" }, 2),
      usageRecord("call-a", 4000, 50, 3),
      ev(
        "assistant.message",
        {
          messageId: "m-1",
          content: "Looking at the test.",
          model: "claude-sonnet-4.5",
          apiCallId: "call-a",
          toolRequests: [
            {
              toolCallId: "tc-view",
              name: "view",
              arguments: { path: `${CWD}/test/login.test.ts` },
              type: "function",
            },
          ],
        },
        4,
      ),
      ev(
        "tool.execution_start",
        {
          toolCallId: "tc-view",
          toolName: "view",
          arguments: { path: `${CWD}/test/login.test.ts` },
        },
        5,
      ),
    ];
    const replayed = first[1] as Rec;
    const { snapshot } = runDifferentialScenario({
      name: "copilot-append",
      steps: [
        { label: "start, prompt, call, and a running tool", mutations: [write(path, first)] },
        {
          label: "tool completes, a replayed event, a checkpoint, and a reply billed later",
          mutations: [
            append(path, [
              ev(
                "tool.execution_complete",
                { toolCallId: "tc-view", success: true, result: { content: "it('logs in')" } },
                6,
              ),
              replayed,
              ev(
                "session.usage_checkpoint",
                {
                  providerModelMetrics: [
                    {
                      modelId: "claude-sonnet-4.5",
                      metrics: {
                        requests: { count: 1 },
                        usage: { inputTokens: 4000, outputTokens: 50 },
                      },
                    },
                  ],
                },
                7,
              ),
              ev(
                "assistant.message",
                {
                  messageId: "m-2",
                  content: "The login test waits on a timer.",
                  model: "claude-sonnet-4.5",
                  apiCallId: "call-b",
                },
                8,
              ),
            ]),
          ],
        },
        {
          label: "the late usage record and a shutdown",
          mutations: [
            append(path, [
              usageRecord("call-b", 4200, 40, 9),
              ev("assistant.turn_end", { turnId: "0" }, 10),
              ev(
                "session.shutdown",
                {
                  shutdownType: "routine",
                  currentModel: "claude-sonnet-4.5",
                  modelMetrics: {
                    "claude-sonnet-4.5": {
                      requests: { count: 2, cost: 1 },
                      usage: {
                        inputTokens: 8200,
                        outputTokens: 90,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                      },
                    },
                  },
                },
                11,
              ),
            ]),
          ],
        },
        {
          label: "resumed with another turn and a second shutdown",
          mutations: [
            append(path, [
              ev(
                "user.message",
                { content: "Now make the timer injectable", interactionId: "int-2" },
                20,
              ),
              usageRecord("call-c", 5000, 70, 21),
              ev(
                "assistant.message",
                {
                  messageId: "m-3",
                  content: "The timer is injectable now.",
                  model: "claude-sonnet-4.5",
                  apiCallId: "call-c",
                },
                22,
              ),
              ev(
                "session.shutdown",
                {
                  shutdownType: "routine",
                  currentModel: "claude-sonnet-4.5",
                  modelMetrics: {
                    "claude-sonnet-4.5": {
                      requests: { count: 1, cost: 1 },
                      usage: {
                        inputTokens: 5000,
                        outputTokens: 70,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                      },
                    },
                  },
                },
                23,
              ),
            ]),
          ],
        },
      ],
      queries: ["login", "timer", "view"],
    });
    const key = `copilot:${S}`;
    expect(
      rowsOf(snapshot, "message", key).filter((m) =>
        String(m.decoded_raw).includes("Fix the flaky login test"),
      ),
    ).toHaveLength(1);
    expect(rowsOf(snapshot, "tool_call", key).map((c) => [c.tool_name, c.has_result])).toEqual([
      ["view", 1],
    ]);
    expect(rowsOf(snapshot, "session_model_usage", key).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- Gemini CLI

describe("incremental ingest matches a fresh ingest: Gemini CLI", () => {
  test("a chat log appended with $set checkpoints and a $rewindTo", () => {
    const S = "9e000000-0000-4000-8000-000000000001";
    const chats = `${SOURCE_ROOTS.gemini}/0f1e2d3c4b5a69788796a5b4c3d2e1f0/chats`;
    const path = `${chats}/session-2026-11-01T12-00-9e000000.jsonl`;
    const ts = (s: number): string => `2026-11-01T12:00:${String(s).padStart(2, "0")}.000Z`;
    const assistant = (id: string, s: number, text: string, extra: Rec = {}): Rec => ({
      id,
      timestamp: ts(s),
      type: "gemini",
      model: "gemini-3-pro",
      content: text,
      ...extra,
    });
    const user = (id: string, s: number, text: string): Rec => ({
      id,
      timestamp: ts(s),
      type: "user",
      content: [{ text }],
    });
    const { snapshot } = runDifferentialScenario({
      name: "gemini-append",
      steps: [
        {
          label: "header, a $set checkpoint, and a streaming reply",
          mutations: [
            {
              op: "write",
              path: `${SOURCE_ROOTS.gemini}/0f1e2d3c4b5a69788796a5b4c3d2e1f0/.project_root`,
              content: `${CWD}\n`,
            },
            write(path, [
              {
                sessionId: S,
                projectHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
                startTime: ts(0),
                lastUpdated: ts(0),
                kind: "main",
              },
              {
                $set: {
                  messages: [user("user-1", 1, "List the config files")],
                  lastUpdated: ts(1),
                },
              },
              assistant("gemini-1", 2, "Listing the config files."),
            ]),
          ],
        },
        {
          label: "the reply is replaced with its tool call and tokens",
          mutations: [
            append(path, [
              assistant("gemini-1", 2, "Listing the config files.", {
                toolCalls: [
                  {
                    id: "call-ls",
                    name: "list_directory",
                    args: { path: CWD },
                    status: "success",
                    timestamp: ts(3),
                    result: [
                      {
                        functionResponse: {
                          id: "call-ls",
                          name: "list_directory",
                          response: { output: "tsconfig.json\nbiome.json" },
                        },
                      },
                    ],
                  },
                ],
                tokens: { input: 800, output: 40, cached: 0, thoughts: 10, tool: 0, total: 850 },
              }),
              { $set: { lastUpdated: ts(4) } },
            ]),
          ],
        },
        {
          label: "a turn that is rewound and replaced",
          mutations: [
            append(path, [
              user("user-2", 10, "Delete biome.json"),
              assistant("gemini-2", 11, "Deleting biome.json now.", {
                tokens: { input: 900, output: 20, cached: 0, thoughts: 0, tool: 0, total: 920 },
              }),
              { $rewindTo: "user-2" },
              user("user-2b", 12, "Explain biome.json instead"),
            ]),
          ],
        },
        {
          label: "the explanation and a final checkpoint",
          mutations: [
            append(path, [
              assistant("gemini-3", 13, "biome.json configures formatting and lint.", {
                tokens: { input: 950, output: 30, cached: 100, thoughts: 0, tool: 0, total: 1080 },
              }),
              { $set: { lastUpdated: ts(14), summary: "Config walkthrough" } },
            ]),
          ],
        },
      ],
      queries: ["config", "biome", "Deleting"],
    });
    const texts = snapshot.block.map((b) => b.text);
    expect(texts).toContain("biome.json configures formatting and lint.");
    expect(texts).not.toContain("Deleting biome.json now.");
  });
});

// ---------------------------------------------------------------- VS Code

const repoFixtures = join(import.meta.dir, "..", "fixtures");

function chunkLines(content: string, cuts: number[]): string[] {
  const lines = content.split(/(?<=\n)/);
  const out: string[] = [];
  let start = 0;
  for (const cut of [...cuts, lines.length]) {
    out.push(lines.slice(start, cut).join(""));
    start = cut;
  }
  return out.filter((chunk) => chunk !== "");
}

describe("incremental ingest matches a fresh ingest: Copilot Chat in VS Code", () => {
  test("a mutation log appended request by request", () => {
    const source = join(repoFixtures, "vscode-copilot", "User", "workspaceStorage", "5f3e9c1a");
    const workspace = `${SOURCE_ROOTS.vscode}/workspaceStorage/5f3e9c1a`;
    const path = `${workspace}/chatSessions/vscode-sample-session.jsonl`;
    const chunks = chunkLines(
      readFileSync(join(source, "chatSessions", "vscode-sample-session.jsonl"), "utf8"),
      [2, 5, 9, 12, 15, 18],
    );
    const steps: ScenarioStep[] = chunks.map((content, index) => ({
      label: `chunk ${index + 1}`,
      mutations: [
        index === 0 ? { op: "write", path, content } : { op: "append", path, content },
        ...(index === 0
          ? [
              {
                op: "write",
                path: `${workspace}/workspace.json`,
                content: readFileSync(join(source, "workspace.json"), "utf8"),
              } satisfies FileMutation,
            ]
          : []),
      ],
    }));
    const { snapshot } = runDifferentialScenario({
      name: "vscode-append",
      steps,
      queries: ["greeting", "README", "exclamation", "search_docs"],
    });
    const session = sessionRow(snapshot, "vscode_copilot:vscode-sample-session");
    expect(session.title).toBe("Fix the README greeting");
    expect(
      rowsOf(snapshot, "tool_call", "vscode_copilot:vscode-sample-session").length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- fixture replay

describe("incremental ingest matches a fresh ingest: repository fixtures replayed in chunks", () => {
  const cases: [string, string, string][] = [
    ["claude/enriched.jsonl", `${CLAUDE_PROJECT}/fixture-enriched.jsonl`, "auth"],
    ["claude/mcp.jsonl", `${CLAUDE_PROJECT}/fixture-mcp.jsonl`, "knowledge"],
    [
      "codex/enriched.jsonl",
      `${SOURCE_ROOTS.codex}/sessions/2026/05/04/rollout-2026-05-04T09-00-00-enriched.jsonl`,
      "patch",
    ],
    [
      "codex/mcp.jsonl",
      `${SOURCE_ROOTS.codex}/sessions/2026/05/06/rollout-2026-05-06T09-00-00-mcp.jsonl`,
      "synthetic",
    ],
    [
      "copilot/sample/events.jsonl",
      `${SOURCE_ROOTS.copilot}/copilot-sample-session/events.jsonl`,
      "greeting",
    ],
    [
      "copilot/resumed/events.jsonl",
      `${SOURCE_ROOTS.copilot}/copilot-resumed-session/events.jsonl`,
      "task",
    ],
    [
      "gemini/sample.jsonl",
      `${SOURCE_ROOTS.gemini}/synthetic-project/chats/session-2026-06-01T10-00-sample.jsonl`,
      "example",
    ],
    [
      "pi/sample.jsonl",
      `${SOURCE_ROOTS.pi}/--decant-fixture-pi-example--/2026-11-01T10-00-00-000Z_5a1e0000-0000-4000-8000-000000000001.jsonl`,
      "hello",
    ],
  ];
  for (const [fixture, target, query] of cases) {
    test(`${fixture} in three chunks, the middle one torn`, () => {
      const content = readFileSync(join(repoFixtures, fixture), "utf8");
      const lines = content.split(/(?<=\n)/);
      const third = Math.max(1, Math.floor(lines.length / 3));
      const head = lines.slice(0, third).join("");
      const middle = lines.slice(third, third * 2).join("");
      const tornAt = Math.floor(middle.length / 2);
      const tail = lines.slice(third * 2).join("");
      runDifferentialScenario({
        name: `replay-${fixture}`,
        steps: [
          { label: "head", mutations: [{ op: "write", path: target, content: head }] },
          {
            label: "torn middle",
            mutations: [{ op: "append", path: target, content: middle.slice(0, tornAt) }],
          },
          {
            label: "rest of middle",
            mutations: [{ op: "append", path: target, content: middle.slice(tornAt) }],
          },
          { label: "tail", mutations: [{ op: "append", path: target, content: tail }] },
        ],
        queries: [query],
      });
    });
  }
});

// ---------------------------------------------------------------- change detection edges

describe("incremental ingest and whole-second change detection", () => {
  const S = "c3000000-0000-4000-8000-000000000001";
  const path = claudePath(S);
  const turn = (n: number, word: string): Rec[] => [
    cUser(S, `u${n}`, n === 1 ? null : `a${n - 1}`, at(n), `Question ${n} on ${word}`),
    cAssistant(S, `a${n}`, `u${n}`, at(n, 5), {
      requestId: `req_s${n}`,
      messageId: `msg_s${n}`,
      stop: "end_turn",
      content: [{ type: "text", text: `Answer ${n} on ${word}` }],
    }),
  ];

  test("a file that grows twice within one second is still re-read", () => {
    runDifferentialScenario({
      name: "same-second-grow",
      steps: [
        { label: "first turn", mutations: [write(path, turn(1, "lamps"))] },
        {
          label: "second turn in the same second",
          clock: "hold",
          mutations: [append(path, turn(2, "lamps"))],
        },
      ],
      queries: ["lamps"],
    });
  });

  test("an empty directory created and removed between syncs changes nothing", () => {
    runDifferentialScenario({
      name: "mkdir-remove",
      steps: [
        { label: "first turn", mutations: [write(path, turn(1, "chairs"))] },
        {
          label: "a stray directory",
          mutations: [
            { op: "mkdir", path: `${CLAUDE_PROJECT}/scratch` },
            append(path, turn(2, "chairs")),
          ],
        },
        {
          label: "the directory is removed",
          mutations: [
            { op: "remove", path: `${CLAUDE_PROJECT}/scratch` },
            append(path, turn(3, "chairs")),
          ],
        },
      ],
      queries: ["chairs"],
    });
  });

  // Known limit: a rewrite that keeps the size and lands in the second the
  // archive already recorded is indistinguishable by (size, whole-second
  // mtime), so the incremental archive keeps the old text. When change
  // detection learns to see it, this starts passing and `.failing` must go.
  test.failing("a same-size rewrite within the recorded second is re-read", () => {
    runDifferentialScenario({
      name: "same-second-same-size",
      steps: [
        { label: "first turn", mutations: [write(path, turn(1, "apple"))] },
        {
          label: "same-size rewrite in the same second",
          clock: "hold",
          mutations: [{ op: "rewrite", path, content: jsonl(turn(1, "grape")) }],
        },
      ],
      queries: ["apple", "grape"],
    });
  });
});

// ---------------------------------------------------------------- the oracle itself

describe("the differential oracle", () => {
  function syncedArchive(): { db: Database; dir: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "decant-oracle-self-")));
    const config = isolatedConfig(dir);
    const S = "c4000000-0000-4000-8000-000000000001";
    const file = join(dir, claudePath(S));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      jsonl([
        cUser(S, "u1", null, at(1), "Index the lighthouse notes"),
        cAssistant(S, "a1", "u1", at(1, 5), {
          requestId: "req_o1",
          messageId: "msg_o1",
          stop: "end_turn",
          content: [{ type: "text", text: "The lighthouse notes are indexed." }],
        }),
      ]),
    );
    const db = openDb(join(dir, "archive.db"));
    sync(db, config);
    return { db, dir };
  }

  test("notices a block whose text changed", () => {
    const { db, dir } = syncedArchive();
    try {
      const before = captureCanonicalSnapshot(db);
      const ftsBefore = captureFtsResults(db, ["lighthouse"]);
      db.run(
        "UPDATE block SET text = 'The harbor notes are indexed.' WHERE text LIKE 'The lighthouse%'",
      );
      expect(captureCanonicalSnapshot(db)).not.toEqual(before);
      expect(captureFtsResults(db, ["lighthouse"])).not.toEqual(ftsBefore);
      assertDatabaseIntegrity(db);
    } finally {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("notices a stored message whose raw record changed", () => {
    const { db, dir } = syncedArchive();
    try {
      const before = captureCanonicalSnapshot(db);
      db.run("UPDATE message SET raw = '{}' WHERE seq = (SELECT MIN(seq) FROM message)");
      expect(captureCanonicalSnapshot(db).message).not.toEqual(before.message);
    } finally {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails the integrity check when the search index loses a row", () => {
    const { db, dir } = syncedArchive();
    try {
      assertDatabaseIntegrity(db);
      db.run(
        `INSERT INTO block_fts(block_fts, rowid, text, tool_name, tool_input)
         SELECT 'delete', id, text, tool_name, tool_input FROM block WHERE text IS NOT NULL LIMIT 1`,
      );
      expect(() => assertDatabaseIntegrity(db)).toThrow();
    } finally {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
