import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import {
  getSession,
  getSessionOutline,
  type ListFilter,
  listProjects,
  listSessions,
  listToolCalls,
  search,
  searchPage,
  sessionIngestIssues,
} from "../src/query.ts";
import { SEARCH_MATCH_END, SEARCH_MATCH_START } from "../src/search-query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { preview } from "../src/tools.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-query-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `query-${dbCounter}.db`));
}

function seeded(): Database {
  const db = freshDb();
  const content = readFileSync(
    join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
    "utf8",
  );
  const parsed = parseClaudeSession("sess-claude-1", content);
  upsertSession(db, parsed, "/x.jsonl", 1, 2, "h");
  return db;
}

describe("query reads", () => {
  test("lists, gets, and searches sessions", () => {
    const db = seeded();

    const list = listSessions(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("Fix the failing auth test");

    const detail = getSession(db, list[0]?.id ?? 0);
    expect(detail).not.toBeNull();
    expect(detail?.messages).toHaveLength(4);
    expect(
      detail?.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.block_type === "tool_result"),
    ).toMatchObject({ tool_name: "Read", tool_use_id: "toolu_1" });

    const hits = search(db, "auth", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.tool).toBe("claude_code");
    db.close();
  });

  test("returns the normalized levels behind a mixed effort summary", () => {
    const db = freshDb();
    const parsed = parseClaudeSession(
      "mixed-effort",
      [
        '{"type":"assistant","effort":"high","message":{"role":"assistant","content":[]}}',
        '{"type":"assistant","effort":"max","message":{"role":"assistant","content":[]}}',
      ].join("\n"),
    );
    const id = upsertSession(db, parsed, "/mixed.jsonl", 1, 2, "mixed");

    expect(listSessions(db)[0]).toMatchObject({
      id,
      reasoning_effort: "mixed",
      reasoning_effort_levels: ["high", "max"],
    });
    expect(getSession(db, id)?.summary).toMatchObject({
      reasoning_effort: "mixed",
      reasoning_effort_levels: ["high", "max"],
    });

    db.query("UPDATE session SET reasoning_effort_levels = '' WHERE id = ?").run(id);
    expect(listSessions(db)[0]?.reasoning_effort_levels).toEqual([]);
    expect(getSession(db, id)?.summary.reasoning_effort_levels).toEqual([]);
    db.close();
  });

  test("pages session messages and returns a lightweight complete navigation outline", () => {
    const db = seeded();
    const id = listSessions(db)[0]?.id ?? 0;

    expect(getSession(db, id, { messageLimit: 2, messageOffset: 0 })).toMatchObject({
      messages: [{ seq: 0 }, { seq: 1 }],
      message_offset: 0,
      message_limit: 2,
      has_more_messages: true,
    });
    expect(getSession(db, id, { messageLimit: 2, messageOffset: 2 })).toMatchObject({
      messages: [{ seq: 2 }, { seq: 3 }],
      message_offset: 2,
      message_limit: 2,
      has_more_messages: false,
    });
    expect(getSessionOutline(db, id)).toEqual([
      {
        seq: 0,
        text: "Fix the failing auth test",
        kind: "prompt",
        ordinal: -1,
      },
    ]);
    expect(getSessionOutline(db, 999_999)).toBeNull();
    db.close();
  });

  test("session totals cover the whole session, not the requested page", () => {
    const db = seeded();
    const id = listSessions(db)[0]?.id ?? 0;

    const whole = getSession(db, id);
    const totals = whole?.totals;
    if (totals == null) {
      throw new Error("a real session read must carry totals");
    }
    // Guard against a vacuous assertion: a session with nothing to count would
    // let a page-scoped implementation pass this test unchanged.
    expect(totals.reply_count).toBeGreaterThan(0);
    expect(totals.tool_call_count).toBeGreaterThan(0);

    // The first page deliberately excludes later replies and tool calls, so a
    // count taken over `messages` would come back smaller here.
    const firstPage = getSession(db, id, { messageLimit: 1, messageOffset: 0 });
    expect(firstPage?.has_more_messages).toBe(true);
    expect(firstPage?.totals).toEqual(totals);

    const repliesOnPage = (firstPage?.messages ?? []).filter(
      (message) => message.role === "assistant",
    ).length;
    expect(repliesOnPage).toBeLessThan(totals.reply_count ?? 0);

    // The aggregate must agree with the reader's own rule, or the header would
    // contradict a transcript the reader can count by hand. Recomputed here the
    // way the UI does it, over a fully loaded session.
    const renderable = (whole?.messages ?? []).filter(
      (message) =>
        message.is_compact_boundary ||
        message.blocks.some((block) =>
          block.block_type === "text" || block.block_type === "thinking"
            ? (block.text ?? "").trim() !== ""
            : block.block_type === "tool_use" || block.block_type === "tool_result",
        ),
    );
    expect(renderable.filter((message) => message.role === "assistant").length).toBe(
      totals.reply_count,
    );
    expect(
      renderable.reduce(
        (sum, message) =>
          sum + message.blocks.filter((block) => block.block_type === "tool_use").length,
        0,
      ),
    ).toBe(totals.tool_call_count);

    // Stubs carry structure and a summary but no messages, so they carry no
    // totals either rather than reporting a misleading zero.
    for (const subagent of whole?.subagents ?? []) {
      expect(subagent.totals).toBeUndefined();
    }
    db.close();
  });

  test("listSessions filters by tool, offset, and uses the default limit", () => {
    const db = seeded();
    upsertSession(
      db,
      parseClaudeSession(
        "sess-claude-2",
        readFileSync(join(import.meta.dir, "..", "fixtures", "claude", "enriched.jsonl"), "utf8"),
      ),
      "/y.jsonl",
      1,
      2,
      "h2",
    );
    const claude = listSessions(db, { tool: "claude_code", limit: 10 });
    expect(claude).toHaveLength(2);

    const codex = listSessions(db, { tool: "codex", limit: 10 });
    expect(codex).toEqual([]);

    const defaulted = listSessions(db, { limit: 0 } satisfies ListFilter);
    expect(defaulted).toHaveLength(2);
    expect(listSessions(db, { limit: 1, offset: 1 })).toHaveLength(1);
    db.close();
  });

  test("session summaries use the first real user prompt as the display title", () => {
    const db = freshDb();
    const realPrompt =
      "Given this thread with Joseph, what I would like to do is have this application proactively use Apollo to get information about all of the leads, targets, and connections that we have stored in the app.";
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES (1, 'claude_code', 'wrapped', '<local-command-caveat>Caveat text</local-command-caveat>', '2026-07-05T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 1, 1, 'user', '{}'),
        (3, 1, 2, 'user', '{}'),
        (4, 1, 3, 'user', '{}'),
        (5, 1, 4, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 1, 0, 'text', '<permissions instructions>Filesystem sandboxing defines which files can be read or written.</permissions instructions>'),
        (2, 1, 0, 'text', '<environment_context><cwd>/repo</cwd><shell>zsh</shell></environment_context>'),
        (3, 1, 0, 'text', 'The following is the Codex agent history whose request action you are reviewing.'),
        (4, 1, 0, 'text', '<local-command-stdout>Set model to Fable 5 and saved as your default for new sessions</local-command-stdout>'),
        (5, 1, 0, 'text', '${realPrompt}');
    `);

    expect(listSessions(db)[0]?.title).toBe(preview(realPrompt, 180));
    expect(getSession(db, 1)?.summary.title).toBe(preview(realPrompt, 180));
    db.close();
  });

  test("a real user prompt takes precedence over a stored summary title", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES (1, 'codex', 'summary-first', 'Stored parser summary', '2026-07-05T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES (1, 1, 0, 'user', '{"type":"response_item","payload":{"type":"message","role":"user"}}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES (1, 1, 0, 'text', 'The actual first user request');
    `);

    expect(listSessions(db)[0]?.title).toBe("The actual first user request");
    db.close();
  });

  test("session summaries hide local-command-only artifacts and reject generated titles", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES
        (1, 'codex', 'permissions', '<permissions instructions>Filesystem sandboxing defines which files can be read or written.</permissions instructions>', '2026-07-05T00:00:00Z', 0),
        (2, 'claude_code', 'command', '<local-command-caveat>Caveat: generated by local command</local-command-caveat>', '2026-07-05T00:00:01Z', 0);
    `);

    expect(listSessions(db, { limit: 10 }).map((session) => session.title)).toEqual([null]);
    db.close();
  });

  test("local command context remains visible when a human prompt or assistant reply follows", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES
        (1, 'claude_code', 'human-after-command',
         '<local-command-caveat>Generated command context</local-command-caveat>',
         '2026-07-05T00:00:00Z', 0),
        (2, 'claude_code', 'assistant-after-command',
         '<local-command-caveat>Generated command context</local-command-caveat>',
         '2026-07-05T00:00:01Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 1, 1, 'user', '{}'),
        (3, 2, 0, 'user', '{}'),
        (4, 2, 1, 'assistant', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 1, 0, 'text', '<command-name>/model</command-name>'),
        (2, 1, 0, 'text', 'Continue with my actual request'),
        (3, 2, 0, 'text', '<command-name>/model</command-name>'),
        (4, 2, 0, 'text', 'Assistant response');
    `);

    expect(listSessions(db, { limit: 10 }).map((session) => session.source_session_id)).toEqual([
      "assistant-after-command",
      "human-after-command",
    ]);
    expect(listSessions(db, { limit: 10 })[1]?.title).toBe("Continue with my actual request");
    db.close();
  });

  test("session summaries ignore Codex developer prompts and use the first source user message", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES (1, 'codex', 'developer-context',
              'You are \`/root\`, the primary agent in a team of agents.',
              '2026-07-05T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{"type":"response_item","payload":{"type":"message","role":"developer"}}'),
        (2, 1, 1, 'user', '{"type":"response_item","payload":{"type":"message","role":"developer"}}'),
        (3, 1, 2, 'user', '{"type":"response_item","payload":{"type":"message","role":"user"}}'),
        (4, 1, 3, 'user', '{"type":"response_item","payload":{"type":"message","role":"user"}}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 1, 0, 'text', '<permissions instructions>Sandbox policy</permissions instructions>'),
        (2, 1, 0, 'text', 'You are \`/root\`, the primary agent in a team of agents.'),
        (3, 1, 0, 'text', '# AGENTS.md instructions for /repo <INSTRUCTIONS>Generated repo context</INSTRUCTIONS>'),
        (4, 1, 0, 'text', 'Build the first meaningful human request');
    `);

    expect(listSessions(db)[0]?.title).toBe("Build the first meaningful human request");
    expect(getSession(db, 1)?.summary.title).toBe("Build the first meaningful human request");
    db.close();
  });

  test("subagent titles use their own sidechain task and extract fork directives", () => {
    const db = freshDb();
    const fork = [
      "<fork-boilerplate>You are a worker fork.</fork-boilerplate>",
      "",
      "Your directive: Reconcile origin/main into the current branch.",
      "",
      "SITUATION: main advanced.",
    ].join("\n");
    db.exec(`
      INSERT INTO session(
        id, tool, source_session_id, title, started_at, is_subagent,
        context_window_tokens, peak_context_tokens, compaction_count
      )
      VALUES
        (1, 'claude_code', 'parent', NULL, '2026-07-05T00:00:00Z', 0, 200000, 100000, 1),
        (2, 'claude_code', 'child', '${fork}', '2026-07-05T00:00:01Z', 1, 200000, 160000, 2);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{"isSidechain":true}'),
        (2, 1, 1, 'user', '{}'),
        (3, 2, 0, 'user', '{"isSidechain":true}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 1, 0, 'text', 'Child-only task embedded in the parent'),
        (2, 1, 0, 'text', 'Human parent prompt'),
        (3, 2, 0, 'text', '${fork}');
    `);

    expect(listSessions(db)[0]?.title).toBe("Human parent prompt");
    expect(listSessions(db, { includeSubagents: true })[0]).toMatchObject({
      title: "Reconcile origin/main into the current branch.",
      context_window_tokens: 200000,
      peak_context_tokens: 160000,
      compaction_count: 2,
    });
    db.close();
  });

  test("subagent titles use the full teammate summary instead of the parser fallback", () => {
    const db = freshDb();
    const summary =
      "Review the complete feature branch for correctness, regressions, and missing focused tests";
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES (1, 'claude_code', 'teammate-child', NULL, '2026-07-05T00:00:00Z', 1);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES (1, 1, 0, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES (
        1, 1, 0, 'text',
        '<teammate-message teammate_id="reviewer" summary="${summary}">Generated coordination details</teammate-message>'
      );
    `);

    expect(listSessions(db, { includeSubagents: true })[0]?.title).toBe(summary);
    db.close();
  });

  test("getSession returns null for an unknown id", () => {
    const db = seeded();
    expect(getSession(db, 999_999)).toBeNull();
    db.close();
  });

  test("getSession assembles nested subagent trees with display titles", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent,
                          parent_session_id, spawn_tool_use_id, agent_id, agent_type,
                          spawn_depth, estimated_cost_usd, message_count)
      VALUES
        (1, 'claude_code', 'root', NULL, '2026-07-01T00:00:00Z', 0, NULL, NULL, NULL, NULL, NULL, 1.0, 1),
        (2, 'claude_code', 'kid-a', NULL, '2026-07-01T00:01:00Z', 1, 1, 'tu-a', 'agent-a', 'Explore', 1, 0.5, 1),
        (3, 'claude_code', 'kid-b', NULL, '2026-07-01T00:02:00Z', 1, 1, 'tu-b', 'agent-b', 'Plan', 1, 0.25, 1),
        (4, 'claude_code', 'grandkid', NULL, '2026-07-01T00:03:00Z', 1, 2, 'tu-c', 'agent-c', 'Explore', 2, 0.125, 1);
      INSERT INTO message(id, session_id, seq, role, raw) VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 2, 0, 'user', '{}'),
        (3, 3, 0, 'user', '{}'),
        (4, 4, 0, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text) VALUES
        (1, 1, 0, 'text', 'Root prompt'),
        (2, 2, 0, 'text', 'Child A prompt'),
        (3, 3, 0, 'text', 'Child B prompt'),
        (4, 4, 0, 'text', 'Grandchild prompt');
    `);

    const detail = getSession(db, 1);
    expect(detail?.summary.title).toBe("Root prompt");
    expect(detail?.summary.subagent_count).toBe(2);
    expect(detail?.summary.subagent_estimated_cost_usd).toBeCloseTo(0.75);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.subagents.map((child) => child.summary.title)).toEqual([
      "Child A prompt",
      "Child B prompt",
    ]);
    expect(detail?.subagents[0]).toMatchObject({
      spawn_tool_use_id: "tu-a",
      agent_id: "agent-a",
      agent_type: "Explore",
      spawn_depth: 1,
    });
    expect(detail?.subagents[0]?.messages).toEqual([]);
    expect(detail?.subagents[0]?.subagents.map((child) => child.summary.title)).toEqual([
      "Grandchild prompt",
    ]);
    expect(detail?.subagents[1]?.subagents).toEqual([]);
    db.close();
  });

  test("getSession caps subagent nesting at five levels below the root", () => {
    const db = freshDb();
    const rows: string[] = ["(1, 'claude_code', 'chain-0', '2026-07-01T00:00:00Z', 0, NULL)"];
    for (let id = 2; id <= 8; id += 1) {
      rows.push(
        `(${id}, 'claude_code', 'chain-${id - 1}', '2026-07-01T00:0${id - 1}:00Z', 1, ${id - 1})`,
      );
    }
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at, is_subagent, parent_session_id)
      VALUES ${rows.join(", ")};
    `);

    const detail = getSession(db, 1);
    let level = 0;
    let cursor = detail?.subagents ?? [];
    while (cursor.length > 0) {
      level += 1;
      cursor = cursor[0]?.subagents ?? [];
    }
    expect(level).toBe(5);
    db.close();
  });

  test("derives Dosu provenance only from exact normalized MCP evidence", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent,
                          parent_session_id)
      VALUES
        (1, 'claude_code', 'dosu-root', 'Root', '2026-07-01T00:00:00Z', 0, NULL),
        (2, 'codex', 'dosu-child', 'Child', '2026-07-01T00:01:00Z', 1, 1),
        (3, 'claude_code', 'text-only', 'Dosu mentioned in text',
         '2026-07-01T00:02:00Z', 0, NULL);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 3, 0, 'user', '{}'),
        (2, 1, 0, 'user', '{}'),
        (3, 1, 1, 'assistant', '{}'),
        (4, 1, 2, 'assistant', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 3, 0, 'text', 'Dosu was mentioned, but no MCP call happened.'),
        (2, 1, 0, 'text', 'Investigate the failing workflow.');
      INSERT INTO tool_call(
        session_id, message_id, ordinal, tool_kind, tool_name, mcp_server, tool_base_name
      )
      VALUES
        (1, 3, 0, 'mcp', 'mcp__dosu__read_knowledge', 'dosu', 'read_knowledge'),
        (1, 4, 0, 'mcp', 'mcp__claude_ai_Dosu__search', 'claude_ai_Dosu', 'search'),
        (1, NULL, 0, 'mcp', 'mcp__github__search', 'github', 'search'),
        (1, NULL, 0, 'mcp', 'mcp__my_dosu_proxy__search', 'my_dosu_proxy', 'search'),
        (1, NULL, 0, 'builtin', 'dosu', 'dosu', 'dosu'),
        (2, NULL, 0, 'mcp', 'mcp__dosu__save_topic', 'dosu', 'save_topic');
    `);

    const roots = listSessions(db, { includeNestedSubagents: true, limit: 10 });
    const root = roots.find((session) => session.id === 1);
    const textOnly = roots.find((session) => session.id === 3);
    expect(root).toMatchObject({
      dosu_mcp_direct_calls: 2,
      dosu_mcp_tree_calls: 3,
      subagents: [
        expect.objectContaining({
          id: 2,
          dosu_mcp_direct_calls: 1,
          dosu_mcp_tree_calls: 1,
        }),
      ],
    });
    expect(textOnly).toMatchObject({
      dosu_mcp_direct_calls: 0,
      dosu_mcp_tree_calls: 0,
    });
    expect(listSessions(db, { limit: 1 })[0]).toMatchObject({
      id: 3,
      dosu_mcp_direct_calls: 0,
      dosu_mcp_tree_calls: 0,
    });

    const detail = getSession(db, 1);
    expect(detail?.summary).toMatchObject({
      dosu_mcp_direct_calls: 2,
      dosu_mcp_tree_calls: 3,
    });
    expect(detail?.subagents[0]?.summary).toMatchObject({
      dosu_mcp_direct_calls: 1,
      dosu_mcp_tree_calls: 1,
    });
    expect(getSessionOutline(db, 1)).toEqual([
      {
        seq: 0,
        text: "Investigate the failing workflow.",
        kind: "prompt",
        ordinal: -1,
      },
      { seq: 1, text: "read_knowledge", kind: "dosu", ordinal: 0 },
      { seq: 2, text: "search", kind: "dosu", ordinal: 0 },
    ]);
    db.close();
  });

  test("sessionIngestIssues returns typed rows joined by source path", () => {
    const db = freshDb();
    const content = readFileSync(
      join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
      "utf8",
    );
    const withBadLine = `${content}not json\n`;
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-issues", withBadLine),
      "/issues.jsonl",
      1,
      2,
      "h",
    );
    // upsertSession does not write ingest_issue (writeIngestedFile does); simulate the sync path:
    db.query(
      `INSERT INTO ingest_issue (source_path, line_no, error, raw_line, code, created_at)
       VALUES ('/issues.jsonl', 99, 'x', 'not json', 'unparsed_line', datetime('now'))`,
    ).run();
    const issues = sessionIngestIssues(db, sessionId);
    expect(issues).toEqual([
      {
        code: "unparsed_line",
        line_no: 99,
        error: "x",
        raw_line: "not json",
        created_at: expect.any(String),
      },
    ]);
    expect(sessionIngestIssues(db, 999_999)).toBeNull();
    const detail = getSession(db, sessionId);
    expect(detail?.summary.ingest_issue_count).toBe(1);
    expect(listSessions(db)[0]?.ingest_issue_count).toBe(1);

    // A session with no source file cannot match issue rows by path, and must
    // not fall through to every row whose source_path is also NULL.
    db.exec("INSERT INTO session(tool, source_session_id) VALUES ('claude_code', 'no-source')");
    db.query("INSERT INTO ingest_issue (source_path, error, code) VALUES (NULL, 'y', 'x')").run();
    const pathless = db
      .query("SELECT id FROM session WHERE source_session_id = 'no-source'")
      .get() as { id: number };
    expect(sessionIngestIssues(db, pathless.id)).toEqual([]);
    db.close();
  });

  test("session summaries separate actionable ingest failures from informational sensors", () => {
    const db = seeded();
    const sessionId = listSessions(db)[0]?.id ?? 0;
    db.query(
      `INSERT INTO ingest_issue (source_path, line_no, error, raw_line, code, created_at)
       VALUES ('/x.jsonl', 9, 'unknown record', NULL, 'unknown_record_type', datetime('now'))`,
    ).run();

    expect(getSession(db, sessionId)?.summary).toMatchObject({
      ingest_issue_count: 0,
      informational_ingest_issue_count: 1,
    });
    expect(listSessions(db)[0]).toMatchObject({
      ingest_issue_count: 0,
      informational_ingest_issue_count: 1,
    });
    db.close();
  });

  test("search with no match returns empty", () => {
    const db = seeded();
    expect(search(db, "zzznotpresentzzz", 10)).toEqual([]);
    db.close();
  });

  test("search returns matching-column snippets, deep links, totals, and pagination", () => {
    const db = seeded();
    const page = searchPage(db, "auth", { limit: 1 });
    expect(page.total).toBeGreaterThan(1);
    expect(page.results).toHaveLength(1);
    expect(page.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(page.total_is_capped).toBe(false);
    expect(page.results[0]).toMatchObject({
      session_title: "Fix the failing auth test",
      tool: "claude_code",
      project: "/Users/dev/proj",
      role: expect.any(String),
      block_type: expect.any(String),
      message_seq: expect.any(Number),
      timestamp: expect.any(String),
      href: expect.stringMatching(/^\/sessions\/\d+#message-\d+$/),
    });

    const second = searchPage(db, "auth", { limit: 1, offset: 1 });
    expect(second.total).toBe(page.total);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]?.block_id).not.toBe(page.results[0]?.block_id);

    const toolInputHit = searchPage(db, "auth_test.py").results.find(
      (hit) => hit.block_type === "tool_use",
    );
    expect(toolInputHit?.snippet).toContain(`${SEARCH_MATCH_START}auth_test.py${SEARCH_MATCH_END}`);
    expect(toolInputHit?.snippet).not.toBe("Read");
    db.close();
  });

  test("search caps pages at 100 and applies session visibility and scope filters", () => {
    const db = seeded();
    const visibleSessionId = listSessions(db)[0]?.id ?? 0;
    const visibleMessageId = (
      db
        .query("SELECT id FROM message WHERE session_id = ? ORDER BY seq LIMIT 1")
        .get(visibleSessionId) as { id: number }
    ).id;
    const insertBlock = db.prepare(
      "INSERT INTO block(message_id, session_id, ordinal, type, text) VALUES (?, ?, ?, 'text', ?)",
    );
    for (let index = 0; index < 110; index += 1) {
      insertBlock.run(visibleMessageId, visibleSessionId, 1000 + index, `bulkneedle ${index}`);
    }
    expect(searchPage(db, "bulkneedle", { limit: 10_000 })).toMatchObject({
      total: 110,
      results: expect.any(Array),
    });
    expect(searchPage(db, "bulkneedle", { limit: 10_000 }).results).toHaveLength(100);
    expect(searchPage(db, "bulkneedle", { limit: 100, offset: 100 }).results).toHaveLength(10);
    expect(search(db, "bulkneedle", 500)).toHaveLength(110);
    for (let index = 0; index < 1_001; index += 1) {
      insertBlock.run(visibleMessageId, visibleSessionId, 2_000 + index, `capneedle ${index}`);
    }
    expect(searchPage(db, "capneedle")).toMatchObject({
      total: 1_000,
      total_is_capped: true,
    });

    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES
        (100, 'claude_code', 'search-subagent', 'subagent', '2026-05-01T00:00:00Z', 1),
        (101, 'claude_code', 'search-hidden', '<local-command-caveat>hidden</local-command-caveat>', '2026-05-01T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (100, 100, 0, 'user', '{}'),
        (101, 101, 0, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (100, 100, 0, 'text', 'visibilityneedle'),
        (101, 101, 0, 'text', '<local-command-stdout>visibilityneedle</local-command-stdout>');
    `);
    insertBlock.run(visibleMessageId, visibleSessionId, 999, "visibilityneedle");

    expect(searchPage(db, "visibilityneedle").total).toBe(1);
    expect(searchPage(db, "visibilityneedle", { includeSubagents: true }).total).toBe(2);
    expect(searchPage(db, "auth", { tool: "codex" }).total).toBe(0);
    expect(searchPage(db, "auth", { project: "/Users/dev/proj" }).total).toBeGreaterThan(0);
    expect(searchPage(db, "auth", { project: "/elsewhere" }).total).toBe(0);
    expect(searchPage(db, "auth", { from: "2026-05-02" }).total).toBe(0);
    expect(searchPage(db, "auth", { to: "2026-04-30" }).total).toBe(0);
    db.close();
  });

  test("lists tool calls with drill-down metadata, tri-state errors, filters, and pagination", () => {
    const db = seeded();
    const session = listSessions(db)[0];
    if (session == null) {
      throw new Error("seeded session must exist");
    }
    db.query(
      `INSERT INTO tool_call(
         session_id, tool_kind, tool_name, mcp_server, is_error, has_result, ordinal
       ) VALUES (?, NULL, NULL, 'legacy-server', NULL, NULL, 99)`,
    ).run(session.id);

    const page = listToolCalls(db);
    expect(page).toMatchObject({
      total: 2,
      limit: 50,
      offset: 0,
      summary: {
        calls: 2,
        errors: 0,
        p50_ms: 1000,
        p95_ms: 1000,
      },
    });
    expect(page.calls[0]).toMatchObject({
      session_id: session.id,
      session_title: "Fix the failing auth test",
      project: "/Users/dev/proj",
      tool_name: "Read",
      tool_kind: "builtin",
      mcp_server: null,
      input_preview: expect.stringContaining("auth_test.py"),
      input_bytes: expect.any(Number),
      output_preview: "def test_auth(): assert login()",
      output_bytes: expect.any(Number),
      is_error: false,
      has_result: true,
      duration_ms: 1000,
      timestamp: "2026-05-01T10:00:05.000Z",
      seq: expect.any(Number),
    });
    expect(page.calls[1]).toMatchObject({
      tool_name: null,
      tool_kind: null,
      mcp_server: "legacy-server",
      input_preview: null,
      input_bytes: null,
      output_preview: null,
      output_bytes: null,
      is_error: null,
      has_result: null,
      duration_ms: null,
      timestamp: null,
      seq: null,
    });

    expect(listToolCalls(db, { server: "legacy-server" }).calls).toHaveLength(1);
    expect(listToolCalls(db, { tool: "Read", minMs: 1000 }).calls).toHaveLength(1);
    expect(listToolCalls(db, { tool: "Read", minMs: 1001 }).calls).toHaveLength(0);
    expect(listToolCalls(db, { sessionId: session.id }).total).toBe(2);
    expect(listToolCalls(db, { project: "/Users/dev/proj" }).total).toBe(2);
    expect(listToolCalls(db, { from: "2026-05-01", to: "2026-05-01" }).total).toBe(1);
    expect(listToolCalls(db, { errorsOnly: true }).total).toBe(0);
    expect(listToolCalls(db, { tool: "Read", minMs: 1000 }).summary).toEqual({
      calls: 1,
      errors: 0,
      p50_ms: 1000,
      p95_ms: 1000,
    });
    expect(listToolCalls(db, { tool: "missing" }).summary).toEqual({
      calls: 0,
      errors: 0,
      p50_ms: null,
      p95_ms: null,
    });
    expect(listToolCalls(db, { limit: 10_000 }).limit).toBe(100);
    expect(listToolCalls(db, { limit: 1, offset: 1 })).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      calls: [expect.objectContaining({ mcp_server: "legacy-server" })],
      summary: null,
    });
    db.close();
  });

  test("tool-call summary covers the complete filtered result rather than one page", () => {
    const db = seeded();
    const sessionId = listSessions(db)[0]?.id ?? 0;
    const insert = db.prepare(
      `INSERT INTO tool_call(
         session_id, tool_kind, tool_name, is_error, duration_ms, timestamp, ordinal
       ) VALUES (?, 'builtin', 'Bulk', ?, ?, ?, ?)`,
    );
    for (let duration = 1; duration <= 100; duration += 1) {
      insert.run(
        sessionId,
        duration === 100 ? 1 : 0,
        duration,
        `2026-05-01T11:${String(Math.floor(duration / 60)).padStart(2, "0")}:${String(
          duration % 60,
        ).padStart(2, "0")}.000Z`,
        100 + duration,
      );
    }

    const page = listToolCalls(db, { tool: "Bulk", limit: 1 });
    expect(page.calls).toHaveLength(1);
    expect(page.summary).toEqual({
      calls: 100,
      errors: 1,
      p50_ms: 50,
      p95_ms: 95,
    });
    expect(page.summary).not.toBeNull();
    expect(page.total).toBe(page.summary?.calls ?? 0);
    db.close();
  });

  test("tool-call browse and summary exclude generated local-command-only sessions", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at)
      VALUES (
        1,
        'claude_code',
        'hidden-command',
        '<local-command-caveat>Generated command context</local-command-caveat>',
        '2026-07-05T00:00:00Z'
      );
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES (1, 1, 0, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES (1, 1, 0, 'text', '<command-name>/exit</command-name>');
      INSERT INTO tool_call(
        session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, ordinal
      ) VALUES (1, 'mcp', 'HiddenCommandTool', 'hidden', 1, 500, 0);
    `);

    expect(listToolCalls(db)).toMatchObject({
      calls: [],
      total: 0,
      summary: {
        calls: 0,
        errors: 0,
        p50_ms: null,
        p95_ms: null,
      },
    });
    db.close();
  });

  test("listProjects rolls up session counts and cost", () => {
    const db = seeded();
    const projects = listProjects(db);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.sessions).toBe(1);
    expect(projects[0]?.path).toBe("/Users/dev/proj");
    expect(projects[0]?.estimated_cost_usd).toBeGreaterThan(0);
    db.close();
  });

  test("listProjects exposes worktree source metadata and top-level session counts", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO project(id, path, name, is_worktree, root_path, worktree_label, worktree_tool, root_source)
      VALUES
        (1, '/repo/decant', 'decant', 0, '/repo/decant', NULL, NULL, 'self'),
        (2, '/repo/decant/.claude-worktrees/feature-auth', 'feature-auth', 1, '/repo/decant', 'feature-auth', 'claude', 'intree');
      INSERT INTO session(tool, source_session_id, project_id, estimated_cost_usd, is_subagent)
      VALUES
        ('claude_code', 'root', 1, 1.25, 0),
        ('codex', 'child', 1, 0.25, 1),
        ('claude_code', 'worktree', 2, 0.5, 0);
    `);

    const root = listProjects(db).find((project) => project.path === "/repo/decant");
    const worktree = listProjects(db).find((project) => project.is_worktree);
    expect(root).toMatchObject({
      sessions: 1,
      estimated_cost_usd: 1.5,
      worktree_count: 1,
      session_tools: ["claude_code", "codex"],
    });
    expect(worktree).toMatchObject({
      is_worktree: true,
      root_path: "/repo/decant",
      worktree_label: "feature-auth",
      worktree_tool: "claude",
      root_source: "intree",
    });
    db.close();
  });

  test("query functions propagate database errors", () => {
    const bare = new Database(":memory:");
    expect(() => search(bare, "x", 10)).toThrow();
    expect(() => getSession(bare, 1)).toThrow();
    expect(() => listProjects(bare)).toThrow();
    bare.close();
  });

  test("getSession propagates message query errors after summary lookup succeeds", () => {
    const db = seeded();
    const id = listSessions(db)[0]?.id ?? 0;
    db.exec("PRAGMA foreign_keys = OFF; DROP TABLE message;");
    expect(() => getSession(db, id)).toThrow();
    db.close();
  });
});
