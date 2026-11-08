import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { listSessions } from "../src/query.ts";

// End-to-end coverage for standalone `decant watch`: the real CLI must keep
// running until a signal arrives, ingest changes made while it runs, and exit
// cleanly on SIGTERM. Every source directory and the archive live in a scratch
// directory so the child never reads the developer's real session logs.

const repoRoot = join(import.meta.dir, "..");
const workDir = mkdtempSync(join(tmpdir(), "decant-watch-process-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

interface SyncCompleted {
  "event.name": string;
  "sync.files.ingested"?: number;
}

function sourceDirs(root: string): Record<string, string> {
  const dirs = {
    claude: join(root, "claude", "projects"),
    codex: join(root, "codex"),
    gemini: join(root, "gemini"),
    opencode: join(root, "opencode"),
    cursor: join(root, "cursor"),
    copilot: join(root, "copilot"),
    "vscode-copilot": join(root, "vscode", "User"),
    atif: join(root, "atif"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

describe("decant watch process", () => {
  test("stays running, ingests a later change, and exits on SIGTERM", async () => {
    const dirs = sourceDirs(workDir);
    const dbPath = join(workDir, "archive.db");
    const env: Record<string, string | undefined> = {
      ...process.env,
      DECANT_CONFIG_DIR: join(workDir, "config"),
      DECANT_LOG_LEVEL: "info",
    };
    // --db names the archive, and the watcher's own startup sync must run.
    delete env.DECANT_DB;
    delete env.DECANT_NO_SYNC;
    // OPENCODE_DB adds a source even when --opencode-dir is overridden.
    delete env.OPENCODE_DB;
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    delete env.DECANT_OPENCODE_CONFIG;
    const proc = Bun.spawn(
      [
        "bun",
        "src/cli.ts",
        "--db",
        dbPath,
        "watch",
        "--no-fs-watch",
        "--interval-ms",
        "200",
        ...Object.entries(dirs).flatMap(([name, dir]) => [`--${name}-dir`, dir]),
      ],
      { cwd: repoRoot, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const kill = setTimeout(() => proc.kill("SIGKILL"), 20_000);

    const events: SyncCompleted[] = [];
    let stderr = "";
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        stderr += decoder.decode(chunk, { stream: true });
        const lines = stderr.split("\n");
        stderr = lines.pop() ?? "";
        for (const line of lines) {
          try {
            events.push(JSON.parse(line) as SyncCompleted);
          } catch {
            // Non-JSON output is kept out of the event list.
          }
        }
      }
    })();

    const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        if (proc.exitCode != null) {
          throw new Error(`watch exited with ${proc.exitCode} while waiting for ${label}`);
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(25);
      }
    };
    const completed = () => events.filter((e) => e["event.name"] === "decant.sync.completed");

    try {
      await waitFor(() => completed().length > 0, "the startup sync");
      // The regression exited right after the startup sync without a signal.
      await Bun.sleep(1_000);
      expect(proc.exitCode).toBeNull();

      const fixture = readFileSync(join(repoRoot, "fixtures", "claude", "sample.jsonl"), "utf8");
      mkdirSync(join(dirs.claude ?? "", "Users-dev-proj"), { recursive: true });
      writeFileSync(join(dirs.claude ?? "", "Users-dev-proj", "sample.jsonl"), fixture);
      await waitFor(
        () => completed().some((e) => (e["sync.files.ingested"] ?? 0) > 0),
        "the new session to be ingested",
      );

      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      await reading;
      expect(events.some((e) => e["event.name"] === "decant.watch.stopped")).toBe(true);
    } finally {
      clearTimeout(kill);
      proc.kill("SIGKILL");
    }

    const db = openDb(dbPath);
    try {
      expect(listSessions(db)).toHaveLength(1);
    } finally {
      closeDb(db);
    }
  }, 30_000);
});
