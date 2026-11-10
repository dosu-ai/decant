import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type BinaryFingerprint,
  binaryChanged,
  binaryFingerprint,
  type CommandResult,
  installService,
  isServiceProcess,
  LAUNCHD_LABEL,
  launchdPlist,
  parseLaunchdArguments,
  parseUnitCommand,
  removeService,
  ServiceUnavailableError,
  serviceArgs,
  serviceBinary,
  serviceStatus,
  stopService,
  systemdUnit,
  UnsafeServicePathError,
  uninstallService,
  unitPath,
  urlFromCommand,
  watchBinary,
} from "../src/service.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-service-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let homeCounter = 0;
function freshHome(): string {
  homeCounter += 1;
  return join(workDir, `home-${homeCounter}`);
}

const spec = { binary: "/opt/test/decant", dbPath: "/Users/dev/.decant/decant.db", port: 3000 };

/**
 * A fake launchctl/systemctl that tracks whether the job is loaded and running.
 * Like launchd, it caches the arguments it read at bootstrap, keeps a booted-out
 * job registered for `exitPrints` status reads while its process exits, and
 * refuses to bootstrap the label until then.
 */
function fakeManager(
  initial: { loaded?: boolean; running?: boolean; systemd?: boolean; exitPrints?: number } = {},
) {
  const state = {
    loaded: initial.loaded ?? false,
    running: initial.running ?? false,
    exiting: 0,
    args: null as string[] | null,
  };
  const calls: string[] = [];
  const run = async (argv: string[]): Promise<CommandResult> => {
    const line = argv.join(" ");
    calls.push(line);
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "launchctl") {
      switch (argv[1]) {
        case "print": {
          if (state.exiting > 0) {
            state.exiting -= 1;
            if (state.exiting === 0) state.loaded = false;
            return ok(`gui/501/${LAUNCHD_LABEL} = {\n\tstate = SIGTERMed\n}`);
          }
          if (!state.loaded) return { code: 113, stdout: "", stderr: "Could not find service" };
          const args =
            state.args == null
              ? ""
              : `\targuments = {\n${state.args.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n`;
          return ok(
            `gui/501/${LAUNCHD_LABEL} = {\n${args}\tstate = ${state.running ? "running" : "not running"}\n}`,
          );
        }
        case "bootstrap":
          if (state.loaded) {
            return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
          }
          state.loaded = true;
          state.running = true;
          state.args = parseUnitCommand("launchd", readFileSync(argv[3] ?? "", "utf8"));
          return ok();
        case "bootout":
          if (!state.loaded) return { code: 3, stdout: "", stderr: "No such process" };
          state.running = false;
          state.exiting = initial.exitPrints ?? 0;
          if (state.exiting === 0) state.loaded = false;
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

  test("paths with spaces, quotes, backslashes, % and $ render unchanged", () => {
    const quoted = {
      binary: "/Apps/My Tools/decant",
      dbPath: '/data/"q" 100% $HOME\\d.db',
      port: 4123,
    };
    expect(systemdUnit(quoted)).toContain(
      'ExecStart="/Apps/My Tools/decant" "--db" "/data/\\"q\\" 100%% $$HOME\\\\d.db" "serve" "--no-open" "--port" "4123"\n',
    );
    expect(launchdPlist(quoted)).toContain(
      "\t\t<string>/Apps/My Tools/decant</string>\n\t\t<string>--db</string>\n\t\t<string>/data/&quot;q&quot; 100% $HOME\\d.db</string>\n",
    );
  });

  test("control characters in either path are refused in both formats", () => {
    // A newline would end ExecStart and start a directive of the path's choosing.
    const injected = "/data/a.db\nExecStartPre=/bin/touch /tmp/pwned";
    for (const bad of [
      injected,
      "/data/a\r.db",
      "/data/a\t.db",
      "/data/a\u0001.db",
      "/data/a\u007f.db",
    ]) {
      for (const field of ["dbPath", "binary"] as const) {
        const unsafe = { ...spec, [field]: bad };
        expect(() => systemdUnit(unsafe)).toThrow(UnsafeServicePathError);
        expect(() => launchdPlist(unsafe)).toThrow(UnsafeServicePathError);
      }
    }
    expect(() => systemdUnit({ ...spec, dbPath: injected })).toThrow("control character");
    expect(() => launchdPlist(spec, { homeDir: "/Users/a\nb" })).toThrow(UnsafeServicePathError);
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

  test("a path with a newline is refused before anything is written or loaded", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const install = installService(
      { dbPath: "/data/a.db\nRunAtLoad=false", port: 3000 },
      darwinOptions(home, fake.run),
    );
    await expect(install).rejects.toBeInstanceOf(UnsafeServicePathError);
    await expect(install).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(existsSync(unitPath("launchd", { homeDir: home }))).toBe(false);
    expect(fake.calls.every((call) => call.startsWith("launchctl print"))).toBe(true);
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
  test("a path with a newline or carriage return is refused before the unit is written", async () => {
    for (const [dbPath, binary] of [
      ["/data/a.db\nExecStartPre=/bin/touch /tmp/pwned", spec.binary],
      ["/data/a.db\rExecStartPre=/bin/touch /tmp/pwned", spec.binary],
      [spec.dbPath, "/opt/test/decant\nExecStartPre=/bin/touch /tmp/pwned"],
      [spec.dbPath, "/opt/test/decant\r"],
    ] as const) {
      const home = freshHome();
      const fake = fakeManager();
      const options = {
        platform: "linux" as const,
        env: {},
        homeDir: home,
        run: fake.run,
        install: { channel: "installer" as const, binaryPath: binary },
        execPath: binary,
      };
      await expect(installService({ dbPath, port: 3000 }, options)).rejects.toBeInstanceOf(
        UnsafeServicePathError,
      );
      expect(existsSync(unitPath("systemd", options))).toBe(false);
      expect(fake.calls).not.toContain("systemctl --user daemon-reload");
      expect(fake.calls).not.toContain("systemctl --user start decant.service");
    }
  });

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
  const base: BinaryFingerprint = {
    path: "/opt/homebrew/Cellar/decant/0.14.0/bin/decant",
    ino: 100,
    mtimeMs: 1_000,
    size: 5_000,
  };

  test("is false while the same file is in place", () => {
    expect(binaryChanged(base, { ...base })).toBe(false);
  });

  test("is true when Homebrew moves the opt symlink to a new Cellar path", () => {
    expect(
      binaryChanged(base, { ...base, path: "/opt/homebrew/Cellar/decant/0.15.0/bin/decant" }),
    ).toBe(true);
  });

  test("is true when the installer renames a new file over the old one", () => {
    expect(binaryChanged(base, { ...base, ino: 101 })).toBe(true);
  });

  test("is true when the file is rewritten in place", () => {
    expect(binaryChanged(base, { ...base, mtimeMs: 2_000 })).toBe(true);
    expect(binaryChanged(base, { ...base, size: 6_000 })).toBe(true);
  });

  test("is false while the file is missing mid-upgrade", () => {
    expect(binaryChanged(base, null)).toBe(false);
  });

  test("tracks real files through rename, symlink retarget, and in-place writes", () => {
    const dir = join(workDir, "fingerprints");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "decant");
    writeFileSync(file, "v1");
    const first = binaryFingerprint(file);
    if (first == null) throw new Error("fingerprint missing");
    expect(binaryChanged(first, binaryFingerprint(file))).toBe(false);

    // The installer and `decant update`: write a sibling, rename it over.
    writeFileSync(join(dir, "decant.next"), "v2");
    renameSync(join(dir, "decant.next"), file);
    const renamed = binaryFingerprint(file);
    expect(renamed?.ino).not.toBe(first.ino);
    expect(binaryChanged(first, renamed)).toBe(true);

    // Homebrew: the stable link moves to a new Cellar directory.
    for (const version of ["1", "2"]) {
      mkdirSync(join(dir, "Cellar", version), { recursive: true });
      writeFileSync(join(dir, "Cellar", version, "decant"), `brew ${version}`);
    }
    const link = join(dir, "opt-decant");
    symlinkSync(join(dir, "Cellar", "1", "decant"), link);
    const linked = binaryFingerprint(link);
    if (linked == null) throw new Error("fingerprint missing");
    unlinkSync(link);
    symlinkSync(join(dir, "Cellar", "2", "decant"), link);
    expect(binaryChanged(linked, binaryFingerprint(link))).toBe(true);

    // An in-place rewrite keeps the inode but changes size and mtime.
    const before = binaryFingerprint(file);
    if (before == null) throw new Error("fingerprint missing");
    appendFileSync(file, "-patched");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const after = binaryFingerprint(file);
    expect(after?.ino).toBe(before.ino);
    expect(binaryChanged(before, after)).toBe(true);
  });
});

describe("watchBinary", () => {
  const timing = { intervalMs: 20, settleMs: 40 };

  function binaryFile(name: string, body = "v1"): string {
    const dir = join(workDir, "watch-binary");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  }

  test("asks for a restart once after an atomic replacement", async () => {
    const file = binaryFile("atomic");
    let changes = 0;
    const stop = watchBinary(file, () => changes++, timing);
    try {
      await Bun.sleep(80);
      expect(changes).toBe(0);
      writeFileSync(`${file}.next`, "v2");
      renameSync(`${file}.next`, file);
      await waitFor(() => changes > 0);
      await Bun.sleep(150);
      expect(changes).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("ignores a file that disappears and comes back unchanged", async () => {
    const file = binaryFile("transient");
    const original = readFileSync(file);
    const fingerprint = binaryFingerprint(file);
    let changes = 0;
    const stop = watchBinary(file, () => changes++, timing);
    try {
      // Move it away and back: the same inode, size, and mtime return.
      renameSync(file, `${file}.moved`);
      await Bun.sleep(100);
      renameSync(`${file}.moved`, file);
      await Bun.sleep(150);
      expect(binaryFingerprint(file)).toEqual(fingerprint);
      expect(readFileSync(file)).toEqual(original);
      expect(changes).toBe(0);
    } finally {
      stop?.();
    }
  });

  test("waits for a file that is still being written to settle", async () => {
    const file = binaryFile("growing");
    let changes = 0;
    const stop = watchBinary(file, () => changes++, { intervalMs: 20, settleMs: 120 });
    try {
      // Each write lands inside the settle window, so no restart yet.
      for (let index = 0; index < 5; index += 1) {
        appendFileSync(file, `chunk-${index}`);
        await Bun.sleep(50);
        expect(changes).toBe(0);
      }
      await waitFor(() => changes > 0);
      expect(changes).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("compares against the fingerprint taken at startup, not when watching began", async () => {
    const file = binaryFile("replaced-while-waiting");
    const atStart = binaryFingerprint(file);
    // An upgrade lands while the service is still waiting for its port.
    writeFileSync(`${file}.next`, "v2");
    renameSync(`${file}.next`, file);
    let changes = 0;
    const stop = watchBinary(file, () => changes++, { ...timing, initial: atStart });
    try {
      await waitFor(() => changes > 0);
      expect(changes).toBe(1);
    } finally {
      stop?.();
    }
  });

  test("returns null when the binary cannot be read", () => {
    expect(watchBinary(join(workDir, "missing-binary"), () => undefined, timing)).toBeNull();
  });
});

describe("launchd reconfiguration", () => {
  test("reads the arguments launchd actually loaded", () => {
    const printed = [
      `gui/501/${LAUNCHD_LABEL} = {`,
      "\tactive count = 1",
      "\targuments = {",
      "\t\t/Apps/My Tools/decant",
      "\t\t--db",
      "\t\t/data/a.db",
      "\t}",
      "",
      "\tstate = running",
      "\tenvironment = {",
      "\t\tDECANT_SERVICE => 1",
      "\t}",
      "}",
    ].join("\n");
    expect(parseLaunchdArguments(printed)).toEqual(["/Apps/My Tools/decant", "--db", "/data/a.db"]);
    expect(parseLaunchdArguments("state = running")).toBeNull();
  });

  test("a relative archive path is stored as an absolute one", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const status = await installService(
      { dbPath: "relative-archive.db", port: 3000 },
      darwinOptions(home, fake.run),
    );
    expect(status.command?.[2]).toBe(resolve("relative-archive.db"));
    expect(fake.state.args?.[2]).toBe(resolve("relative-archive.db"));
  });

  test("a changed spec reloads a loaded but stopped job instead of kickstarting it", async () => {
    const home = freshHome();
    const fake = fakeManager();
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    // Stopped cleanly with SIGTERM: still loaded, not running.
    fake.state.running = false;
    fake.calls.length = 0;

    const status = await installService({ dbPath: "/data/changed.db", port: 3001 }, options);
    expect(fake.calls).toContain("launchctl bootout gui/501/dev.dosu.decant");
    expect(fake.calls.some((call) => call.startsWith("launchctl bootstrap"))).toBe(true);
    expect(fake.calls).not.toContain("launchctl kickstart gui/501/dev.dosu.decant");
    // What status reports is what launchd runs.
    expect(status).toMatchObject({ running: true, url: "http://127.0.0.1:3001" });
    expect(fake.state.args).toEqual(status.command);
    expect(fake.state.args).toContain("/data/changed.db");
  });

  test("a stale loaded job is reloaded even when the file on disk already matches", async () => {
    const home = freshHome();
    const fake = fakeManager();
    await installService({ dbPath: spec.dbPath, port: 3000 }, darwinOptions(home, fake.run));
    // The service itself wrote a new port, which waits for the next load.
    await installService(
      { dbPath: spec.dbPath, port: 4000 },
      darwinOptions(home, fake.run, { DECANT_SERVICE: "1" }),
    );
    expect(fake.state.args).toContain("3000");

    fake.calls.length = 0;
    const status = await installService(
      { dbPath: spec.dbPath, port: 4000 },
      darwinOptions(home, fake.run),
    );
    expect(fake.calls).toContain("launchctl bootout gui/501/dev.dosu.decant");
    expect(fake.state.args).toEqual(status.command);
    expect(fake.state.args).toContain("4000");
  });

  test("waits for the old process to exit before bootstrapping again", async () => {
    const home = freshHome();
    // launchd keeps the label registered while the old server shuts down.
    const fake = fakeManager({ exitPrints: 3 });
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    fake.calls.length = 0;

    const status = await installService({ dbPath: spec.dbPath, port: 3001 }, options);
    expect(status).toMatchObject({ running: true, url: "http://127.0.0.1:3001" });
    const bootout = fake.calls.indexOf("launchctl bootout gui/501/dev.dosu.decant");
    const bootstrap = fake.calls.findIndex((call) => call.startsWith("launchctl bootstrap"));
    const waits = fake.calls
      .slice(bootout + 1, bootstrap)
      .filter((call) => call.startsWith("launchctl print"));
    // Three reads while it exits, then one that finds it gone.
    expect(waits.length).toBe(4);
  });

  test("stops with a clear error, before bootstrapping, if the job never unloads", async () => {
    const home = freshHome();
    const fake = fakeManager({ exitPrints: 1_000 });
    const options = { ...darwinOptions(home, fake.run), unloadTimeoutMs: 250 };
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    fake.calls.length = 0;

    await expect(installService({ dbPath: spec.dbPath, port: 3001 }, options)).rejects.toThrow(
      "still stopping",
    );
    expect(fake.calls.some((call) => call.startsWith("launchctl bootstrap"))).toBe(false);
  });

  test("a bootstrap that fails for another reason is not retried", async () => {
    const home = freshHome();
    const base = fakeManager();
    let bootstraps = 0;
    const run = async (argv: string[]): Promise<CommandResult> => {
      if (argv[1] === "bootstrap") {
        bootstraps += 1;
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return base.run(argv);
    };
    await expect(
      installService({ dbPath: spec.dbPath, port: 3000 }, darwinOptions(home, run)),
    ).rejects.toThrow("Input/output error");
    expect(bootstraps).toBe(1);
  });

  test("stopService waits until launchd has unloaded the job", async () => {
    const home = freshHome();
    const fake = fakeManager({ exitPrints: 2 });
    const options = darwinOptions(home, fake.run);
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    await stopService(options);
    expect(fake.state.loaded).toBe(false);
  });
});

describe("systemd reconfiguration", () => {
  test("a changed spec starts a stopped unit after daemon-reload", async () => {
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
    await installService({ dbPath: spec.dbPath, port: 3000 }, options);
    fake.state.running = false;
    fake.calls.length = 0;
    await installService({ dbPath: spec.dbPath, port: 3001 }, options);
    expect(fake.calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user is-active decant.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable decant.service",
      "systemctl --user start decant.service",
      "systemctl --user show-environment",
      "systemctl --user is-active decant.service",
    ]);
    expect(readFileSync(unitPath("systemd", options), "utf8")).toContain('"3001"');
  });
});
