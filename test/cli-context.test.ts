import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { type Archive, type CliRunOptions, createContext, type Io } from "../src/cli/context.ts";
import { CliError } from "../src/cli/errors.ts";
import { closeDb, openDb } from "../src/db.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-context-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function harness(
  argv: string[],
  options: CliRunOptions = {},
  archive: "exists" | "missing" = "exists",
) {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex");
  const geminiDir = join(dir, "gemini");
  for (const path of [claudeDir, codexDir, geminiDir]) {
    mkdirSync(path, { recursive: true });
  }
  copyFileSync(
    join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
    join(claudeDir, "sample.jsonl"),
  );

  const io: Io = {
    stdout: "",
    stderr: "",
    writeOut(value) {
      this.stdout += value;
    },
    writeErr(value) {
      this.stderr += value;
    },
  };
  let code = 0;
  const program = new Command()
    .option("--db <path>")
    .option("--json")
    .option("-q, --quiet")
    .option("--no-sync");
  const dbPath = join(dir, "archive.db");
  if (archive === "exists") {
    closeDb(openDb(dbPath));
  }
  program.parse(["--db", dbPath, ...argv], { from: "user" });
  const ctx = createContext(program, io, { homeDir: dir, env: {}, ...options }, (value) => {
    code = value;
  });
  return { ctx, io, code: () => code, dbPath, overrides: { claudeDir, codexDir, geminiDir } };
}

function sessionCount(archive: Archive): number {
  return (archive.db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n;
}

describe("withArchive", () => {
  test("closes the database when the callback throws", () => {
    const { ctx } = harness([]);
    let opened: Archive | undefined;
    expect(() =>
      ctx.withArchive((archive) => {
        opened = archive;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(() => opened?.db.query("SELECT 1").get()).toThrow();
  });

  test("returns the callback result", () => {
    const { ctx } = harness([]);
    expect(ctx.withArchive(() => 7)).toBe(7);
  });

  test("syncs before the callback only when asked and allowed", () => {
    const off = harness([]);
    expect(off.ctx.withArchive(sessionCount, { overrides: off.overrides })).toBe(0);

    const on = harness([]);
    expect(on.ctx.withArchive(sessionCount, { sync: true, overrides: on.overrides })).toBe(1);

    const flagged = harness(["--no-sync"]);
    expect(
      flagged.ctx.withArchive(sessionCount, { sync: true, overrides: flagged.overrides }),
    ).toBe(0);

    const envGated = harness([], { env: { DECANT_NO_SYNC: "1" } });
    expect(
      envGated.ctx.withArchive(sessionCount, { sync: true, overrides: envGated.overrides }),
    ).toBe(0);
  });
});

describe("withArchive and a missing archive", () => {
  function thrownBy(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test("refuses a --db path that has no file, and creates nothing", () => {
    const { ctx, dbPath } = harness([], {}, "missing");
    const error = thrownBy(() => ctx.withArchive(sessionCount, { sync: true }));
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "archive_not_found",
      exitCode: 1,
      details: { path: dbPath },
    });
    expect((error as CliError).message).toContain(`no Decant archive at ${dbPath} (from --db)`);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("refuses a DECANT_DB path the same way and names the variable", () => {
    const dir = mkdtempSync(join(workDir, "env-db-"));
    const dbPath = join(dir, "nested", "archive.db");
    const io: Io = { stdout: "", stderr: "", writeOut() {}, writeErr() {} };
    const program = new Command().option("--db <path>").option("--json").option("--no-sync");
    program.parse([], { from: "user" });
    const ctx = createContext(
      program,
      io,
      { homeDir: dir, env: { DECANT_DB: dbPath, DECANT_NO_SYNC: "1" } },
      () => {},
    );
    const error = thrownBy(() => ctx.withArchive(sessionCount, { sync: true }));
    expect(error).toMatchObject({ code: "archive_not_found" });
    expect((error as CliError).message).toContain(`${dbPath} (from DECANT_DB)`);
    expect(existsSync(join(dir, "nested"))).toBe(false);
  });

  test("creates the archive for a command that asks to", () => {
    const { ctx, dbPath } = harness([], {}, "missing");
    expect(ctx.withArchive(sessionCount, { create: true })).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
  });

  test("creates the default archive on first run", () => {
    const dir = mkdtempSync(join(workDir, "default-db-"));
    const io: Io = { stdout: "", stderr: "", writeOut() {}, writeErr() {} };
    const program = new Command().option("--db <path>").option("--json").option("--no-sync");
    program.parse(["--no-sync"], { from: "user" });
    const ctx = createContext(program, io, { homeDir: dir, env: {} }, () => {});
    expect(ctx.withArchive(sessionCount, { sync: true })).toBe(0);
    expect(existsSync(join(dir, ".decant", "decant.db"))).toBe(true);
  });

  test("names the path when the file is not an archive", () => {
    const { ctx, dbPath } = harness([], {}, "missing");
    writeFileSync(dbPath, "not a database, just synthetic text\n".repeat(200));
    const error = thrownBy(() => ctx.withArchive(sessionCount));
    expect(error).toMatchObject({ code: "archive_unreadable", details: { path: dbPath } });
    expect((error as CliError).message).toContain(dbPath);
  });
});

describe("the notice for a sync a read command starts", () => {
  const NOTICE =
    /^note: syncing session logs before this command, \d+ of 1 files checked so far\. Pass --no-sync to skip the sync\.\n$/;

  test("prints once on stderr when the sync outlasts the wait", () => {
    const { ctx, io, overrides } = harness([], { syncNoticeAfterMs: 0 });
    expect(ctx.withArchive(sessionCount, { sync: true, overrides })).toBe(1);
    expect(io.stderr).toMatch(NOTICE);
    expect(io.stdout).toBe("");
  });

  test("still prints under --json, where an agent would otherwise see a hang", () => {
    const { ctx, io, overrides } = harness(["--json"], { syncNoticeAfterMs: 0 });
    ctx.withArchive(sessionCount, { sync: true, overrides });
    expect(io.stderr).toMatch(NOTICE);
    expect(io.stdout).toBe("");
  });

  test("stays silent for a fast sync, under --quiet, and when nothing syncs", () => {
    const fast = harness([], { syncNoticeAfterMs: 60_000 });
    expect(fast.ctx.withArchive(sessionCount, { sync: true, overrides: fast.overrides })).toBe(1);
    expect(fast.io.stderr).toBe("");

    const quiet = harness(["--quiet"], { syncNoticeAfterMs: 0 });
    expect(quiet.ctx.withArchive(sessionCount, { sync: true, overrides: quiet.overrides })).toBe(1);
    expect(quiet.io.stderr).toBe("");

    const noSync = harness(["--no-sync"], { syncNoticeAfterMs: 0 });
    noSync.ctx.withArchive(sessionCount, { sync: true, overrides: noSync.overrides });
    expect(noSync.io.stderr).toBe("");

    const explicit = harness([], { syncNoticeAfterMs: 0 });
    explicit.ctx.withArchive(sessionCount, { overrides: explicit.overrides });
    expect(explicit.io.stderr).toBe("");
  });
});

describe("run", () => {
  test("reports a thrown CliError with its own exit code", async () => {
    const { ctx, io, code } = harness([]);
    await ctx.run(() => {
      throw new CliError("invalid_argument", "bad value", 2, { option: "--x", value: "y" });
    });
    expect(io.stderr).toBe("error: bad value\n");
    expect(code()).toBe(2);
  });

  test("under --json, a thrown error is one JSON line on stderr", async () => {
    const { ctx, io, code } = harness(["--json"]);
    await ctx.run(() => {
      throw new CliError("invalid_argument", "bad value", 2, { option: "--x", value: "y" });
    });
    expect(io.stdout).toBe("");
    expect(JSON.parse(io.stderr)).toEqual({
      error: { code: "invalid_argument", message: "bad value", option: "--x", value: "y" },
    });
    expect(io.stderr.endsWith("}\n")).toBe(true);
    expect(code()).toBe(2);

    const plain = harness(["--json"]);
    await plain.ctx.run(() => {
      throw new Error("nope");
    });
    expect(JSON.parse(plain.io.stderr)).toEqual({
      error: { code: "command_failed", message: "nope" },
    });
    expect(plain.code()).toBe(1);
  });

  test("under --json, an error line a command wrote becomes the same shape", async () => {
    const missing = harness(["--json"]);
    await missing.ctx.run(() => {
      missing.ctx.io.writeErr("error: no session with id 7\n");
      return 1;
    });
    expect(missing.io.stdout).toBe("");
    expect(JSON.parse(missing.io.stderr)).toEqual({
      error: { code: "session_not_found", message: "no session with id 7" },
    });

    const usage = harness(["--json"]);
    await usage.ctx.run(() => {
      usage.ctx.io.writeErr("error: --all requires --out <dir>\n");
      return 2;
    });
    expect(JSON.parse(usage.io.stderr)).toEqual({
      error: { code: "usage_error", message: "--all requires --out <dir>" },
    });
    expect(usage.code()).toBe(2);

    const other = harness(["--json"]);
    await other.ctx.run(() => {
      other.ctx.io.writeErr("error: session 3 has no exportable steps\n");
      return 1;
    });
    expect(JSON.parse(other.io.stderr)).toEqual({
      error: { code: "command_failed", message: "session 3 has no exportable steps" },
    });
  });

  test("under --json, a failure with no result and no message still gets an object", async () => {
    const silent = harness(["--json"]);
    await silent.ctx.run(() => {
      silent.ctx.io.writeErr("nothing matched\n");
      return 1;
    });
    expect(silent.io.stderr.split("\n")).toEqual([
      "nothing matched",
      '{"error":{"code":"command_failed","message":"the command exited with code 1"}}',
      "",
    ]);

    // A command that already printed a JSON result reports through it.
    const result = harness(["--json"]);
    await result.ctx.run(() => {
      result.ctx.writeJson({ deleted: false, error: "session not found" });
      return 1;
    });
    expect(result.io.stderr).toBe("");

    // Exit 3 and above are reports, such as sync's count of dropped lines.
    const report = harness(["--json"]);
    await report.ctx.run(() => 3);
    expect(report.io.stderr).toBe("");

    const human = harness([]);
    await human.ctx.run(() => 1);
    expect(human.io.stderr).toBe("");
  });

  test("leaves notes and human-mode error lines as the command wrote them", async () => {
    const note = harness(["--json"]);
    await note.ctx.run(() => {
      note.ctx.io.writeErr("wrote out/3.md\n");
    });
    expect(note.io.stderr).toBe("wrote out/3.md\n");
    expect(note.code()).toBe(0);

    const human = harness([]);
    await human.ctx.run(() => {
      human.ctx.io.writeErr("error: no session with id 7\n");
      return 1;
    });
    expect(human.io.stderr).toBe("error: no session with id 7\n");
  });

  test("stores the returned exit code", async () => {
    const { ctx, code } = harness([]);
    await ctx.run(() => 3);
    expect(code()).toBe(3);
  });

  test("maps a thrown error to stderr and exit code 1", async () => {
    const { ctx, io, code } = harness([]);
    await ctx.run(async () => {
      throw new Error("nope");
    });
    expect(io.stderr).toBe("error: nope\n");
    expect(code()).toBe(1);
  });
});

describe("output", () => {
  test("writes indented JSON with a trailing newline under --json", () => {
    const { ctx, io } = harness(["--json"]);
    ctx.output({ a: 1 }, () => "human\n");
    expect(io.stdout).toBe('{\n  "a": 1\n}\n');
  });

  test("renders the human form otherwise", () => {
    const { ctx, io } = harness([]);
    ctx.output({ a: 1 }, () => "human\n");
    expect(io.stdout).toBe("human\n");
  });
});
