import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFrozenMigrations, runPolicy } from "../scripts/pr-policy.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-pr-policy-reads-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function migrations(versions: number[]): string {
  return [
    `export const LATEST_SCHEMA_VERSION = ${Math.max(...versions)};`,
    "function migrate(db, current) {",
    ...versions.flatMap((version) => [
      `    if (current < ${version}) {`,
      `      db.exec("CREATE TABLE t${version} (x)");`,
      "    }",
    ]),
    "}",
    "",
  ].join("\n");
}

describe("checkFrozenMigrations without a support guard", () => {
  test("treats every committed migration as required", () => {
    const findings = checkFrozenMigrations(migrations([1, 2]), migrations([2]));
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining("migration 1 is missing"),
    ]);
  });
});

describe("runPolicy fixture reads", () => {
  function fixtureRepo(name: string): string {
    const repo = join(workDir, name);
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    writeFileSync(join(repo, "fixtures", "gone.jsonl"), '{"cwd":"/Users/dev/p"}\n');
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
    return repo;
  }

  test("skips a tracked fixture deleted in the working tree", () => {
    const repo = fixtureRepo("deleted");
    rmSync(join(repo, "fixtures", "gone.jsonl"));
    expect(runPolicy({ root: repo, base: "main", labels: new Set() })).toEqual([]);
  });
});
