import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { toMarkdown } from "../src/export.ts";
import { upsertSession } from "../src/ingest.ts";
import { getSession } from "../src/query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-export-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

test("toMarkdown renders a full transcript", () => {
  const db = openDb(join(workDir, "transcript.db"));
  const content = readFileSync(
    join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
    "utf8",
  );
  const sessionId = upsertSession(
    db,
    parseClaudeSession("sess-claude-1", content),
    "/x.jsonl",
    1,
    2,
    "h",
  );

  const detail = getSession(db, sessionId);
  expect(detail).not.toBeNull();
  if (detail == null) {
    throw new Error("expected session detail");
  }
  const md = toMarkdown(detail);
  expect(md.startsWith("# Fix the failing auth test")).toBe(true);
  expect(md).toContain("## USER");
  expect(md).toContain("Read");
  expect(md).toContain("_thinking:_");
  db.close();
});

describe("toMarkdown fallback blocks", () => {
  test("renders unknown block types with a placeholder", () => {
    const db = openDb(join(workDir, "unknown.db"));
    db.exec(`
      INSERT INTO project(id, path) VALUES (1, '/p');
      INSERT INTO session(id, tool, source_session_id, project_id, message_count)
        VALUES (1, 'claude_code', 's1', 1, 1);
      INSERT INTO message(id, session_id, seq, role, raw)
        VALUES (1, 1, 0, 'assistant', '{}');
      INSERT INTO block(id, message_id, session_id, ordinal, type, text)
        VALUES (1, 1, 1, 0, 'image', NULL);
    `);

    const detail = getSession(db, 1);
    expect(detail).not.toBeNull();
    if (detail == null) {
      throw new Error("expected session detail");
    }
    expect(toMarkdown(detail)).toContain("_[image]_");
    db.close();
  });
});

describe("toMarkdown thinking blocks", () => {
  test("skips a blank thinking block, which holds reasoning the provider hid", () => {
    const db = openDb(join(workDir, "blank-thinking.db"));
    db.exec(`
      INSERT INTO project(id, path) VALUES (1, '/p');
      INSERT INTO session(id, tool, source_session_id, project_id, message_count)
        VALUES (1, 'opencode', 's1', 1, 1);
      INSERT INTO message(id, session_id, seq, role, raw)
        VALUES (1, 1, 0, 'assistant', '{}');
      INSERT INTO block(id, message_id, session_id, ordinal, type, text)
        VALUES (1, 1, 1, 0, 'thinking', ''), (2, 1, 1, 1, 'thinking', 'Plan it.'),
               (3, 1, 1, 2, 'text', 'Done.');
    `);
    const detail = getSession(db, 1);
    if (detail == null) {
      throw new Error("expected session detail");
    }
    const md = toMarkdown(detail);
    expect(md.match(/_thinking:_/g)).toHaveLength(1);
    expect(md).toContain("> _thinking:_ Plan it.");
    db.close();
  });
});
