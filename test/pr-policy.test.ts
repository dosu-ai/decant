import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDocs,
  checkFrozenMigrations,
  DOCS_OVERRIDE_LABEL,
  extractMigrations,
  runPolicy,
  scanForPrivateData,
} from "../scripts/pr-policy.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-pr-policy-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function dbSource(latest: number, blocks: Record<number, string>): string {
  const body = Object.entries(blocks)
    .map(([version, sql]) =>
      [`    if (current < ${version}) {`, `      db.exec("${sql}");`, "    }"].join("\n"),
    )
    .join("\n");
  return [
    `export const LATEST_SCHEMA_VERSION = ${latest};`,
    "function migrate(db, current) {",
    body,
    "}",
    "",
  ].join("\n");
}

const base = dbSource(3, {
  1: "CREATE TABLE a (x)",
  2: "ALTER TABLE a ADD y",
  3: "CREATE INDEX i",
});

describe("frozen migrations", () => {
  test("extracts each version's block", () => {
    expect([...extractMigrations(base).keys()]).toEqual([1, 2, 3]);
  });

  test("allows a new migration", () => {
    const head = dbSource(4, {
      1: "CREATE TABLE a (x)",
      2: "ALTER TABLE a ADD y",
      3: "CREATE INDEX i",
      4: "ALTER TABLE a ADD z",
    });
    expect(checkFrozenMigrations(base, head)).toEqual([]);
  });

  test("rejects an edit to a committed migration", () => {
    const head = dbSource(3, {
      1: "CREATE TABLE a (x)",
      2: "ALTER TABLE a ADD w",
      3: "CREATE INDEX i",
    });
    const findings = checkFrozenMigrations(base, head);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("migration 2");
  });

  test("ignores comment-only and whitespace changes", () => {
    const head = base.replace(
      "    if (current < 2) {\n",
      "    if (current < 2) {\n      // Explain why y exists.\n\n",
    );
    expect(checkFrozenMigrations(base, head)).toEqual([]);
  });

  test("allows dropping the oldest versions but not a middle one", () => {
    const dropOldest = dbSource(3, { 2: "ALTER TABLE a ADD y", 3: "CREATE INDEX i" });
    expect(checkFrozenMigrations(base, dropOldest)).toEqual([]);
    const dropMiddle = dbSource(3, { 1: "CREATE TABLE a (x)", 3: "CREATE INDEX i" });
    expect(checkFrozenMigrations(base, dropMiddle)[0]?.message).toContain(
      "migration 2 was removed",
    );
  });

  test("rejects an oldest migration whose opening line no longer parses", () => {
    const head = base
      .replace("    if (current < 1) {", "    if (current < 1) { // first")
      .replace("CREATE TABLE a (x)", "DROP TABLE session");
    expect(checkFrozenMigrations(base, head)[0]?.message).toContain(
      "migration 1 no longer matches",
    );
  });

  test("rejects an oldest migration whose condition was rewritten", () => {
    for (const opening of ["    if (current <= 1) {", "    if (1 > current) {"]) {
      const head = base.replace("    if (current < 1) {", opening);
      expect(checkFrozenMigrations(base, head)[0]?.message).toContain(
        "migration 1 no longer matches",
      );
    }
  });

  test("rejects a lower LATEST_SCHEMA_VERSION and a restructured migrate()", () => {
    expect(checkFrozenMigrations(base, base.replace("= 3;", "= 2;"))[0]?.message).toContain(
      "went down",
    );
    expect(
      checkFrozenMigrations(base, "export const LATEST_SCHEMA_VERSION = 3;\n")[0]?.message,
    ).toContain("no `if (current < N) {` migration blocks");
  });
});

function diffOf(added: string[], removed: string[] = []): string {
  return ["--- a/x", "+++ b/x", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join(
    "\n",
  );
}

describe("docs rules", () => {
  test("a rate change needs docs/pricing.md", () => {
    const changed = [
      { path: "src/cost.ts", diff: diffOf([`  ["glm-6", openAiPrice(1, 0.2, 3)],`]) },
    ];
    expect(checkDocs(changed, new Set())[0]?.message).toContain("docs/pricing.md");
    expect(checkDocs([...changed, { path: "docs/pricing.md", diff: "" }], new Set())).toEqual([]);
  });

  test("an object-literal rate counts as a rate change", () => {
    const changed = [{ path: "src/cost.ts", diff: diffOf(["      inputPerMtok: 2,"]) }];
    expect(checkDocs(changed, new Set())).toHaveLength(1);
  });

  test("a refactor of cost.ts does not need docs", () => {
    const changed = [
      {
        path: "src/cost.ts",
        diff: diffOf(["  const table = buildOnce();"], ["  const t = build();"]),
      },
    ];
    expect(checkDocs(changed, new Set())).toEqual([]);
  });

  test("the route manifest needs both API docs", () => {
    const changed = [
      { path: "src/route-paths.ts", diff: diffOf(['  health: "/api/health",']) },
      { path: "docs/api/openapi.yaml", diff: "" },
    ];
    const findings = checkDocs(changed, new Set());
    expect(findings[0]?.message).toContain("docs/api/routes.md");
    expect(findings[0]?.message).not.toContain("openapi.yaml and");
  });

  test("deleting a required doc does not satisfy the rule", () => {
    const changed = [
      { path: "src/route-paths.ts", diff: diffOf(['  health: "/api/health",']) },
      { path: "docs/api/openapi.yaml", diff: "", deleted: true },
      { path: "docs/api/routes.md", diff: "", deleted: true },
    ];
    expect(checkDocs(changed, new Set())[0]?.message).toContain("docs/api/openapi.yaml");
  });

  test("the override label skips the docs rules", () => {
    const changed = [{ path: "src/route-paths.ts", diff: "" }];
    expect(checkDocs(changed, new Set([DOCS_OVERRIDE_LABEL]))).toEqual([]);
  });
});

// Assembled at runtime so the repository never holds a credential-shaped
// literal that secret scanning would flag.
const fakeGithubToken = `gh${"p_"}${"Z".repeat(36)}`;
const fakeAwsKey = `AK${"IA"}${"Q".repeat(16)}`;

describe("private data scan", () => {
  test("accepts the synthetic placeholders fixtures use", () => {
    const content = [
      '{"cwd":"/Users/dev/project","home":"/home/dev"}',
      '{"author":"Ada <ada@example.com>"}',
      "gh auth login --with-token=ghp_AAAAitsasecrettoken0000000000000000",
    ].join("\n");
    expect(scanForPrivateData("fixtures/claude/x.jsonl", content)).toEqual([]);
  });

  test("flags real-looking home directories on macOS, Linux, and Windows", () => {
    for (const path of ["/Users/janedoe/src", "/home/jdoe/src", "C:\\\\Users\\\\jdoe\\\\src"]) {
      const findings = scanForPrivateData("fixtures/x.jsonl", `{"cwd":"${path}"}`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe("private-data");
    }
  });

  test("still scans a fixture that contains a NUL byte", () => {
    const findings = scanForPrivateData("fixtures/x.jsonl", '{"cwd":"/home/jdoe/src"}\0\n');
    expect(findings).toHaveLength(1);
  });

  test("flags emails and credentials without repeating the secret", () => {
    const content = `jane@company.io ${fakeGithubToken} ${fakeAwsKey} ${fakeGithubToken}`;
    const findings = scanForPrivateData("test/golden/rows/x.json", content);
    expect(findings.map((finding) => finding.message)).toEqual([
      "email address at a real-looking domain. Use an example.com address.",
      "GitHub token-shaped string. Fixtures must not hold credentials, even revoked ones.",
      "AWS access key-shaped string. Fixtures must not hold credentials, even revoked ones.",
    ]);
    expect(JSON.stringify(findings)).not.toContain(fakeGithubToken);
  });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

describe("runPolicy", () => {
  test("checks committed, uncommitted, and untracked changes against the merge base", () => {
    const repo = join(workDir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "fixtures"), { recursive: true });
    writeFileSync(join(repo, "src", "db.ts"), base);
    writeFileSync(join(repo, "fixtures", "ok.jsonl"), '{"cwd":"/Users/dev/p"}\n');
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
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

    expect(runPolicy({ root: repo, base: "main", labels: new Set() })).toEqual([]);

    writeFileSync(join(repo, "src", "db.ts"), base.replace("ADD y", "ADD w"));
    writeFileSync(join(repo, "fixtures", "new.jsonl"), '{"cwd":"/home/realperson/p"}\n');
    const findings = runPolicy({ root: repo, base: "main", labels: new Set() });
    expect(findings.map((finding) => `${finding.rule} ${finding.file}`)).toEqual([
      "frozen-migration src/db.ts",
      "private-data fixtures/new.jsonl",
    ]);
  });
});
