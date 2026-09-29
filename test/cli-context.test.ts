import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { type Archive, type CliRunOptions, createContext, type Io } from "../src/cli/context.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-context-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function harness(argv: string[], options: CliRunOptions = {}) {
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
  const program = new Command().option("--db <path>").option("--json").option("--no-sync");
  program.parse(["--db", join(dir, "archive.db"), ...argv], { from: "user" });
  const ctx = createContext(program, io, { homeDir: dir, env: {}, ...options }, (value) => {
    code = value;
  });
  return { ctx, io, code: () => code, overrides: { claudeDir, codexDir, geminiDir } };
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

describe("run", () => {
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
