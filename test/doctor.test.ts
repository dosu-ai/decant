import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { LATEST_SCHEMA_VERSION } from "../src/db.ts";
import { CUSTOM_PATH, collectDoctorReport, displayPath } from "../src/doctor.ts";
import type { SourceFile } from "../src/ingest.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-doctor-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let homeCount = 0;
function freshHome(): { home: string; env: Record<string, string> } {
  homeCount += 1;
  const home = join(workDir, `home-${homeCount}`);
  mkdirSync(home, { recursive: true });
  return {
    home,
    env: { DECANT_CONFIG_DIR: join(home, ".config", "decant"), DECANT_NO_SYNC: "1" },
  };
}

const install = { channel: "source" as const, binaryPath: null };

describe("displayPath", () => {
  test("shows home-relative paths and hides everything else", () => {
    expect(displayPath("/home/al", "/home/al")).toBe("~");
    expect(displayPath("/home/al/.codex", "/home/al")).toBe("~/.codex");
    expect(displayPath("/home/al/", "/home/al/")).toBe("~");
    expect(displayPath("/home/alice/.codex", "/home/al")).toBe(CUSTOM_PATH);
    expect(displayPath("/data/sessions", "/home/al")).toBe(CUSTOM_PATH);
    expect(displayPath("/anything", "")).toBe(CUSTOM_PATH);
  });
});

describe("collectDoctorReport", () => {
  test("counts discovered sources per tool and names env vars without values", () => {
    const { home, env } = freshHome();
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const files: SourceFile[] = [
      { tool: "claude_code", path: join(home, ".claude", "projects", "a.jsonl"), archived: false },
      { tool: "claude_code", path: join(home, ".claude", "projects", "b.jsonl"), archived: false },
    ];
    const report = collectDoctorReport(resolveConfig({ env, homeDir: home }), {
      env: { ...env, UNRELATED_TOKEN: "do-not-print", XDG_DATA_HOME: join(home, "data") },
      homeDir: home,
      install,
      discover: () => files,
    });

    const claude = report.sources.find((source) => source.tool === "claude_code");
    expect(claude).toEqual({
      tool: "claude_code",
      roots: ["~/.claude/projects"],
      exists: true,
      found: 2,
    });
    expect(report.sources.find((source) => source.tool === "codex")).toMatchObject({
      exists: false,
      found: 0,
    });
    expect(report.sources.map((source) => source.tool)).toEqual([
      "claude_code",
      "codex",
      "gemini",
      "opencode",
      "cursor",
    ]);
    expect(report.archive).toMatchObject({ path: "~/.decant/decant.db", exists: false });
    expect(report.env).toEqual(["DECANT_CONFIG_DIR", "DECANT_NO_SYNC", "XDG_DATA_HOME"]);
    expect(report.supported_schema_version).toBe(LATEST_SCHEMA_VERSION);
    expect(JSON.stringify(report)).not.toContain(home);
    expect(JSON.stringify(report)).not.toContain("do-not-print");
  });

  test("keeps only the error name when discovery or the archive fails", () => {
    const { home, env } = freshHome();
    const dbPath = join(home, ".decant", "decant.db");
    mkdirSync(join(home, ".decant"), { recursive: true });
    writeFileSync(dbPath, "this is not a sqlite database, it is a long enough header to fail");
    const report = collectDoctorReport(resolveConfig({ env, homeDir: home }), {
      env,
      homeDir: home,
      install,
      discover: () => {
        throw new Error(`EACCES: permission denied, scandir '${home}/private-project'`);
      },
    });

    expect(report.discovery_error).toBe("Error");
    expect(report.archive.exists).toBe(true);
    expect(report.archive.error).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain("private-project");
  });
});

describe("decant doctor", () => {
  test("reads an archive without migrating it and prints no transcript content", async () => {
    const { home, env } = freshHome();
    const dbPath = join(home, ".decant", "decant.db");
    const fixture = join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl");
    const synced = await runCli(["--db", dbPath, "sync", "--path", fixture], {
      env,
      homeDir: home,
    });
    expect(synced.code).toBe(0);

    const json = await runCli(["--db", dbPath, "--json", "doctor"], {
      env,
      homeDir: home,
      update: { install },
    });
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.archive.path).toBe("~/.decant/decant.db");
    expect(report.archive.schema_version).toBe(LATEST_SCHEMA_VERSION);
    expect(report.archive.sessions.claude_code).toBeGreaterThan(0);
    expect(report.install_channel).toBe("source");

    const human = await runCli(["--db", dbPath, "doctor"], {
      env,
      homeDir: home,
      update: { install },
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`supported v${LATEST_SCHEMA_VERSION}`);
    expect(human.stdout).toContain("claude_code");
    expect(human.stdout).toContain("No transcript content is included.");
    expect(human.stdout).not.toContain(home);
  });
});
