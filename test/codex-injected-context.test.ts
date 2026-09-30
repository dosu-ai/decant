import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { tokenEconomics } from "../src/token-economics.ts";

const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 22, 0, s)).toISOString();
const item = (s: number, payload: object) =>
  JSON.stringify({ type: "response_item", timestamp: at(s), payload });
const message = (s: number, role: string, ...content: object[]) =>
  item(s, { type: "message", role, content });
const text = (value: string) => ({ type: "input_text", text: value });

// A synthetic rollout shaped like current Codex: developer instructions and the
// AGENTS.md/environment block arrive as their own messages before each prompt.
const lines = [
  `{"type":"session_meta","timestamp":"${at(0)}","payload":{"id":"sess-injected","cwd":"/w","originator":"codex_cli_rs","cli_version":"0.160.0","source":"cli","model_provider":"openai"}}`,
  `{"type":"turn_context","timestamp":"${at(0)}","payload":{"cwd":"/w","model":"gpt-6.1-sol","effort":"low"}}`,
  message(0, "developer", text("<permissions instructions>\nSandbox: workspace-write")),
  message(
    0,
    "user",
    text("# AGENTS.md instructions for /w\n\nRun bun test before committing."),
    text("<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"),
  ),
  message(1, "user", text("Fix the flaky clock test")),
  item(20, {
    type: "function_call",
    name: "exec_command",
    call_id: "c1",
    arguments: '{"cmd":"bun test"}',
  }),
  item(21, { type: "function_call_output", call_id: "c1", output: "1 pass" }),
  // A hook injects guidance mid-turn; the model, not the user, closes this gap.
  message(50, "developer", text("<context_window>\n50% used\n</context_window>")),
  message(80, "assistant", { type: "output_text", text: "Fixed; the test passes." }),
  message(270, "user", text("<environment_context>\n  <cwd>/w</cwd>\n</environment_context>")),
  message(271, "user", text("Now add a changelog entry")),
  message(271, "user", text("<environment_context>\n</environment_context>"), {
    type: "input_image",
    image_url: "data:image/png;base64,AAAA",
  }),
  `{"type":"event_msg","timestamp":"${at(279)}","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":60,"reasoning_output_tokens":0,"total_tokens":5060}}}}`,
  message(280, "assistant", { type: "output_text", text: "Added." }),
];
const rollout = `${lines.join("\n")}\n`;

describe("Codex injected context", () => {
  test("parses developer messages and injected context as system rows, not user turns", () => {
    const { session } = parseCodexSession("fallback", rollout, new Map());
    const roles = session.messages.map((row) => row.role);
    expect(roles).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "tool",
      "system",
      "assistant",
      "system",
      "user",
      // An attached image makes the message the user's own, whatever else it holds.
      "user",
      "assistant",
    ]);
    expect(session.title).toBe("Fix the flaky clock test");
  });

  test("counts only typed prompts as turns and their gaps as waiting on the user", () => {
    const dir = mkdtempSync(join(tmpdir(), "decant-codex-injected-"));
    try {
      const db = openDb(join(dir, "decant.db"));
      upsertSession(
        db,
        parseCodexSession("fallback", rollout, new Map()),
        "/x/injected.jsonl",
        1,
        2,
        "codex",
      );
      const { turn_count } = db.query("SELECT turn_count FROM session").get() as {
        turn_count: number;
      };
      expect(turn_count).toBe(3);
      const economics = tokenEconomics(db);
      // 80s -> 271s is the only wait the user caused; the injected rows at 50s
      // and 270s neither claim time nor split the gaps around them.
      expect(economics.totals.waiting_on_user_ms).toBe(191_000);
      expect(economics.totals.active_ms).toBe(88_000);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
