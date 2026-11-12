// One probe per process, for tests whose regression would block forever.
import { closeDb, openDb } from "../src/db.ts";
import { sync } from "../src/ingest.ts";
import { OpenCodeMcpServerNames } from "../src/sources/opencode-store.ts";
import { resolveGitRoot } from "../src/worktree.ts";

const [mode, ...args] = process.argv.slice(2);
const started = performance.now();
let result: unknown;

if (mode === "git-root") {
  result = { root: resolveGitRoot(args[0] as string) };
} else if (mode === "mcp-names") {
  result = new OpenCodeMcpServerNames({}).lookup(args[0] as string);
} else if (mode === "sync") {
  const [dbPath, opencodeDir, emptyDir] = args as [string, string, string];
  const db = openDb(dbPath);
  const config = { claudeDir: emptyDir, codexDir: emptyDir, opencodeDir };
  const first = sync(db, config);
  const second = sync(db, config);
  result = {
    first,
    second,
    issues: db.query("SELECT code FROM ingest_issue ORDER BY id").all(),
    hashes: db.query("SELECT hash FROM ingest_source ORDER BY path").all(),
    projects: db.query("SELECT root_source, repo_remote FROM project ORDER BY id").all(),
    mcpCalls: db.query("SELECT COUNT(*) AS n FROM tool_call WHERE tool_kind = 'mcp'").get(),
  };
  closeDb(db);
} else {
  throw new Error(`unknown mode: ${mode}`);
}

process.stdout.write(
  JSON.stringify({ result, elapsedMs: Math.round(performance.now() - started) }),
);
