import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import type { CommandResult, ServiceOptions } from "../src/service.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-service-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function cliOptions(service: Partial<ServiceOptions>) {
  const home = join(workDir, "home");
  let loaded = false;
  const run = async (argv: string[]): Promise<CommandResult> => {
    if (argv[1] === "print") {
      return loaded
        ? { code: 0, stdout: "\tstate = running\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "" };
    }
    if (argv[1] === "bootstrap") loaded = true;
    if (argv[1] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    env: { DECANT_NO_SYNC: "1", DECANT_DB: join(workDir, "decant.db") },
    homeDir: home,
    service: {
      platform: "darwin" as const,
      uid: 501,
      run,
      install: { channel: "installer" as const, binaryPath: "/opt/test/decant" },
      execPath: "/opt/test/decant",
      ...service,
    },
  };
}

describe("decant service", () => {
  test("installs, reports, and uninstalls the background service", async () => {
    const options = cliOptions({});
    const install = await runCli(["service", "install", "--port", "4100"], options);
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("http://127.0.0.1:4100");

    const status = await runCli(["--json", "service", "status"], options);
    expect(JSON.parse(status.stdout)).toMatchObject({
      installed: true,
      running: true,
      url: "http://127.0.0.1:4100",
      command: [
        "/opt/test/decant",
        "--db",
        join(workDir, "decant.db"),
        "serve",
        "--no-open",
        "--port",
        "4100",
      ],
    });

    const human = await runCli(["service"], options);
    expect(human.stdout).toContain("Background service: running (launchd)");

    const uninstall = await runCli(["service", "uninstall"], options);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stdout).toContain("no longer runs in the background");
  });

  test("explains why a source checkout cannot install it", async () => {
    const result = await runCli(
      ["service", "install"],
      cliOptions({ install: { channel: "source", binaryPath: null } }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("source checkout");
  });
});
