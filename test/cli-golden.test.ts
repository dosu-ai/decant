import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripGoldenVolatility } from "../scripts/golden-normalize.ts";
import { runCli } from "../src/cli.ts";
import { compareCodePoints } from "../src/order.ts";
import { DECANT_VERSION } from "../src/version.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-golden-test-"));
const goldenDir = join(import.meta.dir, "golden");

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function fixtureFiles(tool: string): string[] {
  return readdirSync(join(import.meta.dir, "..", "fixtures", tool))
    .filter((file) => file.endsWith(".jsonl"))
    .sort();
}

function stageFixtures(caseDir: string): { claudeDir: string; codexDir: string } {
  const claudeDir = join(caseDir, "sources", "claude");
  const codexDir = join(caseDir, "sources", "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  for (const file of fixtureFiles("claude")) {
    copyFileSync(join(import.meta.dir, "..", "fixtures", "claude", file), join(claudeDir, file));
  }
  for (const file of fixtureFiles("codex")) {
    copyFileSync(
      join(import.meta.dir, "..", "fixtures", "codex", file),
      join(codexDir, "sessions", `rollout-${file}`),
    );
  }
  return { claudeDir, codexDir };
}

function normalizeCliGolden(name: string, value: unknown): unknown {
  const normalized = stripGoldenVolatility(value, DECANT_VERSION);
  if (name !== "ls" || !Array.isArray(normalized)) {
    return normalized;
  }
  return [...normalized].sort((left, right) => {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return (
      compareCodePoints(String(b.started_at ?? ""), String(a.started_at ?? "")) ||
      compareCodePoints(String(a.tool ?? ""), String(b.tool ?? "")) ||
      compareCodePoints(String(a.source_session_id ?? ""), String(b.source_session_id ?? ""))
    );
  });
}

function argsForTs(dbPath: string, command: string[]): string[] {
  const args = ["--db", dbPath, "--no-sync"];
  const rest: string[] = [];
  for (const arg of command) {
    if (arg === "--json") {
      args.push("--json");
    } else {
      rest.push(arg);
    }
  }
  return [...args, ...rest];
}

describe("CLI golden parity", () => {
  test("normalization replaces only the version field and stabilizes session hrefs", () => {
    expect(
      stripGoldenVolatility(
        {
          version: "dev",
          generated_with: "dev",
          project: "/Users/dev/proj",
          href: "/sessions/123#message-4",
          artifact: "Distilled by Decant dev from /Users/dev/proj",
        },
        "dev",
      ),
    ).toEqual({
      version: "0.0.0-dev",
      generated_with: "0.0.0-dev",
      project: "/Users/dev/proj",
      href: "/sessions/<ID>#message-4",
      artifact: "Distilled by Decant 0.0.0-dev from /Users/dev/proj",
    });
  });

  test("read commands match frozen JSON snapshots", async () => {
    const caseDir = join(workDir, "case");
    const { claudeDir, codexDir } = stageFixtures(caseDir);
    const dbPath = join(caseDir, "archive.db");
    const sync = await runCli([
      "--db",
      dbPath,
      "--json",
      "sync",
      "--claude-dir",
      claudeDir,
      "--codex-dir",
      codexDir,
    ]);
    expect(sync).toMatchObject({ code: 0, stderr: "" });

    const meta = (await Bun.file(join(goldenDir, "meta.json")).json()) as {
      cli_commands: Record<string, string[]>;
    };
    for (const [name, command] of Object.entries(meta.cli_commands)) {
      const result = await runCli(argsForTs(dbPath, command));
      expect(result.code, `${name} exited nonzero: ${result.stderr}`).toBe(0);
      const actual = normalizeCliGolden(name, JSON.parse(result.stdout));
      const expected = await Bun.file(join(goldenDir, "cli", `${name}.json`)).json();
      expect(actual, name).toEqual(expected);
    }
  });
});
