import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultArgv, runCli } from "../src/cli.ts";
import { closeDb, LATEST_SCHEMA_VERSION, openDb } from "../src/db.ts";
import { DECANT_VERSION } from "../src/distill.ts";
import { upsertSession } from "../src/ingest.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshCase(): { dbPath: string; claudeDir: string; codexDir: string; geminiDir: string } {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(dir, "sources", "claude");
  const codexDir = join(dir, "sources", "codex");
  const geminiDir = join(dir, "sources", "gemini");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  for (const name of ["distill.jsonl", "enriched.jsonl", "mcp.jsonl", "sample.jsonl"]) {
    copyFileSync(join(import.meta.dir, "..", "fixtures", "claude", name), join(claudeDir, name));
  }
  for (const name of ["distill.jsonl", "enriched.jsonl", "sample.jsonl"]) {
    copyFileSync(
      join(import.meta.dir, "..", "fixtures", "codex", name),
      join(codexDir, "sessions", `rollout-${name}`),
    );
  }
  return { dbPath: join(dir, "archive.db"), claudeDir, codexDir, geminiDir };
}

async function syncedCase(): Promise<{ dbPath: string }> {
  const fixtureCase = freshCase();
  const result = await runCli([
    "--db",
    fixtureCase.dbPath,
    "--json",
    "sync",
    "--claude-dir",
    fixtureCase.claudeDir,
    "--codex-dir",
    fixtureCase.codexDir,
    "--gemini-dir",
    fixtureCase.geminiDir,
  ]);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toMatchObject({ scanned: 7, ingested: 7, issues: 0 });
  return { dbPath: fixtureCase.dbPath };
}

describe("defaultArgv", () => {
  test("an empty invocation becomes serve", () => {
    expect(defaultArgv([])).toEqual(["serve"]);
  });

  test("commands pass through untouched", () => {
    expect(defaultArgv(["ls"])).toEqual(["ls"]);
  });

  test("flag-only invocations pass through untouched", () => {
    expect(defaultArgv(["--db", "/tmp/x.db"])).toEqual(["--db", "/tmp/x.db"]);
    expect(defaultArgv(["--help"])).toEqual(["--help"]);
  });
});

describe("unknown commands still fail fast", () => {
  test("a typo does not silently start a server", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("frobnicate");
  });
});

describe("runCli", () => {
  test("sync then list, project, db, stats, search, files, tool, and export", async () => {
    const { dbPath } = await syncedCase();
    const base = ["--db", dbPath, "--json", "--no-sync"];

    const list = await runCli([...base, "ls"]);
    expect(list.code).toBe(0);
    const sessions = JSON.parse(list.stdout) as { id: number; source_session_id: string }[];
    expect(sessions).toHaveLength(7);
    expect(sessions[0]?.source_session_id).toBe("sess-codex-distill");
    const distillSession = sessions.find((session) =>
      session.source_session_id.includes("distill"),
    );
    if (distillSession == null) {
      throw new Error("expected a distill fixture session");
    }

    const quietList = await runCli(["--db", dbPath, "--no-sync", "--quiet", "ls"]);
    expect(quietList).toMatchObject({ code: 0, stderr: "" });
    expect(quietList.stdout.trim().split("\n")).toEqual(
      sessions.map((session) => String(session.id)),
    );

    const projects = await runCli([...base, "project", "ls"]);
    expect(projects.code).toBe(0);
    expect((JSON.parse(projects.stdout) as { path: string; sessions: number }[])[0]).toMatchObject({
      path: "/Users/dev/proj",
      sessions: 7,
    });

    const dbInfo = await runCli([...base, "db", "info"]);
    expect(dbInfo.code).toBe(0);
    expect(JSON.parse(dbInfo.stdout)).toMatchObject({
      path: dbPath,
      schema_version: LATEST_SCHEMA_VERSION,
      sessions: 7,
    });

    const migrated = await runCli(["--db", dbPath, "--no-sync", "db", "migrate"]);
    expect(migrated).toMatchObject({ code: 0, stdout: "" });
    expect(migrated.stderr).toContain(`schema up to date at ${dbPath}`);

    const vacuumed = await runCli(["--db", dbPath, "--no-sync", "db", "vacuum"]);
    expect(vacuumed).toMatchObject({ code: 0, stdout: "" });
    expect(vacuumed.stderr).toContain(`vacuumed ${dbPath}`);

    const stats = await runCli([...base, "stats", "--by", "model"]);
    expect(stats.code).toBe(0);
    expect(JSON.parse(stats.stdout)).toMatchObject([
      { key: "claude-opus-4-7", sessions: 4 },
      { key: "gpt-5.4", sessions: 3 },
    ]);

    const tokens = await runCli([...base, "tokens"]);
    expect(tokens.code).toBe(0);
    expect(JSON.parse(tokens.stdout)).toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({ bucket: "context", active_ms: expect.any(Number) }),
      ]),
      totals: expect.objectContaining({
        active_ms: expect.any(Number),
        waiting_on_user_ms: expect.any(Number),
        attributed_ms: expect.any(Number),
      }),
    });
    const humanTokens = await runCli(["--db", dbPath, "--no-sync", "tokens"]);
    expect(humanTokens).toMatchObject({ code: 0, stderr: "" });
    expect(humanTokens.stdout).toContain("waiting_on_user\t-\t-\t-");

    const search = await runCli([...base, "search", "auth", "--limit", "5"]);
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).length).toBeGreaterThan(0);

    const files = await runCli([...base, "files", "--group", "ext"]);
    expect(files.code).toBe(0);
    expect((JSON.parse(files.stdout) as { key: string }[]).some((row) => row.key === "rs")).toBe(
      true,
    );

    const tools = await runCli([...base, "tool", "stats", "--limit", "3"]);
    expect(tools.code).toBe(0);
    expect((JSON.parse(tools.stdout) as { tool_name: string }[])[0]?.tool_name).toBe("Bash");

    const exported = await runCli(["--db", dbPath, "--no-sync", "export", String(sessions[0]?.id)]);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toStartWith("# Build and patch");

    const script = await runCli([...base, "distill", "script", "--as", "just"]);
    expect(script.code).toBe(0);
    const scriptJson = JSON.parse(script.stdout) as { scope: string; artifact: string };
    expect(scriptJson.scope).toBe("all sessions");
    expect(scriptJson.artifact).toContain("cargo build --workspace");

    const replay = await runCli([
      ...base,
      "distill",
      "replay",
      String(distillSession.id),
      "--include-errors",
    ]);
    expect(replay.code).toBe(0);
    const replayJson = JSON.parse(replay.stdout) as { session_id: number; artifact: string };
    expect(replayJson.session_id).toBe(distillSession.id);
    expect(replayJson.artifact).toContain("#!/usr/bin/env bash");

    const skill = await runCli([...base, "distill", "skill", "--project", "/Users/dev/proj"]);
    expect(skill.code).toBe(0);
    const skillJson = JSON.parse(skill.stdout) as { project: string; artifact: string };
    expect(skillJson.project).toBe("/Users/dev/proj");
    expect(skillJson.artifact).toContain("# /Users/dev/proj workflow");

    const recommendations = await runCli([...base, "recommendations", "ls", "--status", "all"]);
    expect(recommendations.code).toBe(0);
    const recs = JSON.parse(recommendations.stdout) as { key: string; status: string }[];
    expect(recs.some((rec) => rec.key === "catalog:agents-md")).toBe(true);

    const db = openDb(dbPath);
    db.query("UPDATE recommendation SET score = 12345 WHERE key = 'catalog:agents-md'").run();
    db.close();
    const rereadRecommendations = await runCli([
      ...base,
      "recommendations",
      "ls",
      "--status",
      "all",
    ]);
    expect(rereadRecommendations.code).toBe(0);
    expect(
      (JSON.parse(rereadRecommendations.stdout) as { key: string; score: number }[]).find(
        (rec) => rec.key === "catalog:agents-md",
      )?.score,
    ).toBe(12345);

    const marked = await runCli([
      ...base,
      "recommendations",
      "mark",
      "catalog:agents-md",
      "--source",
      "agent",
      "--note",
      "done",
    ]);
    expect(marked.code).toBe(0);
    expect(JSON.parse(marked.stdout)).toMatchObject({
      ok: true,
      key: "catalog:agents-md",
      status: "implemented",
    });

    const implemented = await runCli([...base, "recommendations", "ls", "--status", "implemented"]);
    expect(implemented.code).toBe(0);
    expect((JSON.parse(implemented.stdout) as { key: string }[]).map((rec) => rec.key)).toContain(
      "catalog:agents-md",
    );
  });

  test("export --as trajectory writes a validating JSON array", async () => {
    const { dbPath } = await syncedCase();
    const list = await runCli(["--db", dbPath, "--json", "--no-sync", "ls"]);
    const sessions = JSON.parse(list.stdout) as { id: number; source_session_id: string }[];
    const sessionId = sessions.find((session) => session.source_session_id === "sample")?.id;
    if (sessionId == null) {
      throw new Error('expected the claude sample fixture session (source_session_id "sample")');
    }

    // Globals after the subcommand: a regression guard for the exact shape
    // AGENTS.md's "global flags on every command" contract, the justfile
    // wrappers (`just ls {{ARGS}}`), and the bug-report template's repro
    // commands all rely on — decant sync/ls --db ... --no-sync, not
    // --db/--no-sync first.
    const result = await runCli([
      "export",
      String(sessionId),
      "--as",
      "trajectory",
      "--db",
      dbPath,
      "--no-sync",
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const records = JSON.parse(result.stdout) as { role: string; source?: string }[];
    expect(records[0]).toMatchObject({ role: "meta", source: "claude-code" });
  });

  test("global flags after the subcommand still parse (ls --db X --no-sync)", async () => {
    const { dbPath } = await syncedCase();
    const result = await runCli(["ls", "--json", "--db", dbPath, "--no-sync"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect((JSON.parse(result.stdout) as unknown[]).length).toBeGreaterThan(0);
  });

  test("export --all --as trajectory names files <id>.trajectory.json", async () => {
    const { dbPath } = await syncedCase();
    const list = await runCli(["--db", dbPath, "--json", "--no-sync", "ls"]);
    const sessions = JSON.parse(list.stdout) as { id: number; source_session_id: string }[];
    const sessionId = sessions.find((session) => session.source_session_id === "sample")?.id;
    if (sessionId == null) {
      throw new Error('expected the claude sample fixture session (source_session_id "sample")');
    }

    const outDir = join(workDir, `traj-out-${caseCounter}`);
    const result = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "export",
      "--all",
      "--as",
      "trajectory",
      "--out",
      outDir,
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(outDir, `${sessionId}.trajectory.json`))).toBe(true);
    // All 7 fixture sessions carry both roles, so none should be skipped here;
    // the skip-tally path itself is covered separately below. Several fixtures
    // do legitimately trigger repairs (wrapped args, dropped noise), so this
    // only pins the final tally line, not the whole of stderr.
    expect(result.stderr).toContain(`exported 7 sessions to ${outDir}\n`);
    expect(result.stderr).not.toContain("skipped");
  });

  test("export --as trajectory reports exit 1 for non-exportable or missing sessions, and tallies skips under --all", async () => {
    const dir = mkdtempSync(join(workDir, "traj-exit1-"));
    const dbPath = join(dir, "archive.db");
    const db = openDb(dbPath);
    const goodId = upsertSession(
      db,
      parseClaudeSession(
        "traj-good",
        readFileSync(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"), "utf8"),
      ),
      "/good.jsonl",
      1,
      2,
      "hash-good",
    );
    const assistantOnlyId = upsertSession(
      db,
      parseClaudeSession(
        "traj-assistant-only",
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-01T00:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        }),
      ),
      "/assistant-only.jsonl",
      1,
      2,
      "hash-assistant-only",
    );
    const userOnlyId = upsertSession(
      db,
      parseClaudeSession(
        "traj-user-only",
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
      ),
      "/user-only.jsonl",
      1,
      2,
      "hash-user-only",
    );
    db.close();

    const base = ["--db", dbPath, "--no-sync"];
    const missingAssistant = await runCli([
      ...base,
      "export",
      String(assistantOnlyId),
      "--as",
      "trajectory",
    ]);
    expect(missingAssistant).toMatchObject({
      code: 1,
      stderr: `error: session ${assistantOnlyId} has no user records; not exportable as a trajectory\n`,
    });

    const missingUser = await runCli([...base, "export", String(userOnlyId), "--as", "trajectory"]);
    expect(missingUser).toMatchObject({
      code: 1,
      stderr: `error: session ${userOnlyId} has no assistant records; not exportable as a trajectory\n`,
    });

    const notFound = await runCli([...base, "export", "999999", "--as", "trajectory"]);
    expect(notFound).toMatchObject({ code: 1, stderr: "error: no session with id 999999\n" });

    const outDir = join(dir, "out");
    const all = await runCli([...base, "export", "--all", "--as", "trajectory", "--out", outDir]);
    expect(all.code).toBe(0);
    expect(existsSync(join(outDir, `${goodId}.trajectory.json`))).toBe(true);
    expect(existsSync(join(outDir, `${assistantOnlyId}.trajectory.json`))).toBe(false);
    expect(existsSync(join(outDir, `${userOnlyId}.trajectory.json`))).toBe(false);
    expect(all.stderr).toContain("(2 skipped)");
  });

  test("export --all --as trajectory only visits subagents with --include-subagents, and --quiet suppresses the repairs line", async () => {
    const dir = mkdtempSync(join(workDir, "traj-subagents-"));
    const dbPath = join(dir, "archive.db");
    const db = openDb(dbPath);
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at, is_subagent, parent_session_id)
      VALUES
        (1, 'claude_code', 'root', '2026-07-01T00:00:00Z', 0, NULL),
        (2, 'claude_code', 'kid', '2026-07-01T00:01:00Z', 1, 1);
      INSERT INTO message(id, session_id, seq, role, raw) VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 1, 1, 'assistant', '{}'),
        (3, 2, 0, 'user', '{}'),
        (4, 2, 1, 'assistant', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text) VALUES
        (1, 1, 0, 'text', 'Root prompt'),
        (2, 1, 0, 'text', 'Root reply'),
        (3, 2, 0, 'text', 'Kid prompt'),
        (4, 2, 0, 'text', 'Kid reply');
    `);
    db.close();

    const base = ["--db", dbPath, "--no-sync"];

    const withoutDir = join(dir, "without");
    const without = await runCli([
      ...base,
      "export",
      "--all",
      "--as",
      "trajectory",
      "--out",
      withoutDir,
    ]);
    expect(without.code).toBe(0);
    expect(existsSync(join(withoutDir, "1.trajectory.json"))).toBe(true);
    expect(existsSync(join(withoutDir, "2.trajectory.json"))).toBe(false);
    // Every block above is missing a timestamp, so each visited session fills
    // two of them — a deterministic, non-empty repairs line to assert against.
    expect(without.stderr).toContain("session 1: timestamps_filled=2");
    expect(without.stderr).not.toContain("session 2:");

    const withDir = join(dir, "with");
    const withSubagents = await runCli([
      ...base,
      "export",
      "--all",
      "--include-subagents",
      "--as",
      "trajectory",
      "--out",
      withDir,
    ]);
    expect(withSubagents.code).toBe(0);
    expect(existsSync(join(withDir, "1.trajectory.json"))).toBe(true);
    expect(existsSync(join(withDir, "2.trajectory.json"))).toBe(true);
    expect(withSubagents.stderr).toContain("session 1: timestamps_filled=2");
    expect(withSubagents.stderr).toContain("session 2: timestamps_filled=2");

    const quietDir = join(dir, "quiet");
    const quiet = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "--quiet",
      "export",
      "--all",
      "--include-subagents",
      "--as",
      "trajectory",
      "--out",
      quietDir,
    ]);
    expect(quiet.code).toBe(0);
    expect(existsSync(join(quietDir, "1.trajectory.json"))).toBe(true);
    expect(existsSync(join(quietDir, "2.trajectory.json"))).toBe(true);
    expect(quiet.stderr).not.toContain("timestamps_filled");
    expect(quiet.stderr).toBe(`exported 2 sessions to ${quietDir}\n`);
  });

  test("export rejects unknown --as values and follows --json for the default", async () => {
    const { dbPath } = await syncedCase();
    const list = await runCli(["--db", dbPath, "--json", "--no-sync", "ls"]);
    const sessions = JSON.parse(list.stdout) as { id: number }[];
    const sessionId = sessions[0]?.id;
    if (sessionId == null) {
      throw new Error("expected at least one synced session");
    }

    const badFormat = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "export",
      String(sessionId),
      "--as",
      "bogus",
    ]);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("error: unknown export format: bogus");

    const jsonDefault = await runCli([
      "--db",
      dbPath,
      "--json",
      "--no-sync",
      "export",
      String(sessionId),
    ]);
    expect(jsonDefault.code).toBe(0);
    expect(() => JSON.parse(jsonDefault.stdout)).not.toThrow();
    expect(jsonDefault.stdout.startsWith("#")).toBe(false);
  });

  test("sync exits 3 only for data loss and reports every issue code", async () => {
    const fixtureCase = freshCase();
    const targetDir = join(workDir, `case-${caseCounter}-codes`);
    mkdirSync(targetDir, { recursive: true });
    const sample = readFileSync(
      join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
      "utf8",
    ).trimEnd();

    // Informational only: an unknown record type keeps the line as role "other",
    // so nothing is lost and the exit code must stay 0.
    const informational = join(targetDir, "informational.jsonl");
    writeFileSync(
      informational,
      `${sample}\n{"type":"mystery","uuid":"m1","timestamp":"2026-05-01T10:01:00.000Z"}\n`,
    );
    const soft = await runCli(
      ["--db", fixtureCase.dbPath, "--json", "sync", "--path", informational],
      { homeDir: targetDir },
    );
    expect(soft.code).toBe(0);
    const softReport = JSON.parse(soft.stdout);
    expect(softReport).toMatchObject({
      issues: 1,
      issues_by_code: { unknown_record_type: 1 },
    });
    // The path is shell-quoted so the hint stays copy-pasteable when the
    // archive lives under a directory with a space in it.
    expect(softReport.issues_hint).toContain(`--db '${fixtureCase.dbPath}' ls --json`);
    expect(softReport.issues_hint).toContain("informational_ingest_issue_count");
    expect(softReport.issues_hint).toContain("/api/sessions/:id/issues");

    const flagged = JSON.parse(
      (await runCli(["--db", fixtureCase.dbPath, "--json", "--no-sync", "ls"])).stdout,
    ).filter(
      (row: { ingest_issue_count: number; informational_ingest_issue_count: number }) =>
        row.ingest_issue_count + row.informational_ingest_issue_count > 0,
    );
    expect(flagged).toHaveLength(1);

    const textCase = freshCase();
    const informationalText = join(targetDir, "informational-text.jsonl");
    writeFileSync(
      informationalText,
      `${sample}\n{"type":"mystery","uuid":"m2","timestamp":"2026-05-01T10:01:00.000Z"}\n`,
    );
    const softText = await runCli(["--db", textCase.dbPath, "sync", "--path", informationalText], {
      homeDir: targetDir,
    });
    expect(softText.code).toBe(0);
    expect(softText.stderr).toContain(`--db '${textCase.dbPath}' ls --json`);

    // An archive selected by DECANT_DB rather than --db still needs the flag,
    // or a one-shot `DECANT_DB=... decant sync` sends the reader to the
    // default archive instead of the one that reported the issue.
    const envCase = freshCase();
    const informationalEnv = join(targetDir, "informational-env.jsonl");
    writeFileSync(
      informationalEnv,
      `${sample}\n{"type":"mystery","uuid":"m3","timestamp":"2026-05-01T10:01:00.000Z"}\n`,
    );
    const softEnv = await runCli(["--json", "sync", "--path", informationalEnv], {
      env: { DECANT_DB: envCase.dbPath },
      homeDir: targetDir,
    });
    expect(softEnv.code).toBe(0);
    expect(JSON.parse(softEnv.stdout).issues_hint).toContain(`--db '${envCase.dbPath}' ls --json`);

    // No archive override at all: the bare command already reads the default,
    // so the flag would be noise. This run lands on `homeDir`'s default path.
    const informationalDefault = join(targetDir, "informational-default.jsonl");
    writeFileSync(
      informationalDefault,
      `${sample}\n{"type":"mystery","uuid":"m4","timestamp":"2026-05-01T10:01:00.000Z"}\n`,
    );
    const softDefault = await runCli(["--json", "sync", "--path", informationalDefault], {
      env: {},
      homeDir: targetDir,
    });
    expect(softDefault.code).toBe(0);
    expect(JSON.parse(softDefault.stdout).issues_hint).toContain("decant ls --json");

    // A line that cannot be parsed is content decant dropped: exit 3.
    const lossy = join(targetDir, "lossy.jsonl");
    writeFileSync(lossy, `${sample}\n{not json\n`);
    const hard = await runCli(["--db", fixtureCase.dbPath, "--json", "sync", "--path", lossy], {
      homeDir: targetDir,
    });
    expect(hard.code).toBe(3);
    expect(JSON.parse(hard.stdout)).toMatchObject({
      issues: 1,
      issues_by_code: { unparsed_line: 1 },
    });
  });

  test("sync --path ingests only the requested source files", async () => {
    const fixtureCase = freshCase();
    const targetDir = join(workDir, `case-${caseCounter}-targeted`);
    const claudePath = join(targetDir, "claude-one.jsonl");
    const codexPath = join(targetDir, "rollout-codex-one.jsonl");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"), claudePath);
    copyFileSync(join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl"), codexPath);

    const result = await runCli(
      ["--db", fixtureCase.dbPath, "--json", "sync", "--path", claudePath, "--path", codexPath],
      { homeDir: targetDir },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const cleanReport = JSON.parse(result.stdout);
    expect(cleanReport).toMatchObject({ scanned: 2, ingested: 2, issues: 0 });
    expect(cleanReport.issues_hint).toBeUndefined();

    const list = await runCli(["--db", fixtureCase.dbPath, "--json", "--no-sync", "ls"]);
    expect(list.code).toBe(0);
    expect(
      (JSON.parse(list.stdout) as { source_session_id: string }[]).map(
        (session) => session.source_session_id,
      ),
    ).toEqual(["sess-codex-1", "claude-one"]);
  });

  test("creates a missing archive directory owner-only", async () => {
    const fixtureCase = freshCase();
    const dbPath = join(dirname(fixtureCase.dbPath), "archive", "decant.db");

    const list = await runCli(["--db", dbPath, "--json", "--no-sync", "ls"]);
    expect(list).toMatchObject({ code: 0, stderr: "" });

    expect(statSync(dirname(dbPath)).mode & 0o7777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o7777).toBe(0o600);
  });

  test("read-only list and search remain available while another connection holds the writer lock", async () => {
    const { dbPath } = await syncedCase();
    const writer = openDb(dbPath);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      const list = await runCli(["--db", dbPath, "--json", "--no-sync", "ls"]);
      expect(list).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(list.stdout)).toBeArray();

      const search = await runCli(["--db", dbPath, "--json", "--no-sync", "search", "auth"]);
      expect(search).toMatchObject({ code: 0, stderr: "" });
      expect((JSON.parse(search.stdout) as unknown[]).length).toBeGreaterThan(0);
    } finally {
      writer.exec("ROLLBACK;");
      closeDb(writer);
    }
  }, 10_000);

  test("invalid options return code 2 with an error", async () => {
    const { dbPath } = await syncedCase();
    const unknownOption = await runCli(["--definitely-not-real"]);
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.stderr).toContain("unknown option");

    const missingArg = await runCli(["show"]);
    expect(missingArg.code).toBe(2);
    expect(missingArg.stderr).toContain("missing required argument");

    const result = await runCli(["--db", dbPath, "--no-sync", "stats", "--by", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown --by value");

    const missingPath = await runCli(["--db", dbPath, "sync", "--path", "/tmp/definitely-missing"]);
    expect(missingPath.code).toBe(2);
    expect(missingPath.stderr).toContain("--path does not exist");

    const badFormat = await runCli(["--format", "bogus", "ls"]);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("expected: table | json | md");

    const distill = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "distill",
      "script",
      "--as",
      "nope",
    ]);
    expect(distill.code).toBe(2);
    expect(distill.stderr).toContain("unknown --as");

    const recommendations = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "recommendations",
      "ls",
      "--status",
      "maybe",
    ]);
    expect(recommendations.code).toBe(2);
    expect(recommendations.stderr).toContain("unknown --status");
  });

  test("version and live output mode", async () => {
    const version = await runCli(["--version"]);
    expect(version).toMatchObject({ code: 0, stderr: "" });
    expect(version.stdout).toContain(DECANT_VERSION);

    let streamed = "";
    const live = await runCli(["--version"], {
      liveOutput: true,
      writeStdout: (value) => {
        streamed += value;
      },
      writeStderr: () => {},
    });
    expect(live).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(streamed).toContain(DECANT_VERSION);
  });

  test("completion emits shell scripts and rejects unknown shells", async () => {
    const bash = await runCli(["completion", "bash"]);
    expect(bash).toMatchObject({ code: 0, stderr: "" });
    expect(bash.stdout).toContain("complete -F _decant_complete decant");
    expect(bash.stdout).toContain("watch");
    expect(bash.stdout).toContain("serve");
    expect(bash.stdout).toContain("tokens");
    expect(bash.stdout).toContain("distill");
    expect(bash.stdout).toContain("recommendations");

    const unknown = await runCli(["completion", "tcsh"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown completion shell");
  });

  test("watch and serve modes are discoverable", async () => {
    const watch = await runCli(["watch", "--help"]);
    expect(watch).toMatchObject({ code: 0, stderr: "" });
    expect(watch.stdout).toContain("keep the session log index current");
    expect(watch.stdout).toContain("--interval-ms");
    expect(watch.stdout).toContain("--no-fs-watch");
    expect(watch.stdout).not.toContain("--trusted-peer");

    const serve = await runCli(["serve", "--help"]);
    expect(serve).toMatchObject({ code: 0, stderr: "" });
    expect(serve.stdout.replace(/\s+/g, " ")).toContain("default when run with no arguments");
    expect(serve.stdout).toContain("--host");
    expect(serve.stdout).toContain("--port");
    expect(serve.stdout).toContain("--trusted-peer");
    expect(serve.stdout).toContain("(default: 3000)");
  });
});

describe("db info discloses what the archive stores", () => {
  interface InfoJson {
    size_bytes: number;
    sessions: number;
    messages: number;
    blocks: number;
    tool_calls: number;
    file_refs: number;
    freelist_bytes: number;
    fts_rows?: number;
    text_bytes?: number;
  }
  type FullInfoJson = InfoJson & { fts_rows: number; text_bytes: number };

  /** Bulky enough that removing it actually frees whole SQLite pages. */
  function seedBulkySession(dbPath: string): number {
    const db = openDb(dbPath);
    try {
      const sessionId = Number(
        db
          .query(
            `INSERT INTO session (tool, source_session_id, source_path)
             VALUES ('claude_code', 'bulky', '/home/u/.claude/projects/p/bulky.jsonl')`,
          )
          .run().lastInsertRowid,
      );
      db.exec("BEGIN IMMEDIATE;");
      const insertMessage = db.prepare(
        "INSERT INTO message (session_id, seq, role, raw) VALUES (?1, ?2, 'assistant', ?3)",
      );
      const insertBlock = db.prepare(
        `INSERT INTO block (message_id, session_id, ordinal, type, text, tool_name, tool_input)
         VALUES (?1, ?2, 0, 'tool_use', ?3, 'Read', ?4)`,
      );
      for (let seq = 0; seq < 200; seq += 1) {
        const messageId = Number(
          insertMessage.run(sessionId, seq, `{"canary":"${"r".repeat(2_000)}"}`).lastInsertRowid,
        );
        insertBlock.run(messageId, sessionId, "t".repeat(2_000), `{"file_path":"${seq}"}`);
      }
      insertMessage.finalize();
      insertBlock.finalize();
      db.exec("COMMIT;");
      return sessionId;
    } finally {
      closeDb(db);
    }
  }

  test("reports blocks and file refs, and keeps the full-scan totals opt-in", async () => {
    const { dbPath } = await syncedCase();
    const base = ["--db", dbPath, "--json", "--no-sync"];

    const info = await runCli([...base, "db", "info"]);
    expect(info.code).toBe(0);
    const row = JSON.parse(info.stdout) as InfoJson;
    expect(row.blocks).toBeGreaterThan(0);
    expect(row.file_refs).toBeGreaterThan(0);
    expect(row.freelist_bytes).toBe(0);
    // A byte sum and an FTS row count are full scans; a multi-GB archive must
    // not pay for them just to read its path and schema version.
    expect(row.fts_rows).toBeUndefined();
    expect(row.text_bytes).toBeUndefined();

    const full = await runCli([...base, "db", "info", "--full"]);
    expect(full.code).toBe(0);
    const fullRow = JSON.parse(full.stdout) as FullInfoJson;
    expect(fullRow.fts_rows).toBe(row.blocks);
    expect(fullRow.text_bytes).toBeGreaterThan(0);
  });

  test("renders the new fields in the human table", async () => {
    const { dbPath } = await syncedCase();
    const info = await runCli(["--db", dbPath, "--no-sync", "db", "info", "--full"]);
    expect(info.code).toBe(0);
    expect(info.stdout).toContain("blocks:");
    expect(info.stdout).toContain("file_refs:");
    expect(info.stdout).toContain("freelist_bytes:");
    expect(info.stdout).toContain("fts_rows:");
    expect(info.stdout).toContain("text_bytes:");
  });

  test("an empty archive reports zeros rather than omitting the fields", async () => {
    const dbPath = join(workDir, "db-info-empty.db");
    const info = await runCli(["--db", dbPath, "--json", "--no-sync", "db", "info", "--full"]);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout)).toMatchObject({
      sessions: 0,
      messages: 0,
      blocks: 0,
      tool_calls: 0,
      file_refs: 0,
      fts_rows: 0,
      text_bytes: 0,
      freelist_bytes: 0,
    });
  });

  test("reports freed pages until the archive is vacuumed", async () => {
    const dbPath = join(workDir, "db-info-freelist.db");
    const sessionId = seedBulkySession(dbPath);
    const base = ["--db", dbPath, "--json", "--no-sync"];

    const before = JSON.parse(
      (await runCli([...base, "db", "info", "--full"])).stdout,
    ) as FullInfoJson;
    expect(before.freelist_bytes).toBe(0);

    const db = openDb(dbPath);
    expect(setSessionUserState(db, sessionId, "deleted")).toBe(true);
    closeDb(db);

    const afterDelete = JSON.parse(
      (await runCli([...base, "db", "info", "--full"])).stdout,
    ) as FullInfoJson;
    expect(afterDelete.text_bytes).toBeLessThan(before.text_bytes);
    // The rows are gone but their bytes are still in the file: this is the
    // number that tells a user a vacuum is owed.
    expect(afterDelete.freelist_bytes).toBeGreaterThan(0);

    expect((await runCli(["--db", dbPath, "--no-sync", "db", "vacuum"])).code).toBe(0);

    const afterVacuum = JSON.parse(
      (await runCli([...base, "db", "info", "--full"])).stdout,
    ) as FullInfoJson;
    expect(afterVacuum.freelist_bytes).toBe(0);
    expect(afterVacuum.size_bytes).toBeLessThan(afterDelete.size_bytes);
  });

  test("text_bytes counts bytes, not characters", async () => {
    const dbPath = join(workDir, "db-info-utf8.db");
    // SQLite's LENGTH() counts characters on a TEXT column. The field sits
    // directly under size_bytes, which is real bytes from statSync, so it has
    // to be measured the same way or the two disagree in the same output.
    const sample = "h\u00e9llo\u2192\ud83d\ude42";
    // Code points, not UTF-16 units: SQLite's LENGTH() counts characters, and
    // JS .length would count the emoji's surrogate pair twice.
    expect([...sample].length).toBe(7);
    expect(Buffer.byteLength(sample, "utf8")).toBe(13);

    const db = openDb(dbPath);
    const sessionId = Number(
      db.query("INSERT INTO session (tool, source_session_id) VALUES ('claude_code', 'utf8')").run()
        .lastInsertRowid,
    );
    const messageId = Number(
      db
        .query("INSERT INTO message (session_id, seq, role, raw) VALUES (?1, 0, 'user', ?2)")
        .run(sessionId, sample).lastInsertRowid,
    );
    // Every column the sum touches gets the multibyte sample. Leaving
    // tool_input and tool_result NULL would let COALESCE return 0 either way,
    // so reverting those two call sites to LENGTH() would go unnoticed --
    // and tool_result is the largest content column in a real archive.
    db.query(
      `INSERT INTO block (message_id, session_id, ordinal, type, text, tool_input, tool_result)
       VALUES (?1, ?2, 0, 'tool_use', ?3, ?3, ?3)`,
    ).run(messageId, sessionId, sample);
    closeDb(db);

    const info = JSON.parse(
      (await runCli(["--db", dbPath, "--json", "--no-sync", "db", "info", "--full"])).stdout,
    ) as FullInfoJson;
    // Four stored copies of the sample at 13 bytes each: message.raw, and
    // block.text / tool_input / tool_result.
    expect(info.text_bytes).toBe(52);
  });
});

describe("session rm", () => {
  function seedTree(dbPath: string): { rootId: number; childId: number } {
    const db = openDb(dbPath);
    try {
      const insertSession = (sourceSessionId: string, parentId: number | null): number =>
        Number(
          db
            .query(
              `INSERT INTO session (tool, source_session_id, source_path, parent_session_id)
               VALUES ('claude_code', ?1, ?2, ?3)`,
            )
            .run(sourceSessionId, `/home/u/.claude/projects/p/${sourceSessionId}.jsonl`, parentId)
            .lastInsertRowid,
        );
      const addBlock = (sessionId: number, canary: string): void => {
        const messageId = Number(
          db
            .query("INSERT INTO message (session_id, seq, role, raw) VALUES (?1, 0, 'user', '{}')")
            .run(sessionId).lastInsertRowid,
        );
        db.query(
          `INSERT INTO block (message_id, session_id, ordinal, type, text)
           VALUES (?1, ?2, 0, 'text', ?3)`,
        ).run(messageId, sessionId, canary);
      };
      const rootId = insertSession("rm-root", null);
      addBlock(rootId, "ROOTCANARYTEXT");
      const childId = insertSession("rm-child", rootId);
      addBlock(childId, "CHILDCANARYTEXT");
      return { rootId, childId };
    } finally {
      closeDb(db);
    }
  }

  function ftsMatches(dbPath: string, needle: string): number {
    const db = openDb(dbPath);
    try {
      return (
        db.query("SELECT count(*) AS n FROM block_fts WHERE block_fts MATCH ?1").get(needle) as {
          n: number;
        }
      ).n;
    } finally {
      closeDb(db);
    }
  }

  test("deletes a session, its descendants, and their full-text entries", async () => {
    const dbPath = join(workDir, "session-rm.db");
    const { rootId } = seedTree(dbPath);
    expect(ftsMatches(dbPath, "ROOTCANARYTEXT")).toBe(1);
    expect(ftsMatches(dbPath, "CHILDCANARYTEXT")).toBe(1);

    const removed = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "session",
      "rm",
      String(rootId),
      "--yes",
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(`deleted session ${rootId} (1 descendant)`);
    // Deleted bytes may remain readable until a vacuum, so the hint is part of
    // the contract, not a nicety.
    expect(removed.stdout).toContain("decant db vacuum");

    expect(ftsMatches(dbPath, "ROOTCANARYTEXT")).toBe(0);
    expect(ftsMatches(dbPath, "CHILDCANARYTEXT")).toBe(0);
    const db = openDb(dbPath);
    expect(db.query("SELECT count(*) AS n FROM session").get()).toMatchObject({ n: 0 });
    closeDb(db);
  });

  test("refuses an unknown id with a non-zero exit", async () => {
    const dbPath = join(workDir, "session-rm-missing.db");
    seedTree(dbPath);
    const removed = await runCli(["--db", dbPath, "--no-sync", "session", "rm", "4242"]);
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("no session with id 4242");
    expect(removed.stdout).toBe("");
    const db = openDb(dbPath);
    expect(db.query("SELECT count(*) AS n FROM session").get()).toMatchObject({ n: 2 });
    closeDb(db);
  });

  test("--json reports what it deleted", async () => {
    const dbPath = join(workDir, "session-rm-json.db");
    const { rootId } = seedTree(dbPath);
    const removed = await runCli([
      "--db",
      dbPath,
      "--json",
      "--no-sync",
      "session",
      "rm",
      String(rootId),
      "--yes",
    ]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      deleted: true,
      session_id: rootId,
      descendants: 1,
    });
  });

  test("--json reports a miss without deleting anything", async () => {
    const dbPath = join(workDir, "session-rm-json-missing.db");
    seedTree(dbPath);
    const removed = await runCli(["--db", dbPath, "--json", "--no-sync", "session", "rm", "4242"]);
    expect(removed.code).toBe(1);
    expect(JSON.parse(removed.stdout)).toMatchObject({ deleted: false, session_id: 4242 });
  });

  function seedLoneSession(dbPath: string): number {
    const db = openDb(dbPath);
    try {
      return Number(
        db
          .query("INSERT INTO session (tool, source_session_id) VALUES ('claude_code', 'lone')")
          .run().lastInsertRowid,
      );
    } finally {
      closeDb(db);
    }
  }

  function sessionCount(dbPath: string): number {
    const db = openDb(dbPath);
    try {
      return (db.query("SELECT count(*) AS n FROM session").get() as { n: number }).n;
    } finally {
      closeDb(db);
    }
  }

  test("refuses a tree delete without --yes and mutates nothing", async () => {
    const dbPath = join(workDir, "session-rm-guard.db");
    const { rootId } = seedTree(dbPath);

    const refused = await runCli(["--db", dbPath, "--no-sync", "session", "rm", String(rootId)]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("1 descendant");
    expect(refused.stderr).toContain("--yes");
    expect(refused.stdout).toBe("");

    // There is no un-delete, so a refused guard has to leave the archive
    // byte-for-byte as it found it.
    expect(sessionCount(dbPath)).toBe(2);
    expect(ftsMatches(dbPath, "ROOTCANARYTEXT")).toBe(1);
    expect(ftsMatches(dbPath, "CHILDCANARYTEXT")).toBe(1);
  });

  test("a session with no descendants does not need --yes", async () => {
    const dbPath = join(workDir, "session-rm-lone.db");
    const id = seedLoneSession(dbPath);

    const removed = await runCli(["--db", dbPath, "--no-sync", "session", "rm", String(id)]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(`deleted session ${id} (0 descendants)`);
    expect(sessionCount(dbPath)).toBe(0);
  });

  test("--dry-run reports the blast radius and mutates nothing", async () => {
    const dbPath = join(workDir, "session-rm-dry.db");
    const { rootId } = seedTree(dbPath);

    const dry = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "session",
      "rm",
      String(rootId),
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`would delete session ${rootId} (1 descendant)`);
    expect(sessionCount(dbPath)).toBe(2);
    expect(ftsMatches(dbPath, "CHILDCANARYTEXT")).toBe(1);
  });

  test("--dry-run wins over --yes", async () => {
    const dbPath = join(workDir, "session-rm-dry-yes.db");
    const { rootId } = seedTree(dbPath);

    const dry = await runCli([
      "--db",
      dbPath,
      "--no-sync",
      "session",
      "rm",
      String(rootId),
      "--yes",
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(sessionCount(dbPath)).toBe(2);
  });

  test("--json marks a dry run and still deletes nothing", async () => {
    const dbPath = join(workDir, "session-rm-dry-json.db");
    const { rootId } = seedTree(dbPath);

    const dry = await runCli([
      "--db",
      dbPath,
      "--json",
      "--no-sync",
      "session",
      "rm",
      String(rootId),
      "--dry-run",
    ]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      deleted: false,
      dry_run: true,
      session_id: rootId,
      descendants: 1,
    });
    expect(sessionCount(dbPath)).toBe(2);
  });

  test("--json reports a refused guard", async () => {
    const dbPath = join(workDir, "session-rm-guard-json.db");
    const { rootId } = seedTree(dbPath);

    const refused = await runCli([
      "--db",
      dbPath,
      "--json",
      "--no-sync",
      "session",
      "rm",
      String(rootId),
    ]);
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      deleted: false,
      session_id: rootId,
      descendants: 1,
    });
    expect(sessionCount(dbPath)).toBe(2);
  });

  test("--dry-run still reports an unknown id as a miss", async () => {
    const dbPath = join(workDir, "session-rm-dry-missing.db");
    seedTree(dbPath);
    const dry = await runCli(["--db", dbPath, "--no-sync", "session", "rm", "4242", "--dry-run"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("no session with id 4242");
  });

  test("is offered by shell completion", async () => {
    // A bare substring check passes on "--format"; match whole words only.
    const fish = await runCli(["completion", "fish"]);
    expect(fish.code).toBe(0);
    expect(fish.stdout).toContain("complete -c decant -f -a 'rm'");
    const zsh = await runCli(["completion", "zsh"]);
    expect(zsh.code).toBe(0);
    expect(zsh.stdout).toMatch(/\brm\b/);
  });
});
