import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { getSession, type ListFilter, listProjects, listSessions, search } from "../src/query.ts";
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

  test("session summaries extract Cursor native JSON-string user queries", () => {
    const db = freshDb();
    const raw = JSON.stringify({
      content: [
        {
          text: "<timestamp>Monday, Jul 6, 2026</timestamp>\n<user_query>\nPlease format this text for Discord markdown\n</user_query>",
          type: "text",
        },
      ],
    });
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES (1, 'cursor', 'native-json', '${raw.replaceAll("'", "''")}', '2026-07-05T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES (1, 1, 0, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES (1, 1, 0, 'text', '${raw.replaceAll("'", "''")}');
    `);

    expect(listSessions(db)[0]?.title).toBe("Please format this text for Discord markdown");
    db.close();
  });

  test("session summaries label generated context instead of leaking raw tags", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at, is_subagent)
      VALUES
        (1, 'codex', 'permissions', '<permissions instructions>Filesystem sandboxing defines which files can be read or written.</permissions instructions>', '2026-07-05T00:00:00Z', 0),
        (2, 'claude_code', 'command', '<local-command-caveat>Caveat: generated by local command</local-command-caveat>', '2026-07-05T00:00:01Z', 0);
    `);

    expect(listSessions(db, { limit: 10 }).map((session) => session.title)).toEqual([
      "Command context",
      "Execution permissions",
    ]);
    db.close();
  });

  test("getSession returns null for an unknown id", () => {
    const db = seeded();
    expect(getSession(db, 999_999)).toBeNull();
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
