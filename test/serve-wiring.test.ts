import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end coverage for the CLI→serve() trusted-peer wiring: spawn the real
// CLI, bind 0.0.0.0, and connect via a non-loopback interface so the request's
// source address actually exercises the peer guard — the exact shape of the
// documented Docker deployment (loopback Host header, non-loopback remote
// address). The precedence logic itself is unit-tested in server.test.ts; this
// file proves argv/env reach serve() unmangled.

const repoRoot = join(import.meta.dir, "..");

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

const lanIP = nonLoopbackIPv4();
if (lanIP == null) {
  console.warn("serve-wiring test: no non-loopback IPv4 interface; skipping wiring tests");
}

/** Raw HTTP GET so the Host header stays loopback while the socket source is the LAN address. */
function httpStatus(ip: string, port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, ip, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const head = Buffer.concat(chunks).toString("utf8");
      const match = head.match(/^HTTP\/1\.[01] (\d{3})/);
      if (match) resolve(Number(match[1]));
      else reject(new Error(`unparseable response: ${head.slice(0, 120)}`));
    });
    socket.on("error", reject);
  });
}

/**
 * Read serve's JSON Lines startup log until it reports its port.
 *
 * The kill timer matters: without it a `read()` that never resolves -- a child
 * that hangs before writing anything -- blocks until the per-test timeout
 * instead of failing here with the output collected so far. Killing the process
 * makes the stream end, so the loop exits and reports what it saw.
 */
async function readServePort(
  proc: Bun.Subprocess<"ignore", "ignore", "pipe">,
): Promise<{ port: number; log: string }> {
  const kill = setTimeout(() => proc.kill(), 15_000);
  try {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const match = buffer.match(/"server\.port":\s*(\d+)/);
      if (match) {
        return { port: Number(match[1]), log: buffer };
      }
    }
    throw new Error(`serve never reported its port; stderr so far: ${buffer.slice(0, 300)}`);
  } finally {
    clearTimeout(kill);
  }
}

interface ServeCase {
  env?: Record<string, string>;
  flags?: string[];
}

async function withServe<T>(c: ServeCase, run: (port: number) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "decant-serve-wiring-"));
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex");
  const geminiDir = join(dir, "gemini");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(geminiDir, { recursive: true });

  const env = { ...process.env, ...(c.env ?? {}) };
  if (!(c.env && "DECANT_TRUSTED_PEERS" in c.env)) delete env.DECANT_TRUSTED_PEERS;

  const proc = Bun.spawn(
    [
      "bun",
      "src/cli.ts",
      "--db",
      join(dir, "archive.db"),
      "serve",
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--claude-dir",
      claudeDir,
      "--codex-dir",
      codexDir,
      "--gemini-dir",
      geminiDir,
      ...(c.flags ?? []),
    ],
    { cwd: repoRoot, env, stdout: "ignore", stderr: "pipe" },
  );

  try {
    const { port } = await readServePort(proc);
    return await run(port);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(lanIP == null)("serve trusted-peer wiring (real CLI process)", () => {
  const ip = lanIP as string;

  test("baseline: a non-loopback peer is rejected when no trust is configured", async () => {
    await withServe({}, async (port) => {
      expect(await httpStatus(ip, port, "/api/health")).toBe(403);
    });
  }, 30_000);

  test("DECANT_TRUSTED_PEERS alone admits the peer (env-only)", async () => {
    await withServe({ env: { DECANT_TRUSTED_PEERS: ip } }, async (port) => {
      expect(await httpStatus(ip, port, "/api/health")).toBe(200);
    });
  }, 30_000);

  test("--trusted-peer alone admits the peer (flags-only)", async () => {
    await withServe({ flags: ["--trusted-peer", ip] }, async (port) => {
      expect(await httpStatus(ip, port, "/api/health")).toBe(200);
    });
  }, 30_000);

  // Flags replace the environment so operators can narrow trust.
  test("flags replace the env var rather than merging with it", async () => {
    await withServe(
      { env: { DECANT_TRUSTED_PEERS: "203.0.113.0/24" }, flags: ["--trusted-peer", ip] },
      async (port) => {
        expect(await httpStatus(ip, port, "/api/health")).toBe(200);
      },
    );
  }, 30_000);

  test("a peer trusted only by the env var is rejected once flags take over", async () => {
    await withServe(
      { env: { DECANT_TRUSTED_PEERS: ip }, flags: ["--trusted-peer", "203.0.113.9"] },
      async (port) => {
        expect(await httpStatus(ip, port, "/api/health")).toBe(403);
      },
    );
  }, 30_000);
});

// Exercise argv-to-serve wiring against synthetic sources.
interface SyncCase {
  env?: Record<string, string>;
  flags?: string[];
}

interface SeededSources {
  claudeProjectDir: string;
  claudeSessionPath: string;
  codexSessionsDir: string;
  codexSessionPath: string;
}

async function withSeededServe<T>(
  c: SyncCase,
  run: (port: number, startupLog: string, sources: SeededSources) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "decant-serve-sync-"));
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex");
  const geminiDir = join(dir, "gemini");
  const projectDir = join(claudeDir, "-Users-dev-proj");
  const codexSessionsDir = join(codexDir, "sessions");
  const claudeSessionPath = join(projectDir, "s1.jsonl");
  const codexSessionPath = join(codexSessionsDir, "rollout-s1.jsonl");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  // Real, ingestible sessions. If the watcher runs, both land in the archive.
  copyFileSync(join(repoRoot, "fixtures", "claude", "sample.jsonl"), claudeSessionPath);
  copyFileSync(join(repoRoot, "fixtures", "codex", "sample.jsonl"), codexSessionPath);

  const env = { ...process.env, ...(c.env ?? {}) };
  delete env.DECANT_TRUSTED_PEERS;
  if (!(c.env && "DECANT_NO_SYNC" in c.env)) {
    delete env.DECANT_NO_SYNC;
  }

  const proc = Bun.spawn(
    [
      "bun",
      "src/cli.ts",
      "--db",
      join(dir, "archive.db"),
      ...(c.flags ?? []),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--claude-dir",
      claudeDir,
      "--codex-dir",
      codexDir,
      "--gemini-dir",
      geminiDir,
    ],
    { cwd: repoRoot, env, stdout: "ignore", stderr: "pipe" },
  );

  try {
    const { port: boundPort, log } = await readServePort(proc);
    return await run(boundPort, log, {
      claudeProjectDir: projectDir,
      claudeSessionPath,
      codexSessionsDir,
      codexSessionPath,
    });
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ArchiveSummary {
  sessions: number;
  messages: number;
  tool_calls: number;
}

async function archiveSummary(port: number): Promise<ArchiveSummary> {
  const response = await fetch(`http://127.0.0.1:${port}/api/stats/summary`);
  return (await response.json()) as ArchiveSummary;
}

async function sessionCount(port: number): Promise<number> {
  return (await archiveSummary(port)).sessions;
}

/** Poll until the expected sessions land, rather than sleeping a fixed guess. */
async function waitForSessionCount(port: number, expected: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await sessionCount(port);
    if (count === expected) {
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`watcher never reached ${expected} ingested sessions`);
}

async function waitForToolCallCount(port: number, expected: number): Promise<ArchiveSummary> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const summary = await archiveSummary(port);
    if (summary.tool_calls === expected) {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`watcher never reached ${expected} ingested tool calls`);
}

/**
 * How long to give a watcher that should NOT be running.
 *
 * Proving a negative needs a real wait; there is no event to poll for when the
 * intended behaviour is that nothing happens. This cannot be shortened to a
 * token delay: against the unfixed CLI the ingest lands around the 2.5s mark,
 * so a 100ms wait would let these tests pass on the very bug they exist to
 * catch. It is deliberately longer than `waitForSessionCount` needs when the watcher
 * IS running, which the baseline test measures.
 */
const NO_INGEST_GRACE_MS = 4000;

async function expectNoIngest(port: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, NO_INGEST_GRACE_MS));
  expect(await sessionCount(port)).toBe(0);
}

describe("serve sync opt-out (real CLI process)", () => {
  // Without this the suite would pass vacuously: an unloadable fixture, or a
  // watcher that never starts, makes every "stayed empty" assertion trivial.
  test("baseline: the watcher ingests the source tree by default", async () => {
    await withSeededServe({}, async (port, startupLog) => {
      expect(startupLog).toContain('"watch.enabled":true');
      // Also establishes that the grace period below outlasts a real ingest.
      const started = Date.now();
      expect(await waitForSessionCount(port, 2)).toBe(2);
      expect(Date.now() - started).toBeLessThan(NO_INGEST_GRACE_MS);
    });
  }, 40_000);

  test("keeps Claude and Codex sources current after startup", async () => {
    await withSeededServe({}, async (port, startupLog, sources) => {
      expect(startupLog).toContain('"watch.enabled":true');
      expect(await waitForSessionCount(port, 2)).toBe(2);
      const initial = await archiveSummary(port);

      appendFileSync(
        sources.claudeSessionPath,
        '\n{"type":"assistant","uuid":"a3","parentUuid":"a2","sessionId":"sess-claude-1","timestamp":"2026-05-01T10:00:11.000Z","cwd":"/Users/dev/proj","gitBranch":"main","version":"2.1.0","message":{"role":"assistant","model":"claude-opus-4-7","stop_reason":"tool_use","usage":{"input_tokens":1600,"output_tokens":130},"content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/Users/dev/proj/README.md"}}]}}\n{"type":"user","uuid":"u3","parentUuid":"a3","sessionId":"sess-claude-1","timestamp":"2026-05-01T10:00:12.000Z","cwd":"/Users/dev/proj","gitBranch":"main","version":"2.1.0","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":false,"content":"Synthetic README"}]}}\n',
      );
      const afterClaudeAppend = await waitForToolCallCount(port, initial.tool_calls + 1);
      expect(afterClaudeAppend.sessions).toBe(2);
      expect(afterClaudeAppend.messages).toBeGreaterThan(initial.messages);

      appendFileSync(
        sources.codexSessionPath,
        '\n{"type":"response_item","timestamp":"2026-05-02T09:00:09.000Z","payload":{"type":"function_call","name":"exec_command","call_id":"call_2","arguments":"{\\"command\\":\\"pwd\\"}"}}\n{"type":"response_item","timestamp":"2026-05-02T09:00:10.000Z","payload":{"type":"function_call_output","call_id":"call_2","output":"/Users/dev/proj"}}\n',
      );
      const afterCodexAppend = await waitForToolCallCount(port, initial.tool_calls + 2);
      expect(afterCodexAppend.sessions).toBe(2);
      expect(afterCodexAppend.messages).toBeGreaterThan(afterClaudeAppend.messages);

      copyFileSync(
        join(repoRoot, "fixtures", "claude", "enriched.jsonl"),
        join(sources.claudeProjectDir, "s2.jsonl"),
      );
      expect(await waitForSessionCount(port, 3)).toBe(3);

      copyFileSync(
        join(repoRoot, "fixtures", "codex", "enriched.jsonl"),
        join(sources.codexSessionsDir, "rollout-s2.jsonl"),
      );
      expect(await waitForSessionCount(port, 4)).toBe(4);
    });
  }, 40_000);

  test("--no-sync leaves the archive untouched", async () => {
    await withSeededServe({ flags: ["--no-sync"] }, async (port, startupLog) => {
      expect(startupLog).toContain('"watch.enabled":false');
      await expectNoIngest(port);
    });
  }, 40_000);

  test("DECANT_NO_SYNC does the same, matching read commands", async () => {
    await withSeededServe({ env: { DECANT_NO_SYNC: "1" } }, async (port, startupLog) => {
      expect(startupLog).toContain('"watch.enabled":false');
      await expectNoIngest(port);
    });
  }, 40_000);

  test("the UI still serves the archive it was pointed at", async () => {
    // Opting out of ingestion must not degrade reads; that is the whole point
    // of the mode.
    await withSeededServe({ flags: ["--no-sync"] }, async (port) => {
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status).toBe(200);
    });
  }, 40_000);
});
