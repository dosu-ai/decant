import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atifMirrorPath, mirrorAtif } from "../src/atif-mirror.ts";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import type { AtifTrajectory } from "../src/export-atif.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-atif-mirror-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function fresh(): { db: Database; dbPath: string; out: string } {
  counter += 1;
  const dbPath = join(workDir, `mirror-${counter}.db`);
  return { db: openDb(dbPath), dbPath, out: join(workDir, `out-${counter}`, "atif") };
}

const BASE = { cwd: "/synthetic/widget", gitBranch: "main", version: "2.1.0" };

/** A Claude Code session: a question, a tool call, and an answer. */
function claudeSession(sessionId: string, answer = "The parser keeps the last line."): string {
  const at = (second: number) => `2026-05-04T10:00:${String(second).padStart(2, "0")}.000Z`;
  return [
    {
      type: "user",
      uuid: "u1",
      timestamp: at(0),
      message: { role: "user", content: "Why does the parser drop the last line?" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      requestId: "req-1",
      timestamp: at(1),
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "look" } }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      timestamp: at(2),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "found it" }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      requestId: "req-2",
      timestamp: at(3),
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 120, output_tokens: 40 },
        content: [{ type: "text", text: answer }],
      },
    },
  ]
    .map((record) => JSON.stringify({ ...BASE, sessionId, ...record }))
    .join("\n");
}

function add(db: Database, sessionId: string, answer?: string): number {
  return upsertSession(
    db,
    parseClaudeSession(sessionId, claudeSession(sessionId, answer)),
    `/synthetic/${sessionId}.jsonl`,
    1,
    2,
  );
}

function read(path: string): AtifTrajectory {
  return JSON.parse(readFileSync(path, "utf8")) as AtifTrajectory;
}

/** Every file under a folder, relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe("mirrorAtif", () => {
  test("writes one document per session at a stable path, without the working directory", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      db.exec("UPDATE project SET repo_remote = 'github.com/acme/widget'");

      expect(mirrorAtif(db, { out })).toEqual({ out, written: 1, unchanged: 0, skipped: 0 });
      expect(files(out)).toEqual(["claude_code/first.atif.json"]);
      const doc = read(join(out, "claude_code/first.atif.json"));
      expect(doc.session_id).toBe("first");
      expect(doc.agent.name).toBe("claude-code");
      expect(doc.extra).toMatchObject({ repository: "github.com/acme/widget", git_branch: "main" });
      expect(doc.extra.cwd).toBeUndefined();
      expect(readFileSync(join(out, "claude_code/first.atif.json"), "utf8")).not.toContain(
        BASE.cwd,
      );
      // The documents hold transcripts, so only their owner can open the folder.
      expect(statSync(out).mode & 0o777).toBe(0o700);
    } finally {
      closeDb(db);
    }
  });

  test("rewrites only the sessions that changed", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      add(db, "second");
      expect(mirrorAtif(db, { out })).toMatchObject({ written: 2, unchanged: 0 });

      const untouched = join(out, "claude_code/first.atif.json");
      const old = new Date("2020-01-01T00:00:00Z");
      utimesSync(untouched, old, old);
      expect(mirrorAtif(db, { out })).toMatchObject({ written: 0, unchanged: 2 });

      add(db, "second", "The parser now keeps every line, including the last one.");
      expect(mirrorAtif(db, { out })).toMatchObject({ written: 1, unchanged: 1 });
      expect(statSync(untouched).mtime).toEqual(old);
      expect(JSON.stringify(read(join(out, "claude_code/second.atif.json")))).toContain(
        "including the last one",
      );
      // No temporary files are left behind.
      expect(files(out)).toEqual(["claude_code/first.atif.json", "claude_code/second.atif.json"]);
    } finally {
      closeDb(db);
    }
  });

  test("writes a subagent as its own file, linked both ways by relative path", () => {
    const { db, out } = fresh();
    try {
      const parentId = add(db, "parent");
      const childId = add(db, "child");
      db.query(
        `UPDATE session SET is_subagent = 1, parent_session_id = ?1,
         spawn_tool_use_id = 'toolu_task', agent_id = 'a1' WHERE id = ?2`,
      ).run(parentId, childId);

      expect(mirrorAtif(db, { out })).toMatchObject({ written: 2 });
      const parentPath = join(out, "claude_code/parent.atif.json");
      const childPath = join(out, "claude_code/child.atif.json");
      const parent = read(parentPath);
      const child = read(childPath);

      // The parent points at the child's file instead of embedding it.
      expect(parent.subagent_trajectories).toBeUndefined();
      const refs = parent.steps.flatMap(
        (step) =>
          step.observation?.results.flatMap((result) => result.subagent_trajectory_ref ?? []) ?? [],
      );
      expect(refs).toEqual([
        {
          trajectory_id: child.trajectory_id,
          session_id: "child",
          trajectory_path: "./child.atif.json",
        },
      ]);
      expect(join(dirname(parentPath), refs[0]?.trajectory_path ?? "")).toBe(childPath);

      // The child names its parent, which ATIF has no field for.
      expect(child.extra).toMatchObject({
        parent_session_id: "parent",
        parent_trajectory_path: "./parent.atif.json",
      });
      expect(parent.extra.parent_session_id).toBeUndefined();
    } finally {
      closeDb(db);
    }
  });

  test("reads back into Decant with the subagent linked and nothing counted twice", async () => {
    const { db, out } = fresh();
    const parentId = add(db, "parent");
    const childId = add(db, "child");
    db.query(
      `UPDATE session SET is_subagent = 1, parent_session_id = ?1,
       spawn_tool_use_id = 'toolu_task', agent_id = 'a1' WHERE id = ?2`,
    ).run(parentId, childId);
    mirrorAtif(db, { out });
    // The import names a subagent by its trajectory id, so compare by role.
    const totals = `SELECT is_subagent, total_input_tokens, total_output_tokens
                      FROM session ORDER BY is_subagent`;
    const original = db.query(totals).all();
    closeDb(db);

    const copyPath = join(workDir, `copy-${counter}.db`);
    const sync = await runCli(["--db", copyPath, "sync", "--atif-dir", out, "--path", out]);
    expect(sync.code).toBe(0);
    const copy = openDb(copyPath);
    try {
      expect(copy.query(totals).all()).toEqual(original);
      expect(
        copy
          .query(
            `SELECT child.tool, parent.source_session_id AS parent FROM session child
               JOIN session parent ON parent.id = child.parent_session_id`,
          )
          .all(),
      ).toEqual([{ tool: "atif", parent: "parent" }]);
    } finally {
      closeDb(copy);
    }
  });
});

describe("atifMirrorPath", () => {
  test("keeps every id inside its tool's folder", () => {
    expect(atifMirrorPath("codex", "019a-uuid")).toBe("codex/019a-uuid.atif.json");
    expect(atifMirrorPath("atif", "runs/7:a*b")).toBe("atif/runs%2F7%3Aa%2Ab.atif.json");
    expect(atifMirrorPath("atif", "..")).toBe("atif/%2E..atif.json");
    expect(atifMirrorPath("atif", ".hidden")).toBe("atif/%2Ehidden.atif.json");
  });
});

describe("decant export --mirror", () => {
  test("mirrors from the command line and refuses other formats", async () => {
    const { db, dbPath, out } = fresh();
    add(db, "first");
    closeDb(db);

    const first = await runCli(["--db", dbPath, "--no-sync", "export", "--mirror", out]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`mirrored ATIF to ${out}`);
    expect(first.stdout).toContain("written: 1");

    const again = await runCli(["--db", dbPath, "--no-sync", "--json", "export", "--mirror", out]);
    expect(JSON.parse(again.stdout)).toEqual({ out, written: 0, unchanged: 1, skipped: 0 });

    const markdown = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "export",
      "--mirror",
      out,
      "--as",
      "md",
    ]);
    expect(markdown.code).toBe(2);
    expect(markdown.stderr).toContain("--mirror writes ATIF only");

    const withId = await runCli(["--db", dbPath, "--no-sync", "export", "1", "--mirror", out]);
    expect(withId.code).toBe(2);
  });
});
