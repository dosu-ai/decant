import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
      // serve reports startup as JSON Lines on stderr (PR #41). The older
      // "serving http://host:port" line no longer exists, and scraping for it
      // drains the deadline and fails as if the server never started.
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
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });

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

  // Precedence, not union: the highest-priority source that is present wins
  // outright (src/server.ts, PR #40). Flags beat the environment, so passing
  // --trusted-peer REPLACES DECANT_TRUSTED_PEERS rather than adding to it.
  // That is what lets an operator narrow trust; a union could only widen it.
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

/**
 * `--no-sync` is a global flag, and `serve` used to accept it while its watcher
 * kept ingesting anyway. That is worse than rejecting it: pointing `serve` at a
 * scratch archive to inspect it, or to take a screenshot, silently filled that
 * archive with whatever the real `~/.claude` and `~/.codex` held.
 *
 * These spawn the real CLI against a synthetic source tree, because the bug was
 * entirely in the argv-to-serve() wiring -- every layer below it was correct.
 */
interface SyncCase {
  env?: Record<string, string>;
  flags?: string[];
}

async function withSeededServe<T>(
  c: SyncCase,
  run: (port: number, startupLog: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "decant-serve-sync-"));
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex");
  const projectDir = join(claudeDir, "-Users-dev-proj");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  // A real, ingestible session. If the watcher runs, this lands in the archive.
  copyFileSync(join(repoRoot, "fixtures", "claude", "sample.jsonl"), join(projectDir, "s1.jsonl"));

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
    ],
    { cwd: repoRoot, env, stdout: "ignore", stderr: "pipe" },
  );

  try {
    const { port, log } = await readServePort(proc);
    return await run(port, log);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function sessionCount(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/stats/summary`);
  const body = (await response.json()) as { sessions?: number };
  return body.sessions ?? 0;
}

/** Poll until the startup sync lands, rather than sleeping a fixed guess. */
async function waitForIngest(port: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = await sessionCount(port);
    if (count > 0) {
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("watcher never ingested the fixture");
}

/**
 * How long to give a watcher that should NOT be running.
 *
 * Proving a negative needs a real wait; there is no event to poll for when the
 * intended behaviour is that nothing happens. This cannot be shortened to a
 * token delay: against the unfixed CLI the ingest lands around the 2.5s mark,
 * so a 100ms wait would let these tests pass on the very bug they exist to
 * catch. It is deliberately longer than `waitForIngest` needs when the watcher
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
      expect(await waitForIngest(port)).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(NO_INGEST_GRACE_MS);
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
