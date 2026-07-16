import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshCase(): { dbPath: string; claudeDir: string; codexDir: string } {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(dir, "sources", "claude");
  const codexDir = join(dir, "sources", "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  for (const name of ["distill.jsonl", "enriched.jsonl", "mcp.jsonl", "sample.jsonl"]) {
    copyFileSync(join(import.meta.dir, "..", "fixtures", "claude", name), join(claudeDir, name));
  }
  for (const name of ["distill.jsonl", "enriched.jsonl", "sample.jsonl"]) {
    copyFileSync(
      join(import.meta.dir, "..", "fixtures", "codex", name),
      join(codexDir, "sessions", `rollout-${name}`),
    );
  }
  return { dbPath: join(dir, "archive.db"), claudeDir, codexDir };
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
  ]);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toMatchObject({ scanned: 7, ingested: 7, issues: 0 });
  return { dbPath: fixtureCase.dbPath };
}

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
      schema_version: 9,
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
      totals: expect.objectContaining({ active_ms: expect.any(Number) }),
    });

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
    expect(JSON.parse(result.stdout)).toMatchObject({ scanned: 2, ingested: 2, issues: 0 });

    const list = await runCli(["--db", fixtureCase.dbPath, "--json", "--no-sync", "ls"]);
    expect(list.code).toBe(0);
    expect(
      (JSON.parse(list.stdout) as { source_session_id: string }[]).map(
        (session) => session.source_session_id,
      ),
    ).toEqual(["sess-codex-1", "claude-one"]);
  });

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
    expect(version.stdout).toContain("0.1.0");

    let streamed = "";
    const live = await runCli(["--version"], {
      liveOutput: true,
      writeStdout: (value) => {
        streamed += value;
      },
      writeStderr: () => {},
    });
    expect(live).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(streamed).toContain("0.1.0");
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
    expect(watch.stdout).toContain("keep the archive current");
    expect(watch.stdout).toContain("--interval-ms");
    expect(watch.stdout).toContain("--no-fs-watch");

    const serve = await runCli(["serve", "--help"]);
    expect(serve).toMatchObject({ code: 0, stderr: "" });
    expect(serve.stdout).toContain("in-process web UI");
    expect(serve.stdout).toContain("--host");
    expect(serve.stdout).toContain("--port");
    expect(serve.stdout).toContain("(default: 3000)");
  });
});
