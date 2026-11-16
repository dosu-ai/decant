import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import { ascIssuerId, ascKeyId } from "../scripts/release/validate.ts";
import { openDb } from "../src/db.ts";
import { METADATA_PATHS } from "../src/message-storage.ts";
import { AGENT_CONTEXT_SQL, isAgentContextText } from "../src/query.ts";
import { signals, USAGE_SIGNAL_SCORE } from "../src/recommendations.ts";
import { PREVIEW_ELISION, previewHeadTail } from "../src/tools.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-code-constraints-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function archiveWithProject(): Database {
  dbCounter += 1;
  const db = openDb(join(workDir, `constraints-${dbCounter}.db`));
  db.exec(`
    INSERT INTO project(id, path) VALUES (1, '/p');
    INSERT INTO session(
      id, tool, source_session_id, project_id, model, estimated_cost_usd, started_at
    )
      VALUES (1, 'claude_code', 's1', 1, 'claude-opus-4-7', 10.0, datetime('now'));
  `);
  return db;
}

function seedToolCalls(
  db: Database,
  name: string,
  kind: string,
  server: string | null,
  calls: number,
  errors: number,
): void {
  const insert = db.prepare(
    `INSERT INTO tool_call(session_id, tool_kind, tool_name, mcp_server, is_error, timestamp)
     VALUES (1, ?1, ?2, ?3, ?4, datetime('now'))`,
  );
  for (let index = 0; index < calls; index += 1) {
    insert.run(kind, name, server, index < errors ? 1 : 0);
  }
}

function seedSessions(
  db: Database,
  firstId: number,
  count: number,
  fields: (index: number) => { outcome?: string; sourcePath?: string } = () => ({}),
): void {
  const insert = db.prepare(
    `INSERT INTO session(id, tool, source_session_id, project_id, started_at, outcome, source_path)
     VALUES (?1, 'claude_code', 'seeded' || ?1, 1, datetime('now'), ?2, ?3)`,
  );
  for (let index = 0; index < count; index += 1) {
    const { outcome, sourcePath } = fields(index);
    insert.run(firstId + index, outcome ?? null, sourcePath ?? null);
  }
}

function seedFileSessions(db: Database, count: number, relPath: string, operation: string): void {
  seedSessions(db, 100, count);
  const insert = db.prepare(
    `INSERT INTO file_ref(session_id, path, rel_path, ext, operation)
     VALUES (?1, '/p/' || ?2, ?2, 'md', ?3)`,
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(100 + index, relPath, operation);
  }
}

const ERROR_RATE_FLOOR_CALLS = 41;
const ERROR_COUNT_FLOOR = 5;
const REMOTE_CONNECTOR = "claude_ai_Supabase";

const issueSignalsAtTheirFloor: {
  name: string;
  keyPrefix: string;
  seed: (db: Database) => void;
}[] = [
  {
    name: "a local tool failing at the lowest error count and rate",
    keyPrefix: "signal:error:",
    seed: (db) =>
      seedToolCalls(db, "Bash", "builtin", null, ERROR_RATE_FLOOR_CALLS, ERROR_COUNT_FLOOR),
  },
  {
    name: "a remote connector tool failing at the lowest error count and rate",
    keyPrefix: "signal:error:",
    seed: (db) =>
      seedToolCalls(
        db,
        `mcp__${REMOTE_CONNECTOR}__execute_sql`,
        "mcp",
        REMOTE_CONNECTOR,
        ERROR_RATE_FLOOR_CALLS,
        ERROR_COUNT_FLOOR,
      ),
  },
  {
    name: "the folded row for failing remote connector tools past the first three",
    keyPrefix: "signal:error-tail",
    seed: (db) => {
      for (let tool = 0; tool < 5; tool += 1) {
        seedToolCalls(
          db,
          `mcp__${REMOTE_CONNECTOR}__tool_${tool}`,
          "mcp",
          REMOTE_CONNECTOR,
          ERROR_RATE_FLOOR_CALLS,
          ERROR_COUNT_FLOOR,
        );
      }
    },
  },
  {
    name: "spend concentrated on one model",
    keyPrefix: "signal:cost-concentration",
    seed: () => {},
  },
  {
    name: "a file re-read in the fewest sessions that counts as hot context",
    keyPrefix: "signal:hot-context:",
    seed: (db) => seedFileSessions(db, 8, "AGENTS.md", "read"),
  },
  {
    name: "a file edited in the fewest sessions that counts as churn",
    keyPrefix: "signal:churn:",
    seed: (db) => seedFileSessions(db, 6, "src/parser.rs", "edit"),
  },
  {
    name: "a project at the lowest searches-per-session ratio",
    keyPrefix: "signal:search-heavy",
    seed: (db) => {
      seedSessions(db, 100, 19);
      for (let index = 0; index < 100; index += 1) {
        seedToolCalls(db, "Grep", "builtin", null, 1, 0);
      }
    },
  },
  {
    name: "an abandoned-session share just above the threshold",
    keyPrefix: "signal:abandoned-rate",
    seed: (db) =>
      seedSessions(db, 100, 100, (index) => ({
        outcome: index < 26 ? "abandoned" : "completed",
      })),
  },
  {
    name: "the smallest share of sessions with ingest diagnostics",
    keyPrefix: "signal:ingest-health",
    seed: (db) => {
      seedSessions(db, 100, 19, (index) => ({ sourcePath: `/src/s${index}.jsonl` }));
      const insert = db.prepare(
        `INSERT INTO ingest_issue (source_path, line_no, error, raw_line, code, created_at)
           VALUES (?1, NULL, 'unknown record type', NULL, 'unknown_record_type', datetime('now'))`,
      );
      insert.run("/src/s0.jsonl");
      insert.run("/src/s1.jsonl");
    },
  },
];

const SQL_PATTERN = /\b(LIKE|GLOB)\s+'((?:[^']|'')*)'/g;

function sampleMatching(operator: string, pattern: string): string {
  if (operator === "LIKE") {
    return pattern.replace(
      /\\(.)|%|_/g,
      (wildcard, escaped: string | undefined) =>
        escaped ?? (wildcard === "%" ? " sample text" : "x"),
    );
  }
  return pattern.replace(/[*?]/g, (wildcard) => (wildcard === "*" ? " sample text " : "x"));
}

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("rules the code depends on", () => {
  test("usage notes rank below every signal that flags a problem, even at that signal's smallest score", () => {
    const usage = archiveWithProject();
    seedToolCalls(usage, "Read", "builtin", null, 200, 0);
    seedToolCalls(usage, "mcp__svc__a", "mcp", "svc", 50, 0);
    const usageRows = signals(usage).filter((row) => row.key.startsWith("signal:heavy-"));
    usage.close();
    expect(usageRows.map((row) => row.score)).toEqual([USAGE_SIGNAL_SCORE, USAGE_SIGNAL_SCORE]);

    const notAboveUsage = issueSignalsAtTheirFloor.flatMap(({ name, keyPrefix, seed }) => {
      const db = archiveWithProject();
      seed(db);
      const score = signals(db).find((row) => row.key.startsWith(keyPrefix))?.score;
      db.close();
      return score != null && score > USAGE_SIGNAL_SCORE ? [] : [{ name, score }];
    });
    expect(notAboveUsage).toEqual([]);
  });

  test("the UI loads only its hand-picked Shiki grammars, never a full Shiki bundle or precompiled grammars", () => {
    const uiDir = join(import.meta.dir, "../src/ui");
    const files = readdirSync(uiDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.tsx?$/.test(file),
    );
    const imports = files.flatMap((file) =>
      moduleSpecifiers(readFileSync(join(uiDir, file), "utf8")).map((specifier) => ({
        file,
        specifier,
      })),
    );
    expect(imports).toContainEqual({ file: "shiki-highlighter.ts", specifier: "shiki/core" });

    const forbidden = imports.filter(
      ({ specifier }) =>
        specifier === "shiki" ||
        specifier === "shiki/bundle/web" ||
        specifier.includes("langs-precompiled"),
    );
    expect(forbidden).toEqual([]);
  });

  test("every text the SQL title scan skips as agent context is also agent context to isAgentContextText", () => {
    const patterns = [...AGENT_CONTEXT_SQL.matchAll(SQL_PATTERN)].map(([, operator, pattern]) => ({
      operator: operator ?? "",
      pattern: (pattern ?? "").replaceAll("''", "'"),
    }));
    expect(patterns).toHaveLength(AGENT_CONTEXT_SQL.match(/\b(?:LIKE|GLOB)\b/g)?.length ?? -1);
    expect(patterns.length).toBeGreaterThan(0);

    const sqlite = new Database(":memory:");
    const skippedBySql = sqlite.prepare<{ hit: number }, [string]>(
      `SELECT (${AGENT_CONTEXT_SQL}) AS hit FROM (SELECT ?1 AS text) AS b`,
    );
    const unmatchedSamples: string[] = [];
    const missedByJs: string[] = [];
    for (const { operator, pattern } of patterns) {
      const sample = sampleMatching(operator, pattern);
      if (skippedBySql.get(sample)?.hit !== 1) {
        unmatchedSamples.push(sample);
      }
      for (const text of [sample, `   ${sample}`, sample.toUpperCase(), sample.toLowerCase()]) {
        if (skippedBySql.get(text)?.hit === 1 && !isAgentContextText(text)) {
          missedByJs.push(text);
        }
      }
    }
    sqlite.close();
    expect(unmatchedSamples).toEqual([]);
    expect(missedByJs).toEqual([]);
  });

  test("PREVIEW_ELISION matches the marker previewHeadTail writes and nothing in an unshortened preview", () => {
    const shortened = previewHeadTail("x".repeat(1200), 500);
    expect(shortened).toMatch(PREVIEW_ELISION);
    expect(PREVIEW_ELISION.exec(shortened)?.[1]).toBe("700");

    const unshortened = previewHeadTail("short tool output", 500);
    expect(unshortened).toBe("short tool output");
    expect(unshortened).not.toMatch(PREVIEW_ELISION);
  });

  test("a release validation error names the secret's variable but never prints its value", () => {
    const sentinel = "LEAKED-SECRET-5d1e";
    const checks = [
      { name: "ASC_ISSUER_ID", validate: ascIssuerId, value: sentinel },
      {
        name: "ASC_ISSUER_ID",
        validate: ascIssuerId,
        value: `00000000-0000-0000-0000-00000000000${sentinel}`,
      },
      { name: "ASC_KEY_ID", validate: ascKeyId, value: sentinel },
      { name: "ASC_KEY_ID", validate: ascKeyId, value: `ABCDE${sentinel}` },
    ];
    for (const { name, validate, value } of checks) {
      let message = "";
      try {
        validate(name, value);
      } catch (error) {
        expect(error).toBeInstanceOf(ReleaseFailure);
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(sentinel);
    }
  });

  test("adding a message metadata path needs a backfill for existing archives", () => {
    expect(METADATA_PATHS).toEqual([
      ["isSidechain"],
      ["subtype"],
      ["type"],
      ["isCompactSummary"],
      ["compactMetadata", "trigger"],
      ["compactMetadata", "preTokens"],
      ["data", "preCompactionTokens"],
      ["payload", "role"],
      ["message", "id"],
      ["message", "usage"],
      ["cost"],
      ["metrics", "cost_usd"],
      ["model", "providerID"],
      ["providerID"],
      ["reasoning_tokens"],
      ["callID"],
      ["id"],
      ["name"],
      ["tool"],
      ["state", "metadata", "sessionID"],
      ["state", "metadata", "sessionId"],
      ["sessionId"],
      ["agentId"],
      ["extra", "context_management", "type"],
    ]);
  });
});
