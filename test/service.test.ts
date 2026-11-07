import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  installService,
  isServiceProcess,
  LAUNCHD_LABEL,
  launchdPlist,
  parseUnitCommand,
  removeService,
  ServiceUnavailableError,
  serviceArgs,
  serviceBinary,
  serviceStatus,
  systemdUnit,
  uninstallService,
  unitPath,
  urlFromCommand,
} from "../src/service.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-service-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let homeCounter = 0;
function freshHome(): string {
  homeCounter += 1;
  return join(workDir, `home-${homeCounter}`);
}

const spec = { binary: "/opt/test/decant", dbPath: "/Users/dev/.decant/decant.db", port: 3000 };

/** A fake launchctl/systemctl that tracks whether the job is loaded and running. */
function fakeManager(initial: { loaded?: boolean; running?: boolean; systemd?: boolean } = {}) {
  const state = { loaded: initial.loaded ?? false, running: initial.running ?? false };
  const calls: string[] = [];
  const run = async (argv: string[]): Promise<CommandResult> => {
    const line = argv.join(" ");
    calls.push(line);
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "launchctl") {
      switch (argv[1]) {
        case "print":
          return state.loaded
            ? ok(
                `gui/501/${LAUNCHD_LABEL} = {\n\tstate = ${state.running ? "running" : "not running"}\n}`,
              )
            : { code: 113, stdout: "", stderr: "Could not find service" };
        case "bootstrap":
          state.loaded = true;
          state.running = true;
          return ok();
        case "bootout":
          state.loaded = false;
          state.running = false;
          return ok();
        case "kickstart":
          state.running = true;
          return ok();
        default:
          return ok();
      }
    }
    if (argv[0] === "systemctl") {
      if (initial.systemd === false) {
        return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      const verb = argv[2];
      if (verb === "is-active") return ok(state.running ? "active\n" : "inactive\n");
      if (verb === "start" || verb === "restart") state.running = true;
      if (verb === "stop") state.running = false;
      return ok();
    }
    return { code: 127, stdout: "", stderr: "unknown command" };
  };
  return { state, calls, run };
}

function darwinOptions(homeDir: string, run: (argv: string[]) => Promise<CommandResult>, env = {}) {
  return {
    platform: "darwin" as const,
    env,
    homeDir,
    uid: 501,
    run,
    install: { channel: "installer" as const, binaryPath: spec.binary },
    execPath: spec.binary,
  };
}

describe("serviceBinary", () => {
  test("points Homebrew installs at the stable opt symlink", () => {
    const result = serviceBinary({
      install: { channel: "homebrew", binaryPath: null },
      execPath: "/opt/homebrew/Cellar/decant/0.14.0/bin/decant",
    });
    expect(result).toEqual({ path: "/opt/homebrew/opt/decant/bin/decant", reason: null });
  });

  test("refuses installs that cannot outlive the current process", () => {
    for (const channel of ["source", "npx", "docker"] as const) {
      const result = serviceBinary({ install: { channel, binaryPath: null } });
      expect(result.path).toBeNull();
      expect(result.reason).toBeString();
    }
  });

  test("uses the binary's own path for the installer and npm", () => {
    expect(
      serviceBinary({
        install: { channel: "installer", binaryPath: "/x" },
        execPath: "/missing/bin/decant",
      }),
    ).toEqual({ path: "/missing/bin/decant", reason: null });
  });
});

describe("unit files", () => {
  const tricky = {
    binary: "/Apps/My Tools/decant",
    dbPath: "/data/a&b <x> 100% $HOME/d.db",
    port: 4123,
  };

  test("the LaunchAgent restarts only on failure and marks the process as the service", () => {
    const plist = launchdPlist(spec, { homeDir: "/Users/dev" });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>DECANT_SERVICE<\/key>\s*<string>1<\/string>/);
    expect(plist).toContain("/Users/dev/Library/Logs/decant/serve.log");
  });

  test("the systemd unit restarts only on failure", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("Environment=DECANT_SERVICE=1");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("commands survive escaping in both formats", () => {
    expect(parseUnitCommand("launchd", launchdPlist(tricky))).toEqual(serviceArgs(tricky));
    expect(parseUnitCommand("systemd", systemdUnit(tricky))).toEqual(serviceArgs(tricky));
    // systemd would expand an unescaped % or $ inside ExecStart.
    expect(systemdUnit(tricky)).toContain("100%% $$HOME");
  });

  test("the URL comes from the unit's --port", () => {
    expect(urlFromCommand(serviceArgs(tricky))).toBe("http://127.0.0.1:4123");
    expect(urlFromCommand(null)).toBeNull();
  });

  test("unit paths follow each manager's per-user location", () => {
    expect(unitPath("launchd", { homeDir: "/h" })).toBe(
      `/h/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
    expect(unitPath("systemd", { homeDir: "/h", env: {} })).toBe(
      "/h/.config/systemd/user/decant.service",
    );
    expect(unitPath("systemd", { homeDir: "/h", env: { XDG_CONFIG_HOME: "/cfg" } })).toBe(
      "/cfg/systemd/user/decant.service",
    );
  });
});

describe("serviceStatus", () => {
  test("is unsupported off macOS and Linux", async () => {
    const status = await serviceStatus({ platform: "win32", env: {} });
    expect(status.supported).toBe(false);
    expect(status.manager).toBeNull();
  });

  test("is unsupported on Linux without a systemd user session", async () => {
    const fake = fakeManager({ systemd: false });
    const status = await serviceStatus({
      platform: "linux",
      env: {},
      homeDir: freshHome(),
      run: fake.run,
      install: { channel: "installer", binaryPath: spec.binary },
      execPath: spec.binary,
    });
    expect(status.supported).toBe(false);
    expect(status.reason).toContain("systemd");
  });

  test("reports whether the answering process is the service", async () => {
    expect(isServiceProcess({ DECANT_SERVICE: "1" })).toBe(true);
    expect(isServiceProcess({})).toBe(false);
    const fake = fakeManager();
    const status = await serviceStatus(
      darwinOptions(freshHome(), fake.run, { DECANT_SERVICE: "1" }),
    );
    expect(status.current).toBe(true);
  });
});

describe("launchd install and uninstall", () => {
  test("a fresh install writes the LaunchAgent and bootstraps it", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const status = await installService(
      { dbPath: spec.dbPath, port: 3000 },
      darwinOptions(home, fake.run),
    );
    expect(status).toMatchObject({ installed: true, running: true, url: "http://127.0.0.1:3000" });
    expect(status.command).toEqual(serviceArgs(spec));
    expect(fake.calls).toContain("launchctl enable gui/501/dev.dosu.decant");
    expect(fake.calls).toContain(
      `launchctl bootstrap gui/501 ${unitPath("launchd", { homeDir: home })}`,
    );
  });

  test("installing the same service again changes nothing", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    fake.calls.length = 0;
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    expect(fake.calls.filter((call) => !call.startsWith("launchctl print"))).toEqual([]);
  });

  test("a loaded but stopped job is kickstarted rather than bootstrapped twice", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    fake.state.running = false;
    fake.calls.length = 0;
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    expect(fake.calls).toContain("launchctl kickstart gui/501/dev.dosu.decant");
    expect(fake.calls.some((call) => call.startsWith("launchctl bootstrap"))).toBe(false);
  });

  test("a changed port reloads the job, except from inside the service", async () => {
    const home = freshHome();
    const fake = fakeManager();
    await installService({ dbPath: spec.dbPath, port: 3000 }, darwinOptions(home, fake.run));

    fake.calls.length = 0;
    const inside = darwinOptions(home, fake.run, { DECANT_SERVICE: "1" });
    await installService({ dbPath: spec.dbPath, port: 4000 }, inside);
    // Booting out its own job would kill the caller mid-request.
    expect(fake.calls.some((call) => call.startsWith("launchctl bootout"))).toBe(false);
    expect(readFileSync(unitPath("launchd", { homeDir: home }), "utf8")).toContain(
      "<string>4000</string>",
    );

    fake.calls.length = 0;
    await installService({ dbPath: spec.dbPath, port: 5000 }, darwinOptions(home, fake.run));
    expect(fake.calls).toContain("launchctl bootout gui/501/dev.dosu.decant");
    expect(fake.calls.some((call) => call.startsWith("launchctl bootstrap"))).toBe(true);
  });

  test("a failed bootstrap surfaces launchctl's error", async () => {
    const home = freshHome();
    const base = fakeManager();
    const run = async (argv: string[]): Promise<CommandResult> =>
      argv[1] === "bootstrap"
        ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
        : base.run(argv);
    await expect(
      installService({ dbPath: spec.dbPath, port: 3000 }, darwinOptions(home, run)),
    ).rejects.toThrow("Input/output error");
  });

  test("an unsupported install throws ServiceUnavailableError", async () => {
    const fake = fakeManager();
    await expect(
      installService(
        { dbPath: spec.dbPath, port: 3000 },
        {
          ...darwinOptions(freshHome(), fake.run),
          install: { channel: "source", binaryPath: null },
        },
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("removeService unregisters without stopping; uninstall also stops", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);

    fake.calls.length = 0;
    await removeService(options);
    expect(existsSync(unitPath("launchd", { homeDir: home }))).toBe(false);
    expect(fake.calls.some((call) => call.startsWith("launchctl bootout"))).toBe(false);

    const status = await uninstallService(options);
    expect(fake.calls).toContain("launchctl bootout gui/501/dev.dosu.decant");
    expect(status).toMatchObject({ installed: false, running: false });
  });
});

describe("systemd install and uninstall", () => {
  test("installs, enables, and starts the user unit", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const options = {
      platform: "linux" as const,
      env: {},
      homeDir: home,
      run: fake.run,
      install: { channel: "installer" as const, binaryPath: spec.binary },
      execPath: spec.binary,
    };
    const status = await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    expect(status).toMatchObject({ installed: true, running: true, manager: "systemd" });
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        "systemctl --user daemon-reload",
        "systemctl --user enable decant.service",
        "systemctl --user start decant.service",
      ]),
    );

    fake.calls.length = 0;
    await uninstallService(options);
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        "systemctl --user disable decant.service",
        "systemctl --user stop --no-block decant.service",
      ]),
    );
    expect(existsSync(unitPath("systemd", options))).toBe(false);
  });

  test("leaves a foreign unit file's command unread", async () => {
    const home = freshHome();
    const path = unitPath("launchd", { homeDir: home });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, "not a plist");
    const status = await serviceStatus(darwinOptions(home, fakeManager().run));
    expect(status.installed).toBe(true);
    expect(status.command).toBeNull();
    expect(status.url).toBeNull();
  });
});

describe("binaryChanged", () => {
  // Pending until binaryChanged in src/service.ts is implemented.
  test.todo("is false while the same file is in place");
  test.todo("is true when Homebrew moves the opt symlink to a new Cellar path");
  test.todo("is true when the installer renames a new file over the old one");
});
