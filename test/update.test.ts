import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateDeps } from "../src/cli/context.ts";
import { shouldShowUpdateNotice } from "../src/cli/update-notice.ts";
import { runCli } from "../src/cli.ts";
import { saveSettings } from "../src/settings.ts";
import {
  checkForUpdate,
  checksumFor,
  compareVersions,
  detectInstall,
  type FetchLike,
  isNewerVersion,
  LATEST_VERSION_URL,
  parseVersion,
  planUpdate,
  readUpdateCheck,
  releaseTarget,
  replaceBinary,
  UPDATE_CHECK_INTERVAL_MS,
  updateCheckEnabled,
  updateCheckPath,
} from "../src/update.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-update-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dirCount = 0;
function configEnv(extra: Record<string, string> = {}): Record<string, string> {
  dirCount += 1;
  return { DECANT_CONFIG_DIR: join(workDir, `cfg-${dirCount}`), ...extra };
}

function registry(version: string, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    return Response.json({ name: "@dosu/decant", version });
  };
}

const failingFetch: FetchLike = async () => {
  throw new Error("offline");
};

describe("version comparison", () => {
  test("orders releases and prereleases by semver precedence", () => {
    const ordered = [
      "0.9.9",
      "0.10.0-beta.1",
      "0.10.0-beta.2",
      "0.10.0-beta.10",
      "0.10.0-rc.1",
      "0.10.0",
      "v0.10.1",
      "1.0.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      const older = parseVersion(ordered[index - 1] ?? "");
      const newer = parseVersion(ordered[index] ?? "");
      if (older == null || newer == null) throw new Error("fixture must parse");
      expect(compareVersions(older, newer)).toBeLessThan(0);
      expect(compareVersions(newer, older)).toBeGreaterThan(0);
    }
    expect(isNewerVersion("0.11.0", "0.11.0")).toBe(false);
    expect(isNewerVersion("0.11.0", "dev")).toBe(false);
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("install detection", () => {
  const compiled = (execPath: string, env: Record<string, string> = {}) =>
    detectInstall({ compiled: true, env, execPath, realpath: (path) => path });

  test("maps the real binary path to the tool that owns it", () => {
    expect(detectInstall({ compiled: false }).channel).toBe("source");
    expect(compiled("/usr/local/bin/decant", { DECANT_INSTALL_CHANNEL: "docker" }).channel).toBe(
      "docker",
    );
    expect(compiled("/opt/homebrew/Cellar/decant/0.11.0/bin/decant").channel).toBe("homebrew");
    expect(
      compiled(
        "/opt/homebrew/lib/node_modules/@dosu/decant/node_modules/@dosu/decant-darwin-arm64/bin/decant",
      ).channel,
    ).toBe("npm");
    expect(
      compiled("/Users/me/.npm/_npx/abc/node_modules/@dosu/decant-darwin-arm64/bin/decant").channel,
    ).toBe("npx");
    expect(compiled("/Users/me/app/node_modules/@dosu/decant-linux-x64/bin/decant").channel).toBe(
      "npm-local",
    );
    expect(compiled("/Users/me/.local/bin/decant")).toEqual({
      channel: "installer",
      binaryPath: "/Users/me/.local/bin/decant",
    });
  });

  test("plans the update each channel supports", () => {
    expect(planUpdate({ channel: "npm", binaryPath: null }, "0.12.0")).toEqual({
      kind: "run",
      argv: ["npm", "install", "--global", "@dosu/decant@0.12.0"],
    });
    expect(planUpdate({ channel: "homebrew", binaryPath: null }, "0.12.0")).toEqual({
      kind: "run",
      argv: ["brew", "upgrade", "dosu-ai/dosu/decant"],
    });
    expect(planUpdate({ channel: "installer", binaryPath: "/x/decant" }, "0.12.0")).toEqual({
      kind: "replace",
      binaryPath: "/x/decant",
    });
    for (const channel of ["npx", "npm-local", "docker", "source"] as const) {
      expect(planUpdate({ channel, binaryPath: null }, "0.12.0").kind).toBe("manual");
    }
  });
});

describe("checkForUpdate", () => {
  const install = { channel: "installer", binaryPath: "/x/decant" } as const;
  const now = new Date("2026-10-28T12:00:00Z");

  test("is off by default and never contacts the registry", async () => {
    const env = configEnv();
    const calls: string[] = [];
    const status = await checkForUpdate({
      env,
      install,
      current: "0.11.0",
      fetch: registry("0.12.0", calls),
      now: () => now,
    });
    expect(calls).toEqual([]);
    expect(status).toMatchObject({
      enabled: false,
      envOverride: false,
      latest: null,
      updateAvailable: false,
    });
    expect(existsSync(updateCheckPath({ env }))).toBe(false);
  });

  test("the setting opts in, and the environment overrides it either way", () => {
    const env = configEnv();
    saveSettings({ updateCheck: true }, { env, appExists: () => false });
    expect(updateCheckEnabled({ env })).toBe(true);
    expect(updateCheckEnabled({ env: { ...env, DECANT_UPDATE_CHECK: "0" } })).toBe(false);
    expect(updateCheckEnabled({ env: configEnv({ DECANT_UPDATE_CHECK: "1" }) })).toBe(true);
    saveSettings({ updateCheck: "yes" }, { env, appExists: () => false });
    expect(updateCheckEnabled({ env })).toBe(true);
  });

  test("checks at most once a day once enabled", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const calls: string[] = [];
    const options = { env, install, current: "0.11.0", fetch: registry("0.12.0", calls) };

    const first = await checkForUpdate({ ...options, now: () => now });
    expect(calls).toEqual([LATEST_VERSION_URL]);
    expect(first).toMatchObject({
      enabled: true,
      envOverride: true,
      latest: "0.12.0",
      updateAvailable: true,
      checkedAt: now.toISOString(),
      command: "decant update",
      error: null,
    });

    const later = new Date(now.getTime() + UPDATE_CHECK_INTERVAL_MS - 1);
    expect((await checkForUpdate({ ...options, now: () => later })).updateAvailable).toBe(true);
    expect(calls).toHaveLength(1);

    const nextDay = new Date(now.getTime() + UPDATE_CHECK_INTERVAL_MS);
    await checkForUpdate({ ...options, now: () => nextDay });
    expect(calls).toHaveLength(2);
  });

  test("a failed check keeps the last answer and waits a day to retry", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const base = { env, install, current: "0.11.0" };
    await checkForUpdate({ ...base, fetch: registry("0.12.0"), now: () => now });

    const nextDay = new Date(now.getTime() + UPDATE_CHECK_INTERVAL_MS);
    const failed = await checkForUpdate({ ...base, fetch: failingFetch, now: () => nextDay });
    expect(failed).toMatchObject({ latest: "0.12.0", updateAvailable: true, error: "offline" });
    expect(readUpdateCheck({ env })).toEqual({
      checkedAt: nextDay.toISOString(),
      latest: "0.12.0",
    });

    const calls: string[] = [];
    await checkForUpdate({ ...base, fetch: registry("0.13.0", calls), now: () => nextDay });
    expect(calls).toEqual([]);
  });

  test("hides cached results when checks are off and never nudges a checkout", async () => {
    const env = configEnv();
    await checkForUpdate({
      env,
      install,
      current: "0.11.0",
      fetch: registry("0.12.0"),
      now: () => now,
      force: true,
    });
    const passive = await checkForUpdate({ env, install, current: "0.11.0", now: () => now });
    expect(passive).toMatchObject({ latest: null, updateAvailable: false });

    const checkout = await checkForUpdate({
      env,
      install: { channel: "source", binaryPath: null },
      current: "v0.11.0-4-gabc1234",
      fetch: registry("0.12.0"),
      now: () => now,
      force: true,
    });
    expect(checkout).toMatchObject({ latest: "0.12.0", updateAvailable: false });

    const calls: string[] = [];
    await checkForUpdate({
      env: configEnv({ DECANT_UPDATE_CHECK: "1" }),
      install: { channel: "source", binaryPath: null },
      current: "v0.11.0-4-gabc1234",
      fetch: registry("0.12.0", calls),
      now: () => now,
    });
    expect(calls).toEqual([]);
  });

  test("keeps the daily limit when the cache file cannot be written", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const dir = env.DECANT_CONFIG_DIR ?? "";
    mkdirSync(dir, { recursive: true });
    // A day-old answer the process can read but never replace, as under a
    // read-only bind mount.
    const stale = new Date(now.getTime() - 2 * UPDATE_CHECK_INTERVAL_MS).toISOString();
    writeFileSync(updateCheckPath({ env }), JSON.stringify({ checkedAt: stale, latest: "0.11.5" }));
    chmodSync(dir, 0o500);
    try {
      const calls: string[] = [];
      const options = { env, install, current: "0.11.0", fetch: registry("0.12.0", calls) };
      await checkForUpdate({ ...options, now: () => now });
      const second = await checkForUpdate({ ...options, now: () => now });
      expect(calls).toHaveLength(1);
      expect(second).toMatchObject({ latest: "0.12.0", updateAvailable: true });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("checks again when the cache is dated in the future", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const future = new Date(now.getTime() + 30 * UPDATE_CHECK_INTERVAL_MS).toISOString();
    mkdirSync(env.DECANT_CONFIG_DIR ?? "", { recursive: true });
    writeFileSync(
      updateCheckPath({ env }),
      JSON.stringify({ checkedAt: future, latest: "0.11.5" }),
    );
    const calls: string[] = [];
    const status = await checkForUpdate({
      env,
      install,
      current: "0.11.0",
      fetch: registry("0.12.0", calls),
      now: () => now,
    });
    expect(calls).toHaveLength(1);
    expect(status).toMatchObject({ latest: "0.12.0", checkedAt: now.toISOString() });
  });

  test("stores the registry version trimmed and rejects anything else", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const base = { env, install, current: "0.11.0", now: () => now, force: true };
    expect(await checkForUpdate({ ...base, fetch: registry(" 0.12.0\n") })).toMatchObject({
      latest: "0.12.0",
      error: null,
    });
    expect(readUpdateCheck({ env })?.latest).toBe("0.12.0");

    const bad = await checkForUpdate({ ...base, fetch: registry("0.13.0/../../x") });
    expect(bad).toMatchObject({ latest: "0.12.0" });
    expect(bad.error).toContain("did not return a valid version");

    writeFileSync(
      updateCheckPath({ env }),
      JSON.stringify({ checkedAt: now.toISOString(), latest: "0.13.0?x=1" }),
    );
    expect(readUpdateCheck({ env })?.latest).toBeNull();
  });

  test("concurrent checks share one registry request", async () => {
    const env = configEnv({ DECANT_UPDATE_CHECK: "1" });
    const calls: string[] = [];
    const slow: FetchLike = async (url) => {
      calls.push(url);
      await Bun.sleep(20);
      return Response.json({ version: "0.12.0" });
    };
    const options = { env, install, current: "0.11.0", fetch: slow, now: () => now };
    const [first, second] = await Promise.all([checkForUpdate(options), checkForUpdate(options)]);
    expect(calls).toHaveLength(1);
    expect(first.latest).toBe("0.12.0");
    expect(second.latest).toBe("0.12.0");
  });
});

describe("replaceBinary", () => {
  const target = releaseTarget();
  const tarballName = `${target}.tar.gz`;

  function release(version: string): { tarball: Uint8Array<ArrayBuffer>; sums: string } {
    const buildDir = mkdtempSync(join(workDir, "build-"));
    writeFileSync(join(buildDir, "decant"), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(buildDir, "decant"), 0o755);
    const tarballPath = join(buildDir, tarballName);
    expect(spawnSync("tar", ["-czf", tarballPath, "-C", buildDir, "decant"]).status).toBe(0);
    const tarball = new Uint8Array(readFileSync(tarballPath));
    const hash = createHash("sha256").update(tarball).digest("hex");
    return { tarball, sums: `${"0".repeat(64)}  other.tar.gz\n${hash}  ${tarballName}\n` };
  }

  function releaseServer(
    files: Record<string, Uint8Array<ArrayBuffer> | string>,
    calls: string[],
  ): FetchLike {
    return async (url) => {
      calls.push(url);
      const name = url.slice(url.lastIndexOf("/") + 1);
      const body = files[name];
      return body == null ? new Response("missing", { status: 404 }) : new Response(body);
    };
  }

  function installed(): string {
    const dir = mkdtempSync(join(workDir, "bin-"));
    const binaryPath = join(dir, "decant");
    writeFileSync(binaryPath, "#!/bin/sh\necho 0.11.0\n");
    chmodSync(binaryPath, 0o755);
    return binaryPath;
  }

  test("verifies the checksum and swaps the binary in place", async () => {
    const binaryPath = installed();
    const { tarball, sums } = release("0.12.0");
    const calls: string[] = [];
    await replaceBinary({
      binaryPath,
      version: "0.12.0",
      baseUrl: "https://mirror.example/releases/",
      fetch: releaseServer({ [tarballName]: tarball, SHA256SUMS: sums }, calls),
    });
    expect(calls.sort()).toEqual([
      "https://mirror.example/releases/download/v0.12.0/SHA256SUMS",
      `https://mirror.example/releases/download/v0.12.0/${tarballName}`,
    ]);
    expect(spawnSync(binaryPath, [], { encoding: "utf8" }).stdout.trim()).toBe("0.12.0");
    expect(readdirSync(join(binaryPath, ".."))).toEqual(["decant"]);
  });

  test("leaves the old binary alone when verification fails", async () => {
    const binaryPath = installed();
    const good = release("0.12.0");
    const tampered = new Uint8Array([...good.tarball, 0]);
    await expect(
      replaceBinary({
        binaryPath,
        version: "0.12.0",
        fetch: releaseServer({ [tarballName]: tampered, SHA256SUMS: good.sums }, []),
      }),
    ).rejects.toThrow("checksum mismatch");

    const mislabeled = release("0.11.5");
    await expect(
      replaceBinary({
        binaryPath,
        version: "0.12.0",
        fetch: releaseServer(
          { [tarballName]: mislabeled.tarball, SHA256SUMS: mislabeled.sums },
          [],
        ),
      }),
    ).rejects.toThrow("reports 0.11.5, expected 0.12.0");

    expect(readFileSync(binaryPath, "utf8")).toContain("echo 0.11.0");
    expect(readdirSync(join(binaryPath, ".."))).toEqual(["decant"]);
  });

  test("decant update swaps a standalone binary from DECANT_BASE_URL", async () => {
    const binaryPath = installed();
    const { tarball, sums } = release("0.12.0");
    const calls: string[] = [];
    const releases = releaseServer({ [tarballName]: tarball, SHA256SUMS: sums }, calls);
    const result = await runCli(["update"], {
      env: configEnv({ DECANT_BASE_URL: "https://mirror.example/releases" }),
      update: {
        current: "0.11.0",
        install: { channel: "installer", binaryPath },
        fetch: (url, init) =>
          url === LATEST_VERSION_URL ? registry("0.12.0")(url) : releases(url, init),
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Downloading Decant v0.12.0...\nUpdated Decant to v0.12.0.\n");
    expect(calls).toContain(`https://mirror.example/releases/download/v0.12.0/${tarballName}`);
    expect(readFileSync(binaryPath, "utf8")).toContain("echo 0.12.0");
  });

  test("explains a release that npm has but GitHub does not yet", async () => {
    const binaryPath = installed();
    await expect(
      replaceBinary({ binaryPath, version: "0.12.0", fetch: releaseServer({}, []) }),
    ).rejects.toThrow("v0.12.0 is not on the release page yet");
    expect(readFileSync(binaryPath, "utf8")).toContain("echo 0.11.0");
  });

  test("refuses a version that is not a release before downloading", async () => {
    const binaryPath = installed();
    const calls: string[] = [];
    await expect(
      replaceBinary({ binaryPath, version: "0.12.0/../x", fetch: releaseServer({}, calls) }),
    ).rejects.toThrow("not a release version");
    expect(calls).toEqual([]);
  });

  test("rejects a release whose decant entry is a symlink", async () => {
    const binaryPath = installed();
    const outside = join(workDir, "outside.txt");
    writeFileSync(outside, "not decant\n", { mode: 0o644 });
    const buildDir = mkdtempSync(join(workDir, "build-"));
    symlinkSync(outside, join(buildDir, "decant"));
    const tarballPath = join(buildDir, tarballName);
    expect(spawnSync("tar", ["-czf", tarballPath, "-C", buildDir, "decant"]).status).toBe(0);
    const tarball = new Uint8Array(readFileSync(tarballPath));
    const hash = createHash("sha256").update(tarball).digest("hex");

    await expect(
      replaceBinary({
        binaryPath,
        version: "0.12.0",
        fetch: releaseServer(
          { [tarballName]: tarball, SHA256SUMS: `${hash}  ${tarballName}\n` },
          [],
        ),
      }),
    ).rejects.toThrow("did not contain a decant binary");
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(readFileSync(binaryPath, "utf8")).toContain("echo 0.11.0");
  });

  test("reads checksums in both sha256sum and shasum binary-mode formats", () => {
    const hash = "a".repeat(64);
    expect(checksumFor(`${hash} *decant-linux-x64.tar.gz\n`, "decant-linux-x64.tar.gz")).toBe(hash);
    expect(checksumFor(`${hash}  decant-linux-x64.tar.gz`, "decant-darwin-x64.tar.gz")).toBeNull();
  });
});

describe("decant update", () => {
  const cli = (args: string[], deps: UpdateDeps = {}) =>
    runCli(args, {
      env: configEnv(),
      update: { current: "0.11.0", installedOnPath: () => null, ...deps },
    });

  test("--check reports a newer release without installing it", async () => {
    const commands: string[][] = [];
    const result = await cli(["update", "--check"], {
      install: { channel: "npm", binaryPath: null },
      fetch: registry("0.12.0"),
      runCommand: (argv) => {
        commands.push(argv);
        return 0;
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "Decant v0.12.0 is available (you have v0.11.0). Run: decant update\n",
    );
    expect(commands).toEqual([]);
  });

  test("hands npm and Homebrew installs to their package manager", async () => {
    const commands: string[][] = [];
    const brew = (onPath: string) =>
      cli(["update"], {
        install: { channel: "homebrew", binaryPath: null },
        fetch: registry("0.12.0"),
        runCommand: (argv) => {
          commands.push(argv);
          return 0;
        },
        installedOnPath: () => ({ path: "/opt/homebrew/bin/decant", version: onPath }),
      });
    const result = await brew("0.12.0");
    expect(result.code).toBe(0);
    expect(commands).toEqual([["brew", "upgrade", "dosu-ai/dosu/decant"]]);
    expect(result.stdout).toContain("Updated Decant to v0.12.0.");

    // The tap trails npm, so brew can exit 0 without installing anything.
    const behind = await brew("0.11.0");
    expect(behind.code).toBe(1);
    expect(behind.stdout).not.toContain("Updated Decant");
    expect(behind.stderr).toContain(
      "error: brew finished, but /opt/homebrew/bin/decant reports 0.11.0, not 0.12.0.",
    );

    const failed = await cli(["update"], {
      install: { channel: "npm", binaryPath: null },
      fetch: registry("0.12.0"),
      runCommand: () => 243,
    });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe("error: npm exited with code 243\n");
  });

  test("says so when already current, prints instructions for Docker, and fails offline", async () => {
    const current = await cli(["update"], {
      install: { channel: "npm", binaryPath: null },
      fetch: registry("0.11.0"),
    });
    expect(current.stdout).toBe("Decant v0.11.0 is up to date.\n");

    const docker = await cli(["--json", "update"], {
      install: { channel: "docker", binaryPath: null },
      fetch: registry("0.12.0"),
    });
    expect(JSON.parse(docker.stdout)).toMatchObject({
      updated: false,
      latest: "0.12.0",
      instructions: expect.stringContaining("docker pull ghcr.io/dosu-ai/decant:latest"),
    });

    const offline = await cli(["update"], {
      install: { channel: "npm", binaryPath: null },
      fetch: failingFetch,
    });
    expect(offline.code).toBe(1);
    expect(offline.stderr).toBe("error: could not check for updates: offline\n");
  });

  test("the passive notice prints after a command only when the user opted in", async () => {
    const dbPath = join(workDir, "notice.db");
    const calls: string[] = [];
    const ls = (env: Record<string, string>, flags: string[] = []) =>
      runCli(["--db", dbPath, "--no-sync", ...flags, "ls"], {
        env,
        update: {
          current: "0.11.0",
          install: { channel: "npm", binaryPath: null },
          fetch: registry("0.12.0", calls),
          stderrIsTTY: true,
        },
      });

    const off = await ls(configEnv());
    expect(off.code).toBe(0);
    expect(off.stderr).toBe("");
    expect(calls).toEqual([]);

    const on = await ls(configEnv({ DECANT_UPDATE_CHECK: "1" }));
    expect(on.code).toBe(0);
    expect(on.stderr).toBe(
      "\nDecant v0.12.0 is available (you have v0.11.0). Run: decant update\n",
    );
    expect(calls).toHaveLength(1);

    const json = await ls(configEnv({ DECANT_UPDATE_CHECK: "1" }), ["--json"]);
    expect(json.stderr).toBe("");
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(calls).toHaveLength(1);
  });
});

test("decant update refuses a cached version when the check fails", async () => {
  const env = configEnv();
  const commands: string[][] = [];
  const update: UpdateDeps = {
    current: "0.11.0",
    install: { channel: "npm", binaryPath: null },
    installedOnPath: () => null,
    runCommand: (argv) => {
      commands.push(argv);
      return 0;
    },
  };
  await runCli(["update", "--check"], { env, update: { ...update, fetch: registry("0.12.0") } });

  for (const args of [["update"], ["update", "--check"]]) {
    const offline = await runCli(args, { env, update: { ...update, fetch: failingFetch } });
    expect(offline.code).toBe(1);
    expect(offline.stderr).toBe("error: could not check for updates: offline\n");
  }
  expect(commands).toEqual([]);
});

describe("shouldShowUpdateNotice", () => {
  const person = { command: "ls", json: false, quiet: false, stderrIsTTY: true, env: {} };

  test("speaks only to a person at a terminal", () => {
    expect(shouldShowUpdateNotice(person)).toBe(true);
    expect(shouldShowUpdateNotice({ ...person, command: "serve" })).toBe(true);
    for (const silent of [
      { json: true },
      { quiet: true },
      { stderrIsTTY: false },
      { env: { CI: "true" } },
      { command: "update" },
      { command: "completion" },
      { command: "watch" },
    ]) {
      expect(shouldShowUpdateNotice({ ...person, ...silent })).toBe(false);
    }
  });
});
