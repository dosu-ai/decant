import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import { toMarkdown } from "../src/export.ts";
import { upsertSession } from "../src/ingest.ts";
import { getSession, getSessionOutline } from "../src/query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-show-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const SOURCE_ID = "5b0c7d6e-0000-4000-8000-00000000abcd";
const BUILD_LOG = Array.from({ length: 300 }, (_, step) => `build step ${step} ok`).join("\n");
// The cut for --max-chars 40 lands between the two halves of the emoji.
const EMOJI_TEXT = `${"a".repeat(39)}\u{1F600}${"b".repeat(60)}`;

function line(type: "user" | "assistant", second: number, content: unknown): string {
  return JSON.stringify({
    type,
    sessionId: SOURCE_ID,
    timestamp: `2026-08-01T10:00:${String(second).padStart(2, "0")}.000Z`,
    cwd: "/work/demo",
    message: { role: type, content },
  });
}

/** Six messages: two prompts, a tool call with long output, and three replies. */
const TRANSCRIPT = [
  line("user", 0, "Summarize the build log"),
  line("assistant", 1, [
    { type: "thinking", thinking: "Read the log before answering." },
    { type: "text", text: "Reading the log." },
    { type: "tool_use", id: "toolu_log", name: "Bash", input: { command: "cat build.log" } },
  ]),
  line("user", 2, [{ type: "tool_result", tool_use_id: "toolu_log", content: BUILD_LOG }]),
  line("assistant", 3, [{ type: "text", text: EMOJI_TEXT }]),
  line("user", 4, "Thanks.   Now\nlist the slow steps"),
  line("assistant", 5, [{ type: "text", text: "No step was slow." }]),
].join("\n");

let caseCounter = 0;
function seed(): { dbPath: string; id: number; base: string[] } {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "archive.db");
  const db = openDb(dbPath);
  try {
    // A second session keeps the archive id and the source id from lining up by accident.
    upsertSession(
      db,
      parseClaudeSession(
        "other-session",
        readFileSync(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"), "utf8"),
      ),
      "/work/demo/other.jsonl",
      1,
      2,
      "hash-other",
    );
    const id = upsertSession(
      db,
      parseClaudeSession(SOURCE_ID, TRANSCRIPT),
      "/work/demo/bounded.jsonl",
      1,
      2,
      "hash-bounded",
    );
    return { dbPath, id, base: ["--db", dbPath, "--no-sync"] };
  } finally {
    closeDb(db);
  }
}

function read<T>(dbPath: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(db);
  } finally {
    closeDb(db);
  }
}

interface ShownBlock {
  block_type: string;
  text: string | null;
  tool_input: string | null;
  tool_result: string | null;
  truncated?: boolean;
  original_chars?: Record<string, number>;
}

interface ShownSession {
  messages: { seq: number; role: string; blocks: ShownBlock[] }[];
  message_count?: number;
  message_offset?: number;
  message_limit?: number | null;
  has_more_messages?: boolean;
  partial?: boolean;
  max_chars?: number;
  truncated_blocks?: number;
}

describe("show without new flags", () => {
  test("prints the whole transcript exactly as before", async () => {
    const { dbPath, id, base } = seed();
    const detail = read(dbPath, (db) => getSession(db, id));
    if (detail == null) {
      throw new Error("expected the seeded session");
    }

    const text = await runCli([...base, "show", String(id)]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toBe(toMarkdown(detail));

    const json = await runCli([...base, "--json", "show", String(id)]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    expect(json.stdout).toBe(`${JSON.stringify(detail, null, 2)}\n`);
    expect(JSON.parse(json.stdout)).not.toHaveProperty("partial");
  });
});

describe("show --outline", () => {
  test("lists every message's role, block kinds, sizes, and tool names", async () => {
    const { id, base } = seed();
    const result = await runCli([...base, "show", String(id), "--outline"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.split("\n")).toEqual([
      `session ${id} (claude_code ${SOURCE_ID}): Summarize the build log`,
      "messages: 6, replies: 3, tool calls: 1",
      "index\trole\tchars\tblocks\tprompt",
      "0\tuser\t23\ttext 23\tSummarize the build log",
      "1\tassistant\t73\tthinking 30, text 16, tool_use Bash 27",
      `2\ttool\t${BUILD_LOG.length}\ttool_result Bash ${BUILD_LOG.length}`,
      `3\tassistant\t${EMOJI_TEXT.length}\ttext ${EMOJI_TEXT.length}`,
      "4\tuser\t33\ttext 33\tThanks. Now list the slow steps",
      "5\tassistant\t17\ttext 17",
      "[showing 6 of 6 messages]",
      `[read messages: decant show ${id} --offset <index> --limit <n> --max-chars <n>]`,
      "",
    ]);

    const full = await runCli([...base, "show", String(id)]);
    expect(result.stdout.length).toBeLessThan(full.stdout.length / 5);
  });

  test("--json carries the API outline items and the totals", async () => {
    const { dbPath, id, base } = seed();
    const result = await runCli([...base, "--json", "show", String(id), "--outline"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const view = JSON.parse(result.stdout);
    expect(view).toMatchObject({
      session: { id, tool: "claude_code", source_session_id: SOURCE_ID },
      totals: { reply_count: 3, tool_call_count: 1 },
      message_count: 6,
      message_offset: 0,
      message_limit: null,
      has_more_messages: false,
      partial: false,
    });
    expect(view.messages).toHaveLength(6);
    expect(view.messages[1]).toEqual({
      index: 1,
      seq: 1,
      role: "assistant",
      chars: 73,
      blocks: [
        { type: "thinking", chars: 30 },
        { type: "text", chars: 16 },
        { type: "tool_use", chars: 27, tool_name: "Bash" },
      ],
    });
    // The same function backs GET /api/sessions/{id}/outline.
    expect(view.outline).toEqual(read(dbPath, (db) => getSessionOutline(db, id)));
    expect(view.outline.map((item: { seq: number }) => item.seq)).toEqual([0, 4]);
    expect(result.stdout).not.toContain("build step 1 ok");
  });

  test("pages with --limit and --offset and says how to continue", async () => {
    const { id, base } = seed();
    const text = await runCli([...base, "show", String(id), "--outline", "--offset", "3"]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain("[showing 3 of 6 messages from offset 3]");
    expect(text.stdout).not.toContain("next page");

    const args = ["show", String(id), "--outline", "--limit", "2", "--offset", "3"];
    const page = await runCli([...base, ...args]);
    expect(page.stdout).toContain("\n3\tassistant\t");
    expect(page.stdout).toContain("\n4\tuser\t");
    expect(page.stdout).not.toContain("\n5\tassistant\t");
    expect(page.stdout).toContain("[showing 2 of 6 messages from offset 3]");
    expect(page.stdout).toContain(`[next page: decant show ${id} --outline --offset 5 --limit 2]`);

    const json = await runCli([...base, "--json", ...args]);
    const view = JSON.parse(json.stdout);
    expect(view).toMatchObject({
      message_count: 6,
      message_offset: 3,
      message_limit: 2,
      has_more_messages: true,
      partial: true,
    });
    expect(view.messages.map((message: { index: number }) => message.index)).toEqual([3, 4]);
    // Only the prompt inside the page is listed.
    expect(view.outline.map((item: { seq: number }) => item.seq)).toEqual([4]);
  });

  test("rejects --max-chars, which has no content to cut", async () => {
    const { id, base } = seed();
    const result = await runCli([...base, "show", String(id), "--outline", "--max-chars", "10"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--max-chars does not apply to --outline");
  });
});

describe("show --limit and --offset", () => {
  test("returns the page the API route would and reports the totals", async () => {
    const { dbPath, id, base } = seed();
    const args = ["show", String(id), "--limit", "2", "--offset", "1"];
    const json = await runCli([...base, "--json", ...args]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    const shown = JSON.parse(json.stdout) as ShownSession;
    const apiPage = read(dbPath, (db) => getSession(db, id, { messageLimit: 2, messageOffset: 1 }));
    expect(shown.messages).toEqual(JSON.parse(JSON.stringify(apiPage?.messages)));
    expect(shown).toMatchObject({
      message_count: 6,
      message_offset: 1,
      message_limit: 2,
      has_more_messages: true,
      partial: true,
    });
    expect(shown).not.toHaveProperty("max_chars");
    expect(shown).not.toHaveProperty("truncated_blocks");

    const text = await runCli([...base, ...args]);
    expect(text).toMatchObject({ code: 0, stderr: "" });
    expect(text.stdout).toContain("Reading the log.");
    expect(text.stdout).toContain("build step 299 ok");
    expect(text.stdout).not.toContain("Summarize the build log\n\n## ");
    expect(text.stdout).not.toContain("No step was slow.");
    expect(text.stdout).toEndWith(
      `[showing 2 of 6 messages from offset 1]\n[next page: decant show ${id} --offset 3 --limit 2]\n`,
    );
  });

  test("the last page is partial but has nothing after it", async () => {
    const { id, base } = seed();
    const json = await runCli([...base, "--json", "show", String(id), "--offset", "4"]);
    const shown = JSON.parse(json.stdout) as ShownSession;
    expect(shown.messages.map((message) => message.seq)).toEqual([4, 5]);
    expect(shown).toMatchObject({
      message_offset: 4,
      message_limit: null,
      has_more_messages: false,
      partial: true,
    });

    const text = await runCli([...base, "show", String(id), "--offset", "4"]);
    expect(text.stdout).toEndWith("[showing 2 of 6 messages from offset 4]\n");
  });

  test("a limit that covers the session is not partial", async () => {
    const { id, base } = seed();
    const json = await runCli([...base, "--json", "show", String(id), "--limit", "50"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      message_count: 6,
      message_offset: 0,
      message_limit: 50,
      has_more_messages: false,
      partial: false,
    });
    const text = await runCli([...base, "show", String(id), "--limit", "50"]);
    expect(text.stdout).toEndWith("[showing 6 of 6 messages]\n");
  });

  test("an offset past the end shows no messages and still reports the count", async () => {
    const { id, base } = seed();
    const json = await runCli([...base, "--json", "show", String(id), "--offset", "40"]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toMatchObject({
      messages: [],
      message_count: 6,
      has_more_messages: false,
      partial: true,
    });
    const text = await runCli([...base, "show", String(id), "--offset", "40"]);
    expect(text.stdout).toEndWith("[showing 0 of 6 messages from offset 40]\n");
  });

  test("rejects values that cannot page", async () => {
    const { id, base } = seed();
    for (const flags of [
      ["--limit", "0"],
      ["--limit", "ten"],
      ["--offset", "-1"],
      ["--max-chars", "0"],
    ]) {
      const result = await runCli([...base, "show", String(id), ...flags]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`option '${flags[0]} <n>'`);
    }
  });
});

describe("show --max-chars", () => {
  test("text marks every cut with the omitted length", async () => {
    const { id, base } = seed();
    const result = await runCli([...base, "show", String(id), "--max-chars", "40"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const omitted = BUILD_LOG.length - 40;
    expect(result.stdout).toContain(
      `${BUILD_LOG.slice(0, 40)}\n` +
        `[truncated: ${omitted} of ${BUILD_LOG.length} chars omitted. ` +
        "Raise --max-chars to read more.]",
    );
    expect(result.stdout).not.toContain("build step 299 ok");
    // The emoji straddles the cut, so the whole of it is dropped.
    expect(result.stdout).toContain(
      `${"a".repeat(39)}\n[truncated: ${EMOJI_TEXT.length - 39} of ${EMOJI_TEXT.length} chars omitted.`,
    );
    // Short blocks pass through whole and unmarked.
    expect(result.stdout).toContain("Reading the log.\n\n");
    expect(result.stdout).toContain('{"command":"cat build.log"}');
    expect(result.stdout.match(/\[truncated: /g)).toHaveLength(2);
    expect(result.stdout).toEndWith(
      "[showing 6 of 6 messages]\n" +
        "[2 blocks cut at 40 chars. Raise --max-chars to read them in full.]\n",
    );
  });

  test("--json gives the original length and a flag on each cut block", async () => {
    const { id, base } = seed();
    const result = await runCli([...base, "--json", "show", String(id), "--max-chars", "40"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const shown = JSON.parse(result.stdout) as ShownSession;
    expect(shown).toMatchObject({
      message_count: 6,
      message_offset: 0,
      message_limit: null,
      has_more_messages: false,
      partial: true,
      max_chars: 40,
      truncated_blocks: 2,
    });
    const blocks = shown.messages.flatMap((message) => message.blocks);
    const toolResult = blocks.find((block) => block.block_type === "tool_result");
    expect(toolResult).toMatchObject({
      tool_result: BUILD_LOG.slice(0, 40),
      truncated: true,
      original_chars: { tool_result: BUILD_LOG.length },
    });
    const emoji = blocks.find((block) => block.text?.startsWith("aaa") === true);
    expect(emoji).toMatchObject({
      text: "a".repeat(39),
      truncated: true,
      original_chars: { text: EMOJI_TEXT.length },
    });
    const whole = blocks.filter((block) => block.truncated !== true);
    expect(whole).toHaveLength(blocks.length - 2);
    for (const block of whole) {
      expect(block).not.toHaveProperty("truncated");
      expect(block).not.toHaveProperty("original_chars");
    }
    expect(result.stdout).not.toContain("[truncated:");
  });

  test("a cap larger than every block changes nothing but the footer", async () => {
    const { dbPath, id, base } = seed();
    const detail = read(dbPath, (db) => getSession(db, id));
    if (detail == null) {
      throw new Error("expected the seeded session");
    }
    const text = await runCli([...base, "show", String(id), "--max-chars", "100000"]);
    expect(text.stdout).toBe(`${toMarkdown(detail)}[showing 6 of 6 messages]\n`);
    const json = await runCli([...base, "--json", "show", String(id), "--max-chars", "100000"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ partial: false, truncated_blocks: 0 });
  });

  test("combines with a page and carries the cap into the next-page hint", async () => {
    const { id, base } = seed();
    const result = await runCli([...base, "show", String(id), "--limit", "3", "--max-chars", "40"]);
    expect(result.stdout).toEndWith(
      "[showing 3 of 6 messages]\n" +
        `[next page: decant show ${id} --offset 3 --limit 3 --max-chars 40]\n` +
        "[1 block cut at 40 chars. Raise --max-chars to read it in full.]\n",
    );
  });
});

describe("completion", () => {
  test("offers the bounded-read flags", async () => {
    const result = await runCli(["completion", "bash"]);
    expect(result.code).toBe(0);
    for (const flag of ["--outline", "--limit", "--offset", "--max-chars"]) {
      expect(result.stdout).toContain(` ${flag} `);
    }
  });
});

describe("session lookup by source session id", () => {
  test("show and export accept the id the source tool uses", async () => {
    const { id, base } = seed();
    const byDecantId = await runCli([...base, "show", String(id)]);
    const bySourceId = await runCli([...base, "show", SOURCE_ID]);
    expect(bySourceId).toMatchObject({ code: 0, stderr: "" });
    expect(bySourceId.stdout).toBe(byDecantId.stdout);

    const outline = await runCli([...base, "--json", "show", SOURCE_ID, "--outline"]);
    expect(JSON.parse(outline.stdout).session).toMatchObject({ id, source_session_id: SOURCE_ID });

    const exported = await runCli([...base, "export", SOURCE_ID]);
    expect(exported).toMatchObject({ code: 0, stderr: "" });
    expect(exported.stdout).toBe(`${byDecantId.stdout}\n`);

    const outDir = join(workDir, `export-${caseCounter}`);
    const written = await runCli([...base, "export", SOURCE_ID, "--as", "json", "--out", outDir]);
    expect(written.code).toBe(0);
    // Files stay named by the Decant id, whichever id the caller typed.
    expect(written.stderr).toBe(`wrote ${join(outDir, `${id}.json`)}\n`);
  });

  test("an id shared by two tools is a usage error that lists both", async () => {
    const { dbPath, id, base } = seed();
    const otherId = read(dbPath, (db) => {
      const parsed = parseClaudeSession(SOURCE_ID, TRANSCRIPT);
      return upsertSession(
        db,
        { ...parsed, session: { ...parsed.session, tool: "codex" } },
        "/work/demo/shared.jsonl",
        1,
        2,
        "hash-shared",
      );
    });
    expect(otherId).not.toBe(id);

    for (const command of ["show", "export"]) {
      const result = await runCli([...base, command, SOURCE_ID]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `error: source session id "${SOURCE_ID}" matches 2 sessions. ` +
          "Pass one of these ids instead (id, tool, started):\n" +
          `  ${id}\tclaude_code\t2026-08-01T10:00:00.000Z\n` +
          `  ${otherId}\tcodex\t2026-08-01T10:00:00.000Z\n`,
      );
    }

    // Decant's own id still names exactly one of them.
    const byId = await runCli([...base, "--json", "show", String(otherId), "--outline"]);
    expect(JSON.parse(byId.stdout).session).toMatchObject({ id: otherId, tool: "codex" });
  });

  test("an unknown id exits 1 and names what was tried", async () => {
    const { base } = seed();
    const unknownSource = await runCli([...base, "show", "0e0e0e0e-not-a-session"]);
    expect(unknownSource).toMatchObject({
      code: 1,
      stdout: "",
      stderr: 'error: no session with id or source session id "0e0e0e0e-not-a-session"\n',
    });
    const unknownId = await runCli([...base, "show", "999999"]);
    expect(unknownId).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "error: no session with id 999999\n",
    });
    const exported = await runCli([...base, "export", "999999"]);
    expect(exported).toMatchObject({ code: 1, stderr: "error: no session with id 999999\n" });
  });

  test("an integer names the Decant id first and a source id only as a fallback", async () => {
    const { dbPath, id, base } = seed();
    const numeric = read(dbPath, (db) => ({
      // Its source id is another session's Decant id.
      clash: upsertSession(
        db,
        parseClaudeSession(String(id), line("user", 0, "clashing numeric id")),
        "/work/demo/clash.jsonl",
        1,
        2,
        "hash-clash",
      ),
      // Its source id is an integer no Decant id uses.
      free: upsertSession(
        db,
        parseClaudeSession("424242", line("user", 0, "free numeric id")),
        "/work/demo/free.jsonl",
        1,
        2,
        "hash-free",
      ),
    }));

    const byDecantId = await runCli([...base, "--json", "show", String(id), "--outline"]);
    expect(JSON.parse(byDecantId.stdout).session).toMatchObject({
      id,
      source_session_id: SOURCE_ID,
    });
    expect(numeric.clash).not.toBe(id);

    const fallback = await runCli([...base, "--json", "show", "424242", "--outline"]);
    expect(JSON.parse(fallback.stdout).session).toMatchObject({
      id: numeric.free,
      source_session_id: "424242",
    });
  });
});
