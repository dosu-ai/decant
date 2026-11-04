import { Database } from "bun:sqlite";
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
    expect(displayPath("/home/dev", "/home/dev")).toBe("~");
    expect(displayPath("/home/dev/.codex", "/home/dev")).toBe("~/.codex");
    expect(displayPath("/home/dev/", "/home/dev/")).toBe("~");
    // A sibling that shares the home directory's name as a prefix is outside it.
    expect(displayPath("/home/dev/workspace/.codex", "/home/dev/work")).toBe(CUSTOM_PATH);
    expect(displayPath("/data/sessions", "/home/dev")).toBe(CUSTOM_PATH);
    expect(displayPath("/anything", "")).toBe(CUSTOM_PATH);
    expect(displayPath("/anything", "/")).toBe(CUSTOM_PATH);
  });

  test("resolves dot segments before deciding a path is under home", () => {
    expect(displayPath("/home/dev/../client/archive.db", "/home/dev")).toBe(CUSTOM_PATH);
    expect(displayPath("/home/dev/./a/../.decant/decant.db", "/home/dev")).toBe(
      "~/.decant/decant.db",
    );
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
      "copilot",
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
    expect(report.discovery_warnings).toEqual([]);
    expect(report.archive.exists).toBe(true);
    expect(report.archive.error).not.toBeNull();
    expect(JSON.stringify(report)).not.toContain("private-project");
  });

  test("reports a non-integer schema version as unreadable without printing it", () => {
    const { home, env } = freshHome();
    const dbPath = join(home, ".decant", "decant.db");
    mkdirSync(join(home, ".decant"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("CREATE TABLE schema_migrations (version INTEGER)");
    db.query("INSERT INTO schema_migrations VALUES (?)").run("/private/customer/secret.db");
    db.close();
    const report = collectDoctorReport(resolveConfig({ env, homeDir: home }), {
      env,
      homeDir: home,
      install,
      discover: () => [],
    });

    expect(report.archive.schema_version).toBeNull();
    expect(report.archive.error).toBe("unreadable schema_migrations");
    expect(JSON.stringify(report)).not.toContain("secret.db");
  });

  test("keeps only the event name of a discovery warning", () => {
    const { home, env } = freshHome();
    const report = collectDoctorReport(resolveConfig({ env, homeDir: home }), {
      env,
      homeDir: home,
      install,
      discover: (_config, warn) => {
        warn?.("OpenCode database could not be opened.", {
          "event.name": "decant.ingest.opencode_open_failed",
          "file.path": join(home, "private-project", "opencode.db"),
          "error.message": "unable to open database file",
        });
        warn?.("Unnamed warning.", {});
        return [];
      },
    });

    expect(report.discovery_warnings).toEqual([
      "decant.ingest.opencode_open_failed",
      "unknown warning",
    ]);
    expect(JSON.stringify(report)).not.toContain("private-project");
    expect(JSON.stringify(report)).not.toContain("unable to open");
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
