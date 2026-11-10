import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type AtifMirrorReport, atifMirrorPath, mirrorAtif } from "../src/atif-mirror.ts";
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

function mirror(db: Database, out: string): AtifMirrorReport {
  const result = mirrorAtif(db, { out });
  if (!result.ok) throw new Error(`refused ${result.path}`);
  return result.report;
}

function nest(db: Database, parentId: number, childId: number, agentId = "a1"): void {
  db.query(
    `UPDATE session SET is_subagent = 1, parent_session_id = ?1,
     spawn_tool_use_id = 'toolu_task', agent_id = ?3 WHERE id = ?2`,
  ).run(parentId, childId, agentId);
}

function refsOf(doc: AtifTrajectory) {
  return doc.steps.flatMap(
    (step) =>
      step.observation?.results.flatMap((result) => result.subagent_trajectory_ref ?? []) ?? [],
  );
}

function read(path: string): AtifTrajectory {
  return JSON.parse(readFileSync(path, "utf8")) as AtifTrajectory;
}

/** Every file under a folder, relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

describe("mirrorAtif", () => {
  test("writes one document per session at a stable path, without the working directory", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      db.exec("UPDATE project SET repo_remote = 'github.com/acme/widget'");

      expect(mirror(db, out)).toEqual({ out, written: 1, unchanged: 0, skipped: 0 });
      expect(files(out)).toEqual(["claude_code/first.atif.json"]);
      const doc = read(join(out, "claude_code/first.atif.json"));
      expect(doc.session_id).toBe("first");
      expect(doc.agent.name).toBe("claude-code");
      expect(doc.extra).toMatchObject({ repository: "github.com/acme/widget", git_branch: "main" });
      expect(doc.extra.cwd).toBeUndefined();
      expect(readFileSync(join(out, "claude_code/first.atif.json"), "utf8")).not.toContain(
        BASE.cwd,
      );
      // The documents hold transcripts, so only their owner can read them.
      expect(statSync(out).mode & 0o777).toBe(0o700);
      expect(statSync(join(out, "claude_code/first.atif.json")).mode & 0o777).toBe(0o600);
    } finally {
      closeDb(db);
    }
  });

  test("rewrites only the sessions that changed", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      add(db, "second");
      expect(mirror(db, out)).toMatchObject({ written: 2, unchanged: 0 });

      const untouched = join(out, "claude_code/first.atif.json");
      const old = new Date("2020-01-01T00:00:00Z");
      utimesSync(untouched, old, old);
      expect(mirror(db, out)).toMatchObject({ written: 0, unchanged: 2 });

      add(db, "second", "The parser now keeps every line, including the last one.");
      expect(mirror(db, out)).toMatchObject({ written: 1, unchanged: 1 });
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
      nest(db, add(db, "parent"), add(db, "child"));

      expect(mirror(db, out)).toMatchObject({ written: 2 });
      const parentPath = join(out, "claude_code/parent.atif.json");
      const childPath = join(out, "claude_code/child.atif.json");
      const parent = read(parentPath);
      const child = read(childPath);

      // The parent points at the child's file instead of embedding it.
      expect(parent.subagent_trajectories).toBeUndefined();
      const refs = refsOf(parent);
      expect(parent.trajectory_id).toBe("claude_code:parent");
      expect(child.trajectory_id).toBe("claude_code:child:a1");
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
    nest(db, add(db, "parent"), add(db, "child"));
    mirror(db, out);
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
      ).toEqual([{ tool: "atif", parent: "claude_code:parent" }]);
    } finally {
      closeDb(copy);
    }
  });

  test("writes an archived subagent its parent points at, and nothing of an archived root", () => {
    const { db, out } = fresh();
    try {
      nest(db, add(db, "parent"), add(db, "child"));
      add(db, "hidden");
      const archive = db.prepare(
        "INSERT INTO session_user_state VALUES ('claude_code', ?1, 'archived', '2026-05-04')",
      );
      archive.run("child");
      archive.run("hidden");
      archive.finalize();

      expect(mirror(db, out)).toMatchObject({ written: 2 });
      expect(files(out)).toEqual(["claude_code/child.atif.json", "claude_code/parent.atif.json"]);
      expect(refsOf(read(join(out, "claude_code/parent.atif.json")))).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  });

  test("points past a subagent with nothing to export to the nearest written ancestor", () => {
    const { db, out } = fresh();
    try {
      const parentId = add(db, "parent");
      const emptyId = add(db, "empty");
      const grandchildId = add(db, "grandchild");
      nest(db, parentId, emptyId, "a1");
      nest(db, emptyId, grandchildId, "a2");
      db.query("DELETE FROM message WHERE session_id = ?1").run(emptyId);

      expect(mirror(db, out)).toMatchObject({ written: 2, skipped: 1 });
      expect(read(join(out, "claude_code/grandchild.atif.json")).extra).toMatchObject({
        parent_session_id: "parent",
        parent_trajectory_path: "./parent.atif.json",
      });
    } finally {
      closeDb(db);
    }
  });

  test("keeps sessions from two tools with one id apart, here and on import", async () => {
    const { db, out } = fresh();
    add(db, "same");
    add(db, "Same");
    // The same id under another tool: copy the session row as Codex's.
    db.exec(`UPDATE session SET tool = 'codex' WHERE source_session_id = 'Same'`);
    db.exec(`UPDATE session SET source_session_id = 'same' WHERE source_session_id = 'Same'`);
    expect(mirror(db, out)).toMatchObject({ written: 2 });
    expect(files(out)).toEqual(["claude_code/same.atif.json", "codex/same.atif.json"]);
    closeDb(db);

    const copyPath = join(workDir, `copy-${counter}.db`);
    expect((await runCli(["--db", copyPath, "sync", "--atif-dir", out, "--path", out])).code).toBe(
      0,
    );
    const copy = openDb(copyPath);
    try {
      expect(copy.query("SELECT source_session_id FROM session ORDER BY 1").all()).toEqual([
        { source_session_id: "claude_code:same" },
        { source_session_id: "codex:same" },
      ]);
    } finally {
      closeDb(copy);
    }
  });

  test("gives ids that differ only in case their own files", () => {
    const { db, out } = fresh();
    try {
      add(db, "case");
      add(db, "Case");
      expect(mirror(db, out)).toMatchObject({ written: 2 });
      expect(files(out)).toHaveLength(2);
      expect(mirror(db, out)).toMatchObject({ written: 0, unchanged: 2 });
    } finally {
      closeDb(db);
    }
  });

  test("refuses a tool folder that is a link, and replaces a document that is one", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      const elsewhere = join(workDir, `elsewhere-${counter}`);
      mkdirSync(elsewhere);
      mkdirSync(out, { recursive: true });
      symlinkSync(elsewhere, join(out, "claude_code"));
      expect(mirrorAtif(db, { out })).toEqual({
        ok: false,
        reason: "unsafe_path",
        path: join(out, "claude_code"),
      });
      expect(readdirSync(elsewhere)).toEqual([]);

      rmSync(join(out, "claude_code"));
      mkdirSync(join(out, "claude_code"));
      const victim = join(elsewhere, "victim.txt");
      writeFileSync(victim, "keep me");
      symlinkSync(victim, join(out, "claude_code/first.atif.json"));
      expect(mirror(db, out)).toMatchObject({ written: 1 });
      expect(readFileSync(victim, "utf8")).toBe("keep me");
      expect(read(join(out, "claude_code/first.atif.json")).session_id).toBe("first");
    } finally {
      closeDb(db);
    }
  });

  test("keeps the mode of a document it rewrites", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      mirror(db, out);
      const document = join(out, "claude_code/first.atif.json");
      chmodSync(document, 0o640);
      add(db, "first", "The parser now keeps every line, including the last one.");
      expect(mirror(db, out)).toMatchObject({ written: 1 });
      expect(statSync(document).mode & 0o777).toBe(0o640);

      // Write and execute access for others is not carried over.
      chmodSync(document, 0o777);
      add(db, "first", "The parser keeps every line again.");
      expect(mirror(db, out)).toMatchObject({ written: 1 });
      expect(statSync(document).mode & 0o777).toBe(0o644);
    } finally {
      closeDb(db);
    }
  });

  test("removes its temporary file when a document cannot be replaced", () => {
    const { db, out } = fresh();
    try {
      add(db, "first");
      mkdirSync(join(out, "claude_code/first.atif.json"), { recursive: true });
      expect(() => mirrorAtif(db, { out })).toThrow();
      expect(readdirSync(join(out, "claude_code"))).toEqual(["first.atif.json"]);
    } finally {
      closeDb(db);
    }
  });
});

describe("atifMirrorPath", () => {
  test("uses a plain id as the file name and gives any other id a digest", () => {
    expect(atifMirrorPath("codex", "019a-uuid")).toBe("codex/019a-uuid.atif.json");
    const named = (id: string) => atifMirrorPath("atif", id).slice("atif/".length);
    for (const id of [
      "runs/7:a*b",
      "..",
      ".hidden",
      "Case",
      "con",
      "COM1",
      "nul.x",
      "a".repeat(240),
    ]) {
      const name = named(id);
      expect(name).toMatch(
        /^[A-Za-z0-9-][A-Za-z0-9._-]*~[0-9a-f]{16}\.atif\.json$|^~[0-9a-f]{16}\.atif\.json$/,
      );
      expect(name.length).toBeLessThanOrEqual(100);
    }
    expect(named("runs/7:a*b")).toStartWith("runs_7_a_b~");
    expect(named("Case").toLowerCase()).not.toBe(named("case").toLowerCase());
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
