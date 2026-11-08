import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a completed supervised serve does not later exit its host process", async () => {
  const root = mkdtempSync(join(tmpdir(), "decant-serve-process-"));
  // runCli is also used as a library. Keep its host alive past the emergency
  // stop deadline so a timer left behind after a clean stop is observable.
  const program = `
    import { runCli } from "./src/cli.ts";
    import { configureLogging } from "./src/logging.ts";
    import { join } from "node:path";
    const root = process.env.DECANT_TEST_HOME;
    let stopSent = false;
    configureLogging({ write(line) {
      if (!stopSent && JSON.parse(line)["event.name"] === "decant.server.started") {
        stopSent = true;
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 25);
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
    await Bun.sleep(11_000);
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
