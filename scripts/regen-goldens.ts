import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import { type IngestConfig, sync } from "../src/ingest.ts";
import { compareCodePoints } from "../src/order.ts";
import { DECANT_VERSION } from "../src/version.ts";
import { ROW_QUERIES } from "../test/golden-rows.ts";
import { stripGoldenVolatility } from "./golden-normalize.ts";

const reviewFlag = "--i-reviewed-the-diff";
const repoRoot = join(import.meta.dir, "..");
const goldenDir = join(repoRoot, "test", "golden");

type GoldenMeta = {
  fixtures: string[];
  row_dumps: (keyof typeof ROW_QUERIES)[];
  cli_commands: Record<string, string[]>;
};

function requireReviewedDiff(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== reviewFlag) {
    throw new Error(
      `Refusing to rewrite frozen goldens. Review the generated diff, then rerun: bun scripts/regen-goldens.ts ${reviewFlag}`,
    );
  }
}

function stageFixtures(caseDir: string, fixtures: string[]): IngestConfig {
  const claudeDir = join(caseDir, "sources", "claude");
  const codexDir = join(caseDir, "sources", "codex");
  const cursorDir = join(caseDir, "sources", "cursor");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  for (const fixture of fixtures) {
    const source = join(repoRoot, fixture);
    const name = basename(source);
    if (fixture.startsWith("fixtures/claude/")) copyFileSync(source, join(claudeDir, name));
    else if (fixture.startsWith("fixtures/codex/")) {
      copyFileSync(source, join(codexDir, "sessions", `rollout-${name}`));
    } else if (fixture.startsWith("fixtures/cursor/")) {
      const chatDir = join(cursorDir, "synthetic-workspace", "sample");
      mkdirSync(chatDir, { recursive: true });
      copyFileSync(source, join(chatDir, "store.db"));
      copyFileSync(join(dirname(source), "meta.json"), join(chatDir, "meta.json"));
    } else {
      throw new Error(`Unsupported golden fixture path: ${fixture}`);
    }
  }
  return { claudeDir, codexDir, cursorDir };
}

function canonicalizeRows(value: unknown, caseDir: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(caseDir, "<TMP>")) as unknown;
}

function normalizeCliGolden(name: string, value: unknown): unknown {
  const normalized = stripGoldenVolatility(value, DECANT_VERSION);
  if (name !== "ls" || !Array.isArray(normalized)) return normalized;
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

function cliArgs(dbPath: string, command: string[]): string[] {
  const args = ["--db", dbPath, "--no-sync"];
  const rest: string[] = [];
  for (const arg of command) {
    if (arg === "--json") args.push("--json");
    else rest.push(arg);
  }
  return [...args, ...rest];
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function regenerate(): Promise<void> {
  requireReviewedDiff();
  const meta = (await Bun.file(join(goldenDir, "meta.json")).json()) as GoldenMeta;
  const caseDir = mkdtempSync(join(tmpdir(), "decant-regen-goldens-"));
  const dbPath = join(caseDir, "archive.db");
  try {
    const db = openDb(dbPath);
    try {
      const report = sync(db, stageFixtures(caseDir, meta.fixtures));
      if (report.failed !== 0 || report.issues !== 0) {
        throw new Error(`Golden fixture sync was not clean: ${JSON.stringify(report)}`);
      }
      for (const name of meta.row_dumps) {
        const sql = ROW_QUERIES[name];
        if (sql == null) throw new Error(`Unknown row dump in meta.json: ${name}`);
        writeJson(
          join(goldenDir, "rows", `${name}.json`),
          canonicalizeRows(db.query(sql).all(), caseDir),
        );
      }
    } finally {
      closeDb(db);
    }

    for (const [name, command] of Object.entries(meta.cli_commands)) {
      const result = await runCli(cliArgs(dbPath, command));
      if (result.code !== 0) throw new Error(`${name} failed: ${result.stderr}`);
      writeJson(
        join(goldenDir, "cli", `${name}.json`),
        normalizeCliGolden(name, JSON.parse(result.stdout)),
      );
    }
  } finally {
    rmSync(caseDir, { recursive: true, force: true });
  }
}

await regenerate();
