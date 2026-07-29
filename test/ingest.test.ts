import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import {
  discover,
  discoverSourcePaths,
  type IngestConfig,
  resolveSubagentParents,
  sync,
  upsertSession,
} from "../src/ingest.ts";
import { getSession, listSessions } from "../src/query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { ROW_QUERIES } from "./golden-rows.ts";

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
  for (const name of ["distill.jsonl", "enriched.jsonl", "mcp.jsonl", "sample.jsonl"]) {
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

describe("upsertSession", () => {
  test("classifies namespaced Codex MCP tool calls", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    try {
      const content = [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-mcp", cwd: "/tmp/proj" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "mcp_tool_call",
            namespace: "mcp__dosu",
            name: "read_knowledge",
            call_id: "call-1",
            arguments: "{}",
          },
        }),
      ].join("\n");
      const parsed = parseCodexSession("fallback", content, new Map());
      const sessionId = upsertSession(db, parsed, "/x/codex-mcp.jsonl", 1, 2, "hash");

      expect(
        db
          .query(
            `SELECT tool_kind, tool_name, mcp_server, tool_base_name
             FROM tool_call WHERE session_id = ?1`,
          )
          .get(sessionId),
      ).toEqual({
        tool_kind: "mcp",
        tool_name: "mcp__dosu__read_knowledge",
        mcp_server: "dosu",
        tool_base_name: "read_knowledge",
      });
    } finally {
      db.close();
    }
  });

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

    expect(
      db
        .query(
          `SELECT tool_use_id, input_bytes, has_result, duration_ms
           FROM tool_call
           WHERE session_id = ?1 AND tool_use_id IN ('toolu_read', 'toolu_agent')
           ORDER BY tool_use_id`,
        )
        .all(sessionId),
    ).toEqual([
      {
        tool_use_id: "toolu_agent",
        input_bytes: 35,
        has_result: 0,
        duration_ms: null,
      },
      {
        tool_use_id: "toolu_read",
        input_bytes: 43,
        has_result: 1,
        duration_ms: 30_000,
      },
    ]);
    db.close();
  });

  test("replaces an existing natural session without duplicating children", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("sample", fixture("claude", "sample.jsonl"));

    const firstId = upsertSession(db, parsed, "/x/sample.jsonl", 1, 2, "a");
    const replacedId = upsertSession(db, parsed, "/x/sample-again.jsonl", 3, 4, "b");

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
    expect(replacedId).toBe(firstId);
    db.close();
  });

  test("preserves the numeric session id when replacing an existing natural session", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const parsed = parseClaudeSession("sample", fixture("claude", "sample.jsonl"));
    const sibling = parseClaudeSession("sibling", fixture("claude", "sample.jsonl"));

    const firstId = upsertSession(db, parsed, "/x/sample.jsonl", 1, 2, "a");
    // A second session has to exist for this to prove anything. With only one
    // row, SQLite's default `max(rowid) + 1` allocation hands back the same id
    // after the delete whether or not it was preserved, so the assertion below
    // would pass even with the preservation removed.
    upsertSession(db, sibling, "/x/sibling.jsonl", 1, 2, "c");
    const replacedId = upsertSession(db, parsed, "/x/sample-again.jsonl", 3, 4, "b");

    expect(firstId).toBe(1);
    expect(replacedId).toBe(firstId);
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

  test("persists provider effort and one-hour cache creation totals", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    const content =
      '{"type":"assistant","effort":"max","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":40,"ephemeral_1h_input_tokens":60}},"content":[{"type":"text","text":"done"}]}}\n';
    const parsed = parseClaudeSession("effort-cache", content);
    const sessionId = upsertSession(db, parsed, "/x/effort-cache.jsonl", 1, 2, "hash");

    expect(
      db
        .query(
          `SELECT reasoning_effort, reasoning_effort_levels, reasoning_effort_checked,
                  total_cache_creation_tokens, total_cache_creation_1h_tokens
           FROM session WHERE id = ?1`,
        )
        .get(sessionId),
    ).toEqual({
      reasoning_effort: "max",
      reasoning_effort_levels: '["max"]',
      reasoning_effort_checked: 1,
      total_cache_creation_tokens: 100,
      total_cache_creation_1h_tokens: 60,
    });
    expect(getSession(db, sessionId)?.summary).toMatchObject({
      reasoning_effort: "max",
      reasoning_effort_levels: ["max"],
    });
    db.close();
  });

  test("stores head-tail preview for long tool output", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);

    // Create a synthetic session with a tool call that has >500 char output
    const headText = "Starting output";
    const middleText = "x".repeat(2000);
    const tailText = "Error: something failed";
    const longOutput = headText + middleText + tailText;

    const content = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "preview-test",
        timestamp: "2026-07-01T10:00:00.000Z",
        cwd: "/tmp",
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "user",
          content: "Test",
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "preview-test",
        timestamp: "2026-07-01T10:00:05.000Z",
        cwd: "/tmp",
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "test" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: "preview-test",
        timestamp: "2026-07-01T10:00:06.000Z",
        cwd: "/tmp",
        gitBranch: "main",
        version: "2.1.0",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: false,
              content: longOutput,
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeSession("preview-test", content);
    const sessionId = upsertSession(db, parsed, "/x/preview-test.jsonl", 1, 2, "hash");

    const toolCall = db
      .query("SELECT output_preview FROM tool_call WHERE session_id = ?1")
      .get(sessionId) as { output_preview: string };

    expect(toolCall.output_preview.startsWith("Starting output")).toBe(true);
    expect(toolCall.output_preview.endsWith("Error: something failed")).toBe(true);
    expect(toolCall.output_preview).toContain("chars omitted");
    expect(toolCall.output_preview.includes("\n[… ")).toBe(true);

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

  test("discover skips workflow journal files", () => {
    const dir = freshCase();
    const claudeDir = join(dir, "claude");
    const wfDir = join(
      claudeDir,
      "proj-a",
      "1111aaaa-1111-aaaa-1111-aaaa1111aaaa",
      "subagents",
      "workflows",
      "wf_test1",
    );
    const journalLine = '{"type":"agent_result","key":"a1","agentId":"agent-abc123"}\n';
    write(join(claudeDir, "proj-a", "1111aaaa-1111-aaaa-1111-aaaa1111aaaa.jsonl"), "");
    write(join(wfDir, "agent-abc123.jsonl"), "");
    write(join(wfDir, "journal.jsonl"), journalLine);
    const files = discover({ claudeDir, codexDir: join(dir, "codex") });
    const names = files.map((file) => basename(file.path)).sort();
    expect(names).toEqual(["1111aaaa-1111-aaaa-1111-aaaa1111aaaa.jsonl", "agent-abc123.jsonl"]);
  });

  test("discoverSourcePaths skips workflow journal files", () => {
    const dir = freshCase();
    const journal = join(dir, "journal.jsonl");
    const journalLine = '{"type":"agent_result","key":"a1","agentId":"agent-abc123"}\n';
    write(journal, journalLine);
    expect(discoverSourcePaths([journal])).toEqual([]);
    expect(discoverSourcePaths([dir])).toEqual([]);
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
    expect(
      (
        db
          .query(
            `SELECT cache_write_per_mtok, cache_write_1h_per_mtok
             FROM model_pricing WHERE model = 'gpt-5.6-sol'`,
          )
          .get() as { cache_write_per_mtok: number; cache_write_1h_per_mtok: number }
      ).cache_write_1h_per_mtok,
    ).toBe(6.25);

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

  test("reports sync progress from discovery through each inspected source", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    write(join(config.claudeDir, "proj", "sess.jsonl"), fixture("claude", "sample.jsonl"));
    const db = openFreshDb(dir);
    const progress: Array<{
      scanned: number;
      ingested: number;
      skipped: number;
      failed: number;
      total: number;
    }> = [];

    sync(db, config, undefined, (snapshot) => progress.push(snapshot));

    expect(progress).toEqual([
      { scanned: 0, ingested: 0, skipped: 0, failed: 0, total: 1 },
      { scanned: 1, ingested: 1, skipped: 0, failed: 0, total: 1 },
    ]);
    db.close();
  });

  test("closes a sync connection cleanly after explicit statement cleanup", () => {
    const dir = freshCase();
    const db = openFreshDb(dir);
    sync(db, stageFixtures(dir));

    expect(() => closeDb(db)).not.toThrow();
  });

  test("tallies issues by code and stores the code on every issue row", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    const sourcePath = join(config.claudeDir, "proj", "mixed.jsonl");
    write(
      sourcePath,
      [
        fixture("claude", "sample.jsonl").trimEnd(),
        '{"type":"mystery","uuid":"m1","timestamp":"2026-05-01T10:01:00.000Z"}',
        '{"type":"mystery","uuid":"m2","timestamp":"2026-05-01T10:02:00.000Z"}',
        "{not json",
      ].join("\n"),
    );
    const db = openFreshDb(dir);

    const report = sync(db, config);
    expect(report).toMatchObject({ scanned: 1, ingested: 1, issues: 2, failed: 0 });
    // Two mystery lines collapse into one unknown_record_type issue.
    expect(report.issuesByCode).toEqual({ unparsed_line: 1, unknown_record_type: 1 });
    expect(
      db
        .query("SELECT code, COUNT(*) AS n FROM ingest_issue GROUP BY code ORDER BY code")
        .all() as { code: string; n: number }[],
    ).toEqual([
      { code: "unknown_record_type", n: 1 },
      { code: "unparsed_line", n: 1 },
    ]);

    // A clean source reports no codes at all.
    write(sourcePath, fixture("claude", "sample.jsonl"));
    const clean = sync(db, config);
    expect(clean).toMatchObject({ ingested: 1, issues: 0 });
    expect(clean.issuesByCode).toEqual({});
    db.close();
  });

  test("backfills effort for an unchanged source once after the schema upgrade", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    const sourcePath = join(
      config.codexDir,
      "sessions",
      "2026",
      "07",
      "24",
      "rollout-effort.jsonl",
    );
    write(
      sourcePath,
      [
        '{"type":"session_meta","payload":{"id":"effort-session","cwd":"/repo"}}',
        '{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh"}}',
      ].join("\n"),
    );
    const db = openFreshDb(dir);
    expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 0 });
    db.exec(
      "UPDATE session SET reasoning_effort = NULL, reasoning_effort_checked = 0 WHERE source_session_id = 'effort-session'",
    );

    expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 1 });
    expect(
      db
        .query(
          `SELECT reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
           FROM session WHERE source_session_id = 'effort-session'`,
        )
        .get(),
    ).toEqual({
      reasoning_effort: "xhigh",
      reasoning_effort_levels: '["xhigh"]',
      reasoning_effort_checked: 1,
    });
    db.close();
  });

  test("backfills numeric Claude Agent SDK effort budgets", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    const sourcePath = join(config.claudeDir, "project", "numeric-effort.jsonl");
    write(
      sourcePath,
      '{"type":"assistant","effort":16384,"message":{"role":"assistant","content":[]}}\n',
    );
    const db = openFreshDb(dir);
    expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 0 });
    db.exec(
      "UPDATE session SET reasoning_effort = NULL, reasoning_effort_levels = '[]', reasoning_effort_checked = 0",
    );

    expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 1 });
    expect(
      db
        .query(
          `SELECT reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
           FROM session`,
        )
        .get(),
    ).toEqual({
      reasoning_effort: "16384",
      reasoning_effort_levels: '["16384"]',
      reasoning_effort_checked: 1,
    });
    db.close();
  });

  test("backfills effort across bounded UTF-8 source chunks", () => {
    const dir = freshCase();
    const config: IngestConfig = {
      claudeDir: join(dir, "claude"),
      codexDir: join(dir, "codex"),
    };
    const sourcePath = join(
      config.codexDir,
      "sessions",
      "2026",
      "07",
      "24",
      "rollout-large-effort.jsonl",
    );
    const padding = "😀".repeat(20_000);
    write(
      sourcePath,
      [
        `{"type":"session_meta","payload":{"id":"large-effort-session","cwd":"/repo","padding":"${padding}"}}`,
        '{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"max"}}',
      ].join("\n"),
    );
    const db = openFreshDb(dir);
    expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 0 });
    db.exec(
      "UPDATE session SET reasoning_effort = NULL, reasoning_effort_checked = 0 WHERE source_session_id = 'large-effort-session'",
    );

    expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 1 });
    expect(
      db
        .query(
          `SELECT reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
           FROM session WHERE source_session_id = 'large-effort-session'`,
        )
        .get(),
    ).toEqual({
      reasoning_effort: "max",
      reasoning_effort_levels: '["max"]',
      reasoning_effort_checked: 1,
    });
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
    expect(report).toMatchObject({ scanned: 8, ingested: 8, skipped: 0, issues: 0, failed: 0 });

    for (const [name, sql] of Object.entries(ROW_QUERIES)) {
      expect(canonicalizeRows(rows(db, sql), dir), name).toEqual(await golden(`rows/${name}.json`));
    }

    db.exec(`
      INSERT INTO recommendation
        (key, kind, title, impact_label_checked, score, status, first_seen_at, updated_at)
      VALUES
        ('signal:historical', 'signal', 'Historical signal', 0, 1, 'implemented',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
    db.exec(
      "UPDATE recommendation SET impact_label = NULL, impact_label_checked = 0 WHERE kind = 'signal'",
    );
    db.exec(`
      UPDATE recommendation
      SET status = 'implemented', status_source = 'manual'
      WHERE key = (SELECT key FROM recommendation WHERE kind = 'signal' AND key != 'signal:historical' LIMIT 1)
    `);
    const noOpReport = sync(db, config);
    expect(noOpReport).toMatchObject({ scanned: 8, ingested: 0, skipped: 8, failed: 0 });
    expect(
      db
        .query(
          `SELECT COUNT(*) AS missing
             FROM recommendation
            WHERE kind = 'signal' AND key != 'signal:historical' AND impact_label IS NULL`,
        )
        .get(),
    ).toEqual({ missing: 0 });
    expect(
      db
        .query(
          "SELECT impact_label, impact_label_checked FROM recommendation WHERE key = 'signal:historical'",
        )
        .get(),
    ).toEqual({ impact_label: null, impact_label_checked: 1 });
    db.exec("UPDATE recommendation SET score = 12345 WHERE key = 'catalog:agents-md'");
    const secondNoOpReport = sync(db, config);
    expect(secondNoOpReport).toMatchObject({ scanned: 8, ingested: 0, skipped: 8, failed: 0 });
    expect(
      db.query("SELECT score FROM recommendation WHERE key = 'catalog:agents-md'").get(),
    ).toEqual({ score: 12345 });
    db.close();
  });
});
