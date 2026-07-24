import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    let port: number | null = null;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // serve reports startup as JSON Lines on stderr (PR #41). The older
      // "serving http://host:port" line no longer exists, and scraping for it
      // drains the deadline and fails as if the server never started.
      const match = buffer.match(/"server\.port":\s*(\d+)/);
      if (match) {
        port = Number(match[1]);
        break;
      }
    }
    if (port == null) {
      throw new Error(`serve never reported its port; stderr so far: ${buffer.slice(0, 300)}`);
    }
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
