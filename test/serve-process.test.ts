import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVICE_STOP_GRACE_MS = 10_000;
const HOST_LIFETIME_PAST_THE_STOP_GRACE_MS = SERVICE_STOP_GRACE_MS + 1_000;
const SIGTERM_DELAY_AFTER_STARTUP_MS = 25;

test("a completed supervised serve leaves no stop-grace force-exit timer behind to exit its library host", async () => {
  const root = mkdtempSync(join(tmpdir(), "decant-serve-process-"));
  const program = `
    import { runCli } from "./src/cli.ts";
    import { configureLogging } from "./src/logging.ts";
    import { join } from "node:path";
    const root = process.env.DECANT_TEST_HOME;
    let stopSent = false;
    configureLogging({ write(line) {
      if (!stopSent && JSON.parse(line)["event.name"] === "decant.server.started") {
        stopSent = true;
        setTimeout(() => process.kill(process.pid, "SIGTERM"), ${SIGTERM_DELAY_AFTER_STARTUP_MS});
      }
    }});
    const result = await runCli(
      ["--db", join(root, "archive.db"), "--no-sync", "serve", "--no-open", "--port", "0"],
      {
        homeDir: root,
        env: { DECANT_SERVICE: "1", DECANT_NO_SYNC: "1", DECANT_UPDATE_CHECK: "0" },
      },
    );
    if (result.code !== 0) throw new Error(result.stderr);
    console.log("serve-returned");
    await Bun.sleep(${HOST_LIFETIME_PAST_THE_STOP_GRACE_MS});
    console.log("host-survived");
  `;
  const proc = Bun.spawn([process.execPath, "--eval", program], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, DECANT_TEST_HOME: root, DECANT_CONFIG_DIR: join(root, "config") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("serve-returned");
    expect(stdout).toContain("host-survived");
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
