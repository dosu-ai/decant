import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  discover,
  type IngestConfig,
  resolveSubagentParents,
  sync,
  upsertSession,
} from "../src/ingest.ts";
import { getSession, listSessions } from "../src/query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const repoRoot = join(import.meta.dir, "..");
const fixtureRoot = join(repoRoot, "fixtures");
const goldenDir = join(import.meta.dir, "golden");
const workDir = mkdtempSync(join(tmpdir(), "decant-ingest-test-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshCase(): string {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function openFreshDb(dir: string): Database {
  return openDb(join(dir, "archive.db"));
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(fixtureRoot, tool, name), "utf8");
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function stageFixtures(dir: string): IngestConfig {
  const claudeDir = join(dir, "sources", "claude");
  const codexDir = join(dir, "sources", "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });

  for (const name of ["distill.jsonl", "enriched.jsonl", "mcp.jsonl", "sample.jsonl"]) {
    copyFileSync(join(fixtureRoot, "claude", name), join(claudeDir, name));
  }
  for (const name of ["distill.jsonl", "enriched.jsonl", "sample.jsonl"]) {
    copyFileSync(join(fixtureRoot, "codex", name), join(codexDir, "sessions", `rollout-${name}`));
  }

  return { claudeDir, codexDir };
}

async function golden<T>(relPath: string): Promise<T> {
  return (await Bun.file(join(goldenDir, relPath)).json()) as T;
}

function rows(db: Database, sql: string): unknown[] {
  return db.query(sql).all();
}

function canonicalizeRows(value: unknown, dir: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(dir, "<TMP>")) as unknown;
}

const ROW_QUERIES = {
  sessions: `
    SELECT s.tool, s.source_session_id, p.path AS project_path, p.name AS project_name,
           s.title, s.cwd, s.git_branch, s.model, s.cli_version, s.started_at, s.ended_at,
           s.message_count, s.total_input_tokens, s.total_output_tokens,
           s.total_cache_read_tokens, s.total_cache_creation_tokens,
           s.total_reasoning_tokens, s.est_reasoning_tokens, s.reasoning_source,
           s.estimated_cost_usd, s.is_archived, s.source_path,
           s.turn_count, s.error_count, s.interruption_count, s.compaction_count,
           s.sidechain_message_count, s.agent_spawn_count, s.skill_count, s.command_count,
           s.thinking_block_count, s.thinking_chars, s.active_seconds, s.outcome, s.work_type
    FROM session s LEFT JOIN project p ON p.id = s.project_id
    ORDER BY s.tool, s.source_session_id`,
  messages: `
    SELECT s.tool, s.source_session_id, m.seq, m.source_uuid, m.parent_source_uuid,
           m.role, m.model, m.stop_reason, m.timestamp, m.input_tokens, m.output_tokens,
           m.cache_read_tokens, m.cache_creation_tokens, m.raw
    FROM message m JOIN session s ON s.id = m.session_id
    ORDER BY s.tool, s.source_session_id, m.seq`,
  blocks: `
    SELECT s.tool, s.source_session_id, m.seq, b.ordinal, b.type, b.text,
           b.tool_name, b.tool_use_id, b.tool_input, b.tool_result
    FROM block b JOIN message m ON m.id = b.message_id JOIN session s ON s.id = b.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, b.ordinal`,
  tool_calls: `
    SELECT s.tool, s.source_session_id, m.seq, tc.ordinal, tc.tool_kind, tc.tool_name,
           tc.mcp_server, tc.tool_base_name, tc.tool_use_id, tc.input, tc.is_error,
           tc.output_preview, tc.output_bytes, tc.duration_ms, tc.timestamp
    FROM tool_call tc
    LEFT JOIN message m ON m.id = tc.message_id
    JOIN session s ON s.id = tc.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, tc.ordinal, tc.tool_use_id`,
  file_refs: `
    SELECT s.tool, s.source_session_id, m.seq, f.path, f.rel_path, f.ext,
           f.operation, f.timestamp
    FROM file_ref f
    LEFT JOIN message m ON m.id = f.message_id
    JOIN session s ON s.id = f.session_id
    ORDER BY s.tool, s.source_session_id, m.seq, f.path, f.operation`,
  recommendations: `
    SELECT key, kind, category, title, detail, suggestion, prompt, url,
           link_label, icon, tone, score, status, status_source, note
    FROM recommendation
    ORDER BY key`,
} as const;

describe("upsertSession", () => {
  test("writes sessions, messages, blocks, tool calls, file refs, facets, and FTS rows", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("enriched", fixture("claude", "enriched.jsonl"));
    const sessionId = upsertSession(db, parsed, "/x/enriched.jsonl", 1, 2, "hash");

    const counts = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM session) AS sessions,
           (SELECT COUNT(*) FROM message) AS messages,
           (SELECT COUNT(*) FROM block) AS blocks,
           (SELECT COUNT(*) FROM tool_call) AS calls,
           (SELECT COUNT(*) FROM file_ref) AS refs,
           (SELECT COUNT(*) FROM session_economics) AS economics`,
      )
      .get() as {
      sessions: number;
      messages: number;
      blocks: number;
      calls: number;
      refs: number;
      economics: number;
    };
    expect(counts).toEqual({
      sessions: 1,
      messages: 10,
      blocks: 15,
      calls: 6,
      refs: 4,
      economics: 1,
    });

    const ref = db
      .query(
        `SELECT f.rel_path, f.ext, f.operation, f.message_id IS NOT NULL AS linked
         FROM file_ref f WHERE f.session_id = ?1 AND f.operation = 'read'`,
      )
      .get(sessionId) as { rel_path: string; ext: string; operation: string; linked: number };
    expect(ref).toEqual({ rel_path: "src/main.rs", ext: "rs", operation: "read", linked: 1 });

    const session = db
      .query(
        `SELECT turn_count, error_count, interruption_count, compaction_count,
                sidechain_message_count, active_seconds, outcome, work_type
         FROM session WHERE id = ?1`,
      )
      .get(sessionId) as {
      turn_count: number;
      error_count: number;
      interruption_count: number;
      compaction_count: number;
      sidechain_message_count: number;
      active_seconds: number;
      outcome: string;
      work_type: string;
    };
    expect(session).toMatchObject({
      turn_count: 1,
      error_count: 1,
      interruption_count: 1,
      compaction_count: 1,
      sidechain_message_count: 2,
      active_seconds: 490,
      outcome: "abandoned",
      work_type: "refactor",
    });

    const fts = db
      .query("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'auth'")
      .get() as { n: number };
    expect(fts.n).toBeGreaterThan(0);
    db.close();
  });

  test("replaces an existing natural session without duplicating children", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("sample", fixture("claude", "sample.jsonl"));

    upsertSession(db, parsed, "/x/sample.jsonl", 1, 2, "a");
    upsertSession(db, parsed, "/x/sample-again.jsonl", 3, 4, "b");

    const counts = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM session) AS sessions,
           (SELECT COUNT(*) FROM message) AS messages,
           (SELECT COUNT(*) FROM block) AS blocks,
           (SELECT COUNT(*) FROM session_economics) AS economics,
           (SELECT source_path FROM session) AS source_path`,
      )
      .get() as {
      sessions: number;
      messages: number;
      blocks: number;
      economics: number;
      source_path: string;
    };
    expect(counts).toMatchObject({
      sessions: 1,
      messages: 4,
      blocks: 6,
      economics: 1,
      source_path: "/x/sample-again.jsonl",
    });
    db.close();
  });

  test("writes a session without creating a project when no project path is present", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("sample", fixture("claude", "sample.jsonl"));
    parsed.session.projectPath = null;
    parsed.session.cwd = null;

    const sessionId = upsertSession(db, parsed, "/x/sample.jsonl", 1, 2, "a");
    const row = db.query("SELECT project_id, cwd FROM session WHERE id = ?1").get(sessionId) as {
      project_id: number | null;
      cwd: string | null;
    };

    expect(row).toEqual({ project_id: null, cwd: null });
    expect((db.query("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("rolls back a failed replacement without losing the prior session", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("sample", fixture("claude", "sample.jsonl"));

    upsertSession(db, parsed, "/x/sample.jsonl", 1, 2, "a");
    db.exec(`
      CREATE TRIGGER fail_block_insert
      BEFORE INSERT ON block
      BEGIN
        SELECT RAISE(ABORT, 'block insert blocked');
      END;
    `);

    expect(() => upsertSession(db, parsed, "/x/sample-again.jsonl", 3, 4, "b")).toThrow(
      "block insert blocked",
    );

    const counts = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM session) AS sessions,
           (SELECT COUNT(*) FROM message) AS messages,
           (SELECT COUNT(*) FROM block) AS blocks,
           (SELECT COUNT(*) FROM session_economics) AS economics,
           (SELECT source_path FROM session) AS source_path`,
      )
      .get() as {
      sessions: number;
      messages: number;
      blocks: number;
      economics: number;
      source_path: string;
    };
    expect(counts).toEqual({
      sessions: 1,
      messages: 4,
      blocks: 6,
      economics: 1,
      source_path: "/x/sample.jsonl",
    });
    db.close();
  });
});

describe("sync", () => {
  test("discovers Claude files plus Codex rollout files only", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(join(config.claudeDir, "project", "a.jsonl"), "");
    write(join(config.claudeDir, "project", "notes.txt"), "");
    write(join(config.codexDir, "sessions", "rollout-a.jsonl"), "");
    write(join(config.codexDir, "sessions", "a.jsonl"), "");
    write(join(config.codexDir, "archived_sessions", "rollout-b.jsonl"), "");

    expect(
      discover(config).map((file) => ({
        tool: file.tool,
        name: basename(file.path),
        archived: file.archived,
      })),
    ).toEqual([
      { tool: "claude_code", name: "a.jsonl", archived: false },
      { tool: "codex", name: "rollout-a.jsonl", archived: false },
      { tool: "codex", name: "rollout-b.jsonl", archived: true },
    ]);
  });

  test("discovers only explicitly requested source paths when sourcePaths is set", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
      sourcePaths: [join(dir, "selected"), join(dir, "selected", "claude", "one.jsonl")],
    };
    write(join(config.claudeDir, "ignored.jsonl"), "");
    write(join(config.codexDir, "sessions", "rollout-ignored.jsonl"), "");
    write(join(dir, "selected", "claude", "one.jsonl"), "");
    write(join(dir, "selected", "codex", "sessions", "rollout-one.jsonl"), "");
    write(join(dir, "selected", "codex", "archived_sessions", "rollout-old.jsonl"), "");
    write(join(dir, "selected", "codex", "session_index.jsonl"), "");
    write(join(dir, "selected", "notes.txt"), "");

    expect(
      discover(config).map((file) => ({
        tool: file.tool,
        name: basename(file.path),
        archived: file.archived,
      })),
    ).toEqual([
      { tool: "claude_code", name: "one.jsonl", archived: false },
      { tool: "codex", name: "rollout-old.jsonl", archived: true },
      { tool: "codex", name: "rollout-one.jsonl", archived: false },
    ]);
  });

  test("is idempotent, records parse issues, and refreshes issues on reingest", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(
      join(config.claudeDir, "proj", "sess.jsonl"),
      `${fixture("claude", "sample.jsonl")}\n{bad`,
    );
    const db = openFreshDb(dir);

    const first = sync(db, config);
    expect(first).toMatchObject({ scanned: 1, ingested: 1, skipped: 0, issues: 1, failed: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM ingest_issue").get() as { n: number }).n).toBe(1);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM model_pricing").get() as { n: number }).n,
    ).toBeGreaterThan(0);

    // Simulate opening a migrated v9 archive whose transcripts are unchanged.
    db.exec("DELETE FROM session_economics");
    db.query("UPDATE recommendation SET score = 12345 WHERE key = 'catalog:agents-md'").run();
    const second = sync(db, config);
    expect(second).toMatchObject({ scanned: 1, ingested: 0, skipped: 1, issues: 0, failed: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM session_economics").get() as { n: number }).n).toBe(
      1,
    );
    expect(
      (
        db.query("SELECT score FROM recommendation WHERE key = 'catalog:agents-md'").get() as {
          score: number;
        }
      ).score,
    ).toBe(12345);

    write(
      join(config.claudeDir, "proj", "sess.jsonl"),
      `${fixture("claude", "sample.jsonl")}\nanother bad line {`,
    );
    const third = sync(db, config);
    expect(third).toMatchObject({ scanned: 1, ingested: 1, skipped: 0, issues: 1, failed: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM ingest_issue").get() as { n: number }).n).toBe(1);
    expect(
      (
        db.query("SELECT score FROM recommendation WHERE key = 'catalog:agents-md'").get() as {
          score: number;
        }
      ).score,
    ).toBe(0);
    db.close();
  });

  test("can cancel between files without ingesting the remaining sources", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(join(config.claudeDir, "a.jsonl"), fixture("claude", "sample.jsonl"));
    write(join(config.claudeDir, "b.jsonl"), fixture("claude", "enriched.jsonl"));
    const db = openFreshDb(dir);

    let checks = 0;
    const cancel = {
      get aborted(): boolean {
        checks += 1;
        return checks > 1;
      },
    };
    const report = sync(db, config, cancel);

    expect(report).toMatchObject({ scanned: 2, ingested: 1, skipped: 0, cancelled: true });
    expect((db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(1);
    db.close();
  });

  test("replaces duplicate natural session ids from different files and keeps source rows", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(join(config.claudeDir, "first", "sample.jsonl"), fixture("claude", "sample.jsonl"));
    write(join(config.claudeDir, "second", "sample.jsonl"), fixture("claude", "sample.jsonl"));
    const db = openFreshDb(dir);

    const report = sync(db, config);
    expect(report).toMatchObject({ scanned: 2, ingested: 2, skipped: 0, failed: 0 });
    const counts = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM session) AS sessions,
           (SELECT COUNT(*) FROM ingest_source) AS sources,
           (SELECT COUNT(*) FROM ingest_source WHERE session_id IS NULL) AS unlinked_sources`,
      )
      .get() as { sessions: number; sources: number; unlinked_sources: number };
    expect(counts).toEqual({ sessions: 1, sources: 2, unlinked_sources: 1 });
    db.close();
  });

  test("reads Codex session_index titles and resolves project roots", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(join(config.codexDir, "sessions", "rollout-x.jsonl"), fixture("codex", "sample.jsonl"));
    write(
      join(config.codexDir, "session_index.jsonl"),
      '{"id":"sess-codex-1","thread_name":"Indexed Title"}\nnot json\n{"id":"other"}\n',
    );
    const db = openFreshDb(dir);

    expect(sync(db, config).ingested).toBe(1);
    const row = db
      .query(
        `SELECT s.title, p.root_path, p.root_source
         FROM session s JOIN project p ON p.id = s.project_id`,
      )
      .get() as { title: string; root_path: string; root_source: string };
    expect(row).toEqual({
      title: "Indexed Title",
      root_path: "/Users/dev/proj",
      root_source: "self",
    });
    db.close();
  });

  test("links Claude subagent sidechain files under their spawning session", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(
      join(config.claudeDir, "proj", "root.jsonl"),
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "root-session",
          timestamp: "2026-05-01T10:00:00.000Z",
          cwd: "/Users/dev/proj",
          message: { role: "user", content: "check auth" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "root-session",
          timestamp: "2026-05-01T10:00:01.000Z",
          cwd: "/Users/dev/proj",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [
              {
                type: "tool_use",
                id: "toolu_agent",
                name: "Task",
                input: { prompt: "inspect auth" },
              },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    write(
      join(config.claudeDir, "proj", "subagents", "agent-alpha.jsonl"),
      [
        {
          type: "user",
          uuid: "su1",
          parentUuid: null,
          sessionId: "root-session",
          isSidechain: true,
          agentId: "alpha",
          timestamp: "2026-05-01T10:00:02.000Z",
          cwd: "/Users/dev/proj",
          message: { role: "user", content: "inspect auth" },
        },
        {
          type: "assistant",
          uuid: "sa1",
          parentUuid: "su1",
          sessionId: "root-session",
          isSidechain: true,
          agentId: "alpha",
          timestamp: "2026-05-01T10:00:03.000Z",
          cwd: "/Users/dev/proj",
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: "text", text: "auth is fine" }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    write(
      join(config.claudeDir, "proj", "subagents", "agent-alpha.meta.json"),
      JSON.stringify({ toolUseId: "toolu_agent", agentType: "explorer", spawnDepth: 1 }),
    );
    const db = openFreshDb(dir);

    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 2, failed: 0 });
    const rootRows = listSessions(db);
    expect(rootRows.map((row) => row.source_session_id)).toEqual(["root"]);
    expect(rootRows[0]?.subagent_count).toBe(1);
    expect(rootRows[0]?.subagent_estimated_cost_usd).toBeGreaterThan(0);
    expect(listSessions(db, { includeNestedSubagents: true })[0]?.subagents?.[0]?.agent_type).toBe(
      "explorer",
    );
    expect(listSessions(db, { includeSubagents: true, limit: 10 })).toHaveLength(2);
    const child = db
      .query(
        `SELECT c.agent_id, c.agent_type, c.spawn_depth, c.spawn_tool_use_id,
                p.source_session_id AS parent_key
         FROM session c LEFT JOIN session p ON p.id = c.parent_session_id
         WHERE c.is_subagent = 1`,
      )
      .get() as {
      agent_id: string;
      agent_type: string;
      spawn_depth: number;
      spawn_tool_use_id: string;
      parent_key: string;
    };
    expect(child).toEqual({
      agent_id: "alpha",
      agent_type: "explorer",
      spawn_depth: 1,
      spawn_tool_use_id: "toolu_agent",
      parent_key: "root",
    });
    const rootId = (
      db.query("SELECT id FROM session WHERE source_session_id = 'root'").get() as { id: number }
    ).id;
    expect(getSession(db, rootId)?.subagents[0]?.agent_type).toBe("explorer");
    db.close();
  });

  test("links Codex subagent rollout files under their parent session", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(
      join(config.codexDir, "sessions", "2026", "05", "01", "rollout-root.jsonl"),
      [
        {
          type: "session_meta",
          timestamp: "2026-05-01T10:00:00.000Z",
          payload: {
            id: "root-thread",
            cwd: "/Users/dev/proj",
            cli_version: "0.121.0",
            source: "cli",
          },
        },
        {
          type: "turn_context",
          timestamp: "2026-05-01T10:00:00.500Z",
          payload: { model: "gpt-5.5", cwd: "/Users/dev/proj" },
        },
        {
          type: "response_item",
          timestamp: "2026-05-01T10:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Investigate auth failures" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-01T10:00:02.000Z",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call_spawn",
            arguments: JSON.stringify({ agent_type: "explorer", message: "audit auth" }),
          },
        },
        {
          type: "response_item",
          timestamp: "2026-05-01T10:00:03.000Z",
          payload: {
            type: "function_call_output",
            call_id: "call_spawn",
            output: { agent_id: "child-thread", nickname: "Ada" },
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    write(
      join(config.codexDir, "sessions", "2026", "05", "01", "rollout-child.jsonl"),
      [
        {
          type: "session_meta",
          timestamp: "2026-05-01T10:00:04.000Z",
          payload: {
            id: "child-thread",
            cwd: "/Users/dev/proj",
            parent_thread_id: "root-thread",
            agent_nickname: "Ada",
            agent_role: "explorer",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "root-thread",
                  depth: 1,
                  agent_nickname: "Ada",
                  agent_role: "explorer",
                },
              },
            },
          },
        },
        {
          type: "turn_context",
          timestamp: "2026-05-01T10:00:04.500Z",
          payload: { model: "codex-auto-review", cwd: "/Users/dev/proj" },
        },
        {
          type: "response_item",
          timestamp: "2026-05-01T10:00:05.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "audit auth" }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const db = openFreshDb(dir);

    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 2, failed: 0 });
    const rootRows = listSessions(db);
    expect(rootRows.map((row) => row.source_session_id)).toEqual(["root-thread"]);
    expect(rootRows[0]?.subagent_count).toBe(1);
    const nested = listSessions(db, { includeNestedSubagents: true })[0]?.subagents?.[0];
    expect(nested?.source_session_id).toBe("child-thread");
    expect(nested?.agent_id).toBe("Ada");
    expect(nested?.agent_type).toBe("explorer");
    expect(nested?.spawn_tool_use_id).toBe("call_spawn");
    expect(listSessions(db, { includeSubagents: true, limit: 10 })).toHaveLength(2);
    const rootId = (
      db.query("SELECT id FROM session WHERE source_session_id = 'root-thread'").get() as {
        id: number;
      }
    ).id;
    expect(getSession(db, rootId)?.subagents[0]?.spawn_tool_use_id).toBe("call_spawn");
    db.close();
  });

  test("backfills legacy Claude subagent rows from source path and message raw", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    db.exec(`
      INSERT INTO project(path, name) VALUES ('/Users/dev/proj', 'proj');
      INSERT INTO session(tool, source_session_id, project_id, title, started_at, ended_at, message_count, source_path)
      VALUES ('claude_code', 'root', 1, 'root', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:01.000Z', 1, '/Users/dev/.claude/projects/proj/root.jsonl');
      INSERT INTO session(tool, source_session_id, project_id, title, started_at, ended_at, message_count, source_path)
      VALUES ('claude_code', 'agent-alpha', 1, 'alpha', '2026-05-01T10:00:02.000Z', '2026-05-01T10:00:03.000Z', 1, '/Users/dev/.claude/projects/proj/subagents/agent-alpha.jsonl');
      INSERT INTO message(session_id, seq, role, timestamp, raw)
      VALUES (1, 0, 'user', '2026-05-01T10:00:00.000Z', '{"sessionId":"root-session"}');
      INSERT INTO message(session_id, seq, role, timestamp, raw)
      VALUES (2, 0, 'user', '2026-05-01T10:00:02.000Z', '{"sessionId":"root-session","isSidechain":true,"agentId":"alpha"}');
    `);

    resolveSubagentParents(db);

    const child = db
      .query(
        `SELECT c.is_subagent, c.agent_id, p.source_session_id AS parent_key
         FROM session c LEFT JOIN session p ON p.id = c.parent_session_id
         WHERE c.source_session_id = 'agent-alpha'`,
      )
      .get() as { is_subagent: number; agent_id: string; parent_key: string };
    expect(child).toEqual({ is_subagent: 1, agent_id: "alpha", parent_key: "root" });
    db.close();
  });

  test("fixture sync matches frozen natural-key golden rows", async () => {
    const dir = freshCase();
    const config = stageFixtures(dir);
    const db = openFreshDb(dir);

    const report = sync(db, config);
    expect(report).toMatchObject({ scanned: 7, ingested: 7, skipped: 0, issues: 0, failed: 0 });

    for (const [name, sql] of Object.entries(ROW_QUERIES)) {
      expect(canonicalizeRows(rows(db, sql), dir), name).toEqual(await golden(`rows/${name}.json`));
    }
    db.close();
  });
});
