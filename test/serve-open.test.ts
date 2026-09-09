import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// E2E for the serve banner and browser auto-open: spawn the real CLI the way
// test/serve-wiring.test.ts does. Piped stdio means stdout is not a TTY, so
// the platform-default open path never fires here; the explicit-BROWSER
// override is both a feature and the test seam.

const repoRoot = join(import.meta.dir, "..");
const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)/;

interface CliProcess {
  child: ChildProcess;
  stderr: () => string;
}

function startCli(args: string[], scratch: string, env: Record<string, string> = {}): CliProcess {
  const inherited = { ...process.env };
  delete inherited.BROWSER;
  delete inherited.DECANT_NO_OPEN;
  delete inherited.CI;
  const child = spawn("bun", ["run", join(repoRoot, "src/cli.ts"), ...args], {
    env: {
      ...inherited,
      DECANT_DB: join(scratch, "decant.db"),
      DECANT_CONFIG_DIR: join(scratch, "config"),
      DECANT_NO_SYNC: "1",
      DECANT_LOG_LEVEL: "off",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", () => {});
  return { child, stderr: () => stderr };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function stop(child: ChildProcess): Promise<number | null> {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.kill("SIGTERM");
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    // A failed listen (EACCES, fd limits) emits "error"; without a listener
    // that is an uncaught exception instead of a clean test failure.
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address != null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no port"));
        }
      });
    });
  });
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "decant-serve-open-"));
}

/** BROWSER stub that appends its single argument to a log file. */
function spyBrowser(scratch: string): { script: string; log: string } {
  const log = join(scratch, "opened.log");
  const script = join(scratch, "spy-browser.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(log)}\n`, {
    mode: 0o755,
  });
  return { script, log };
}

describe("serve banner and auto-open", () => {
  test("prints the URL banner without opening when no BROWSER is set (non-TTY)", async () => {
    const scratch = scratchDir();
    const port = await freePort();
    const cli = startCli(["serve", "--port", String(port)], scratch);
    try {
      await waitFor(() => URL_LINE.test(cli.stderr()), "url banner");
      expect(cli.stderr()).toContain(`    http://127.0.0.1:${port}`);
      expect(cli.stderr()).toContain("Open the link in your browser.");
      expect(cli.stderr()).not.toContain("Opening your browser");
    } finally {
      expect(await stop(cli.child)).toBe(0);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("BROWSER override opens exactly the printed URL", async () => {
    const scratch = scratchDir();
    const port = await freePort();
    const spy = spyBrowser(scratch);
    const cli = startCli(["serve", "--port", String(port)], scratch, { BROWSER: spy.script });
    try {
      await waitFor(() => existsSync(spy.log), "spy browser invocation");
      expect(readFileSync(spy.log, "utf8").trim()).toBe(`http://127.0.0.1:${port}`);
      expect(cli.stderr()).toContain("Opening your browser");
    } finally {
      expect(await stop(cli.child)).toBe(0);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("--no-open beats BROWSER and still prints the link", async () => {
    const scratch = scratchDir();
    const port = await freePort();
    const spy = spyBrowser(scratch);
    const cli = startCli(["serve", "--port", String(port), "--no-open"], scratch, {
      BROWSER: spy.script,
    });
    try {
      await waitFor(() => URL_LINE.test(cli.stderr()), "url banner");
      expect(cli.stderr()).toContain(`    http://127.0.0.1:${port}`);
    } finally {
      expect(await stop(cli.child)).toBe(0);
      // If the opener were going to fire, it would have done so before startup
      // finished and the server shut down cleanly.
      expect(existsSync(spy.log)).toBe(false);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("quiet suppresses the banner but the server still runs", async () => {
    const scratch = scratchDir();
    const port = await freePort();
    const cli = startCli(["serve", "--port", String(port), "-q"], scratch);
    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          return response.ok;
        } catch {
          return false;
        }
      }, "health endpoint");
      expect(cli.stderr()).not.toContain("http://");
    } finally {
      expect(await stop(cli.child)).toBe(0);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a busy port fails with a pointer instead of a stack trace", async () => {
    const scratch = scratchDir();
    const port = await freePort();
    const holder = net.createServer();
    // Same exposure as freePort's probe, plus a real race: this re-binds a
    // port that was only just released, so a rare EADDRINUSE must reject
    // rather than raise an unhandled "error" event.
    await new Promise<void>((resolve, reject) => {
      holder.on("error", reject);
      holder.listen(port, "127.0.0.1", resolve);
    });
    const cli = startCli(["serve", "--port", String(port)], scratch);
    try {
      const code = await new Promise<number | null>((resolve) => {
        cli.child.once("exit", (value) => resolve(value));
      });
      expect(code).toBe(1);
      expect(cli.stderr()).toContain(`port ${port} is already in use`);
      expect(cli.stderr()).toContain("decant serve --port");
    } finally {
      holder.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("bare decant serves instead of printing help", async () => {
    const scratch = scratchDir();
    const cli = startCli([], scratch, { BROWSER: "none" });
    try {
      await waitFor(
        () => URL_LINE.test(cli.stderr()) || cli.stderr().includes("already in use"),
        "serve banner or busy-port message",
      );
      expect(cli.stderr()).not.toContain("Usage:");
    } finally {
      await stop(cli.child);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
