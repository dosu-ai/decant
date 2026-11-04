// Checks AGENTS.md rules against the merge base with --base (default
// origin/main): frozen migrations, docs for pricing and routes, and synthetic
// fixtures. Usage: bun run scripts/pr-policy.ts [--base <ref>]
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DOCS_OVERRIDE_LABEL = "docs-not-needed";

export interface Finding {
  rule: "frozen-migration" | "docs" | "private-data";
  file: string;
  message: string;
}

export interface ChangedFile {
  path: string;
  /** Unified diff of this file against the base; empty for deletions read elsewhere. */
  diff: string;
}

const MIGRATION_START = /^ {4}if \(current < (\d+)\) \{$/;
const MIGRATION_END = /^ {4}\}$/;
const LATEST_VERSION = /^export const LATEST_SCHEMA_VERSION = (\d+);$/m;

/**
 * Each `if (current < N) { ... }` block in migrate(), keyed by N, without
 * comments or trailing whitespace so rewording a comment is not a change.
 */
export function extractMigrations(source: string): Map<number, string> {
  const blocks = new Map<number, string>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const start = MIGRATION_START.exec(lines[i] ?? "");
    if (start == null) continue;
    const end = lines.findIndex((line, j) => j > i && MIGRATION_END.test(line));
    if (end === -1) break;
    const code = lines
      .slice(i, end + 1)
      .filter((line) => !line.trimStart().startsWith("//"))
      .map((line) => line.trimEnd())
      .filter((line) => line !== "");
    blocks.set(Number(start[1]), code.join("\n"));
    i = end;
  }
  return blocks;
}

export function latestSchemaVersion(source: string): number | null {
  const match = LATEST_VERSION.exec(source);
  return match == null ? null : Number(match[1]);
}

/**
 * Committed migrations may already have run on someone's archive. Dropping the
 * oldest versions is allowed; that is how old archives become rebuild-only.
 */
export function checkFrozenMigrations(baseSource: string, headSource: string): Finding[] {
  const file = "src/db.ts";
  const base = extractMigrations(baseSource);
  const head = extractMigrations(headSource);
  const findings: Finding[] = [];
  if (base.size > 0 && head.size === 0) {
    return [
      {
        rule: "frozen-migration",
        file,
        message:
          "no `if (current < N) {` migration blocks found. If migrate() was restructured, update extractMigrations in scripts/pr-policy.ts.",
      },
    ];
  }
  const oldestKept = Math.min(...head.keys());
  for (const [version, block] of base) {
    const current = head.get(version);
    if (current == null) {
      if (version > oldestKept) {
        findings.push({
          rule: "frozen-migration",
          file,
          message: `migration ${version} was removed while older migrations remain. Only the oldest versions may be dropped.`,
        });
      }
    } else if (current !== block) {
      findings.push({
        rule: "frozen-migration",
        file,
        message: `migration ${version} is already on the base branch and must not change. Put the adjustment in a new migration and bump LATEST_SCHEMA_VERSION.`,
      });
    }
  }
  const baseLatest = latestSchemaVersion(baseSource);
  const headLatest = latestSchemaVersion(headSource);
  if (baseLatest != null && headLatest != null && headLatest < baseLatest) {
    findings.push({
      rule: "frozen-migration",
      file,
      message: `LATEST_SCHEMA_VERSION went down from ${baseLatest} to ${headLatest}.`,
    });
  }
  return findings;
}

export interface DocRule {
  /** Why the docs matter, shown when the rule fires. */
  reason: string;
  triggeredBy(file: ChangedFile): boolean;
  docs: string[];
}

// Lines that set a rate. Other cost.ts changes do not affect docs/pricing.md.
const RATE_LINE = /\b(?:claude|openAi|gemini)Price\(|^\s*\[\s*"[^"]+",|\b\w*PerMtok\s*:/;

export function changedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    )
    .map((line) => line.slice(1));
}

export const DOC_RULES: DocRule[] = [
  {
    reason: "a model rate changed; docs/pricing.md lists every rate with a dated source",
    triggeredBy: (file) =>
      file.path === "src/cost.ts" && changedLines(file.diff).some((line) => RATE_LINE.test(line)),
    docs: ["docs/pricing.md"],
  },
  {
    reason: "the route manifest changed; the OpenAPI document and route guide are the API contract",
    triggeredBy: (file) => file.path === "src/route-paths.ts",
    docs: ["docs/api/openapi.yaml", "docs/api/routes.md"],
  },
];

export function checkDocs(
  changed: ChangedFile[],
  labels: ReadonlySet<string>,
  rules: DocRule[] = DOC_RULES,
): Finding[] {
  if (labels.has(DOCS_OVERRIDE_LABEL)) return [];
  const paths = new Set(changed.map((file) => file.path));
  const findings: Finding[] = [];
  for (const rule of rules) {
    const trigger = changed.find((file) => rule.triggeredBy(file));
    if (trigger == null) continue;
    const missing = rule.docs.filter((doc) => !paths.has(doc));
    if (missing.length > 0) {
      findings.push({
        rule: "docs",
        file: trigger.path,
        message: `${rule.reason}. Update ${missing.join(" and ")}, or add the ${DOCS_OVERRIDE_LABEL} label if nothing user-visible changed.`,
      });
    }
  }
  return findings;
}

export const PRIVATE_DATA_ROOTS = ["fixtures/", "test/golden/"];

// Placeholder home directories that fixtures use on purpose.
const SYNTHETIC_HOMES = new Set(["dev", "user", "example", "test", "runner"]);
// Fake credentials that redaction tests depend on.
const SYNTHETIC_SECRETS = new Set(["ghp_AAAAitsasecrettoken0000000000000000"]);
const SYNTHETIC_EMAIL_DOMAINS =
  /@(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|example))$/i;

const HOME_PATH = /(?:\/(?:Users|home)\/|[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SECRETS: [string, RegExp][] = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI API key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ["GitHub token", /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

export function scanForPrivateData(path: string, content: string): Finding[] {
  if (content.includes("\0")) return [];
  const findings: Finding[] = [];
  const report = (message: string): void => {
    findings.push({ rule: "private-data", file: path, message });
  };
  for (const match of content.matchAll(HOME_PATH)) {
    const name = match[1] ?? "";
    if (!SYNTHETIC_HOMES.has(name.toLowerCase())) {
      report(
        `home directory "${name}" looks real. Use /Users/dev or /home/dev in synthetic fixtures.`,
      );
    }
  }
  for (const match of content.matchAll(EMAIL)) {
    if (!SYNTHETIC_EMAIL_DOMAINS.test(match[0])) {
      report(`email address at a real-looking domain. Use an example.com address.`);
    }
  }
  for (const [kind, pattern] of SECRETS) {
    for (const match of content.matchAll(pattern)) {
      if (!SYNTHETIC_SECRETS.has(match[0])) {
        report(`${kind}-shaped string. Fixtures must not hold credentials, even revoked ones.`);
      }
    }
  }
  // Never echo the matched value into CI logs.
  return findings.filter(
    (finding, index) => findings.findIndex((other) => other.message === finding.message) === index,
  );
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

export interface PolicyInput {
  root: string;
  base: string;
  labels: ReadonlySet<string>;
}

export function runPolicy({ root, base, labels }: PolicyInput): Finding[] {
  const mergeBase = git(["merge-base", base, "HEAD"], root).trim();
  const tracked = git(["diff", "--name-only", mergeBase], root).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], root)
    .split("\n")
    .filter(Boolean);
  const changed: ChangedFile[] = [
    ...tracked.map((path) => ({ path, diff: git(["diff", mergeBase, "--", path], root) })),
    ...untracked.map((path) => ({
      path,
      diff: readFileSync(join(root, path), "utf8")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n"),
    })),
  ];

  const findings: Finding[] = [];
  if (changed.some((file) => file.path === "src/db.ts")) {
    findings.push(
      ...checkFrozenMigrations(
        git(["show", `${mergeBase}:src/db.ts`], root),
        readFileSync(join(root, "src/db.ts"), "utf8"),
      ),
    );
  }
  findings.push(...checkDocs(changed, labels));

  const files = [
    ...git(["ls-files", ...PRIVATE_DATA_ROOTS], root).split("\n"),
    ...untracked.filter((path) => PRIVATE_DATA_ROOTS.some((prefix) => path.startsWith(prefix))),
  ].filter(Boolean);
  for (const path of new Set(files)) {
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue; // Deleted in the working tree.
    }
    findings.push(...scanForPrivateData(path, content));
  }
  return findings;
}

function parseArgs(argv: string[]): { base: string } {
  let base = "origin/main";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1] != null) {
      base = argv[i + 1] as string;
      i += 1;
    } else {
      throw new Error(`unknown argument ${argv[i]}. Usage: pr-policy.ts [--base <ref>]`);
    }
  }
  return { base };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const labels = new Set(
    (process.env.PR_LABELS ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  );
  try {
    const findings = runPolicy({ root, ...parseArgs(process.argv.slice(2)), labels });
    const annotate = process.env.GITHUB_ACTIONS === "true";
    for (const finding of findings) {
      console.error(
        annotate
          ? `::error file=${finding.file},title=${finding.rule}::${finding.message}`
          : `${finding.file}: [${finding.rule}] ${finding.message}`,
      );
    }
    if (findings.length > 0) {
      console.error(`\n${findings.length} policy finding(s). See CONTRIBUTING.md#validate.`);
      process.exit(1);
    }
    console.log("pr-policy: no findings");
  } catch (error) {
    console.error(`pr-policy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
