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
  search,
} from "../src/query.ts";
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

    const hits = search(db, "auth", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.tool).toBe("claude_code");
    db.close();
  });

  test("pages session messages and returns a lightweight complete prompt outline", () => {
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
    expect(getSessionOutline(db, id)).toEqual([{ seq: 0, text: "Fix the failing auth test" }]);
    expect(getSessionOutline(db, 999_999)).toBeNull();
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

  test("search with no match returns empty", () => {
    const db = seeded();
    expect(search(db, "zzznotpresentzzz", 10)).toEqual([]);
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
