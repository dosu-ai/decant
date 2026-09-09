import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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

// End-to-end coverage for install.sh that never touches the network: a fake
// `curl` (and a fake `gh`, so the best-effort attestation step can't reach out
// even if the real `gh` happens to be installed and earlier on PATH) serve
// pre-built fixture files from a temp dir based on the requested URL.

const installShPath = join(import.meta.dir, "..", "install.sh");

const workDir = mkdtempSync(join(tmpdir(), "decant-install-sh-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function caseDir(): string {
  return mkdtempSync(join(workDir, "case-"));
}

function hostTarget(): string {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (os == null || arch == null) {
    throw new Error(
      `install.sh tests require a darwin/linux x64/arm64 host, got ${process.platform}/${process.arch}`,
    );
  }
  return `${os}-${arch}`;
}

const tarballName = `decant-${hostTarget()}.tar.gz`;

interface Fixture {
  fixtureDir: string;
  tarballPath: string;
  sumsPath: string;
  binaryContents: string;
}

/** Builds a real decant-<target>.tar.gz (decant + LICENSE + NOTICE) plus a matching SHA256SUMS. */
function buildFixture(dir: string, binaryContents: string): Fixture {
  const payloadDir = join(dir, "payload");
  mkdirSync(payloadDir, { recursive: true });
  const binaryPath = join(payloadDir, "decant");
  writeFileSync(binaryPath, binaryContents);
  chmodSync(binaryPath, 0o755);
  writeFileSync(join(payloadDir, "LICENSE"), "fixture license\n");
  writeFileSync(join(payloadDir, "NOTICE"), "fixture notice\n");

  const fixtureDir = join(dir, "fixture");
  mkdirSync(fixtureDir, { recursive: true });
  const tarballPath = join(fixtureDir, tarballName);
  const tar = spawnSync(
    "tar",
    ["-czf", tarballPath, "-C", payloadDir, "decant", "LICENSE", "NOTICE"],
    {
      encoding: "utf8",
    },
  );
  if (tar.status !== 0) {
    throw new Error(`failed to build fixture tarball: ${tar.stderr || tar.error}`);
  }

  const hash = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  const sumsPath = join(fixtureDir, "SHA256SUMS");
  writeFileSync(sumsPath, `${hash}  ${tarballName}\n`);

  return { fixtureDir, tarballPath, sumsPath, binaryContents };
}

function writeStub(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

/**
 * A stub bin dir with a fake `curl` (serves fixture files by URL basename and
 * logs every requested URL to CURL_LOG) and a fake `gh` that always reports
 * attestation as unavailable, exercising install.sh's warn-don't-fail path
 * deterministically and offline.
 */
function buildStubBinDir(dir: string): { binDir: string; curlLog: string } {
  const binDir = join(dir, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const curlLog = join(dir, "curl.log");

  writeStub(
    join(binDir, "curl"),
    `#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [ -n "\${CURL_LOG:-}" ]; then
  printf '%s\\n' "$url" >> "$CURL_LOG"
fi
base=$(basename "$url")
src="\${FIXTURE_DIR:-}/$base"
if [ ! -f "$src" ]; then
  echo "fake curl: no fixture for $url (looked for $src)" >&2
  exit 1
fi
cp "$src" "$out"
`,
  );

  writeStub(
    join(binDir, "gh"),
    `#!/bin/sh
exit 1
`,
  );

  return { binDir, curlLog };
}

/** A stub bin dir with just a fake `uname`, for exercising the platform-detect abort paths. */
function buildFakeUnameDir(dir: string, unameS: string, unameM: string): string {
  const binDir = join(dir, "uname-bin");
  mkdirSync(binDir, { recursive: true });
  writeStub(
    join(binDir, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "${unameS}" ;;
  -m) printf '%s\\n' "${unameM}" ;;
  *) exit 1 ;;
esac
`,
  );
  return binDir;
}

/**
 * An isolated bin dir holding symlinks to every host tool install.sh needs —
 * but no `curl` (and no `gh`) — so PATH can be pinned to exactly this dir to
 * exercise the wget-fallback and no-downloader paths hermetically. The fake
 * `wget` mirrors the fake `curl`: it serves fixture files by URL basename and
 * logs each requested URL to WGET_LOG.
 */
function buildToolFarm(
  dir: string,
  options: { wget: boolean },
): { binDir: string; wgetLog: string } {
  const binDir = join(dir, "tool-farm");
  mkdirSync(binDir, { recursive: true });
  const wgetLog = join(dir, "wget.log");

  const tools = [
    "sh",
    "uname",
    "mktemp",
    "tar",
    "install",
    "mkdir",
    "rm",
    "grep",
    "awk",
    "dirname",
    "basename",
    "gzip",
  ];
  const hashTool =
    spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0 ? "sha256sum" : "shasum";
  tools.push(hashTool);
  for (const tool of tools) {
    const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    const toolPath = resolved.stdout.trim();
    if (resolved.status !== 0 || toolPath === "") {
      throw new Error(`buildToolFarm: required host tool not found: ${tool}`);
    }
    symlinkSync(toolPath, join(binDir, tool));
  }

  if (options.wget) {
    writeStub(
      join(binDir, "wget"),
      `#!/bin/sh
set -eu
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -O)
      out="$2"
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
if [ -n "\${WGET_LOG:-}" ]; then
  printf '%s\\n' "$url" >> "$WGET_LOG"
fi
base=$(basename "$url")
src="\${FIXTURE_DIR:-}/$base"
if [ ! -f "$src" ]; then
  echo "fake wget: no fixture for $url (looked for $src)" >&2
  exit 1
fi
cp "$src" "$out"
`,
    );
    // the fake wget itself shells out to basename/cp — cp isn't needed by
    // install.sh, so link it just for the stub
    const cp = spawnSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(cp, join(binDir, "cp"));
  }

  return { binDir, wgetLog };
}

function decantTempEntries(): Set<string> {
  const base = process.env.TMPDIR ?? "/tmp";
  try {
    return new Set(readdirSync(base).filter((name) => name.startsWith("decant-install.")));
  } catch {
    return new Set();
  }
}

function runInstall(
  args: string[],
  envOverrides: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", [installShPath, ...args], {
    encoding: "utf8",
    // SHELL is pinned so rc-file detection is hermetic regardless of the
    // developer's login shell; individual tests can still override it.
    env: { ...process.env, SHELL: "/bin/bash", ...envOverrides },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function freshHome(dir: string): string {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

const shellcheckAvailable = spawnSync("sh", ["-c", "command -v shellcheck"]).status === 0;
if (!shellcheckAvailable) {
  console.warn("install.sh test: shellcheck not found on PATH; skipping the shellcheck lint test");
}

describe("install.sh", () => {
  test("passes a POSIX sh syntax check", () => {
    const result = spawnSync("sh", ["-n", installShPath], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test.skipIf(!shellcheckAvailable)("is shellcheck-clean under `shellcheck -s sh`", () => {
    const result = spawnSync("shellcheck", ["-s", "sh", installShPath], { encoding: "utf8" });
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  test("installs the verified binary for a pinned version without touching PATH files", () => {
    const dir = caseDir();
    const fixture = buildFixture(
      dir,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "decant 1.2.3-fixture"\nfi\n',
    );
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);
    const tempBefore = decantTempEntries();

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(0);

    const installedBinary = join(installDir, "decant");
    expect(existsSync(installedBinary)).toBe(true);
    expect(readFileSync(installedBinary, "utf8")).toBe(fixture.binaryContents);
    expect(statSync(installedBinary).mode & 0o777).toBe(0o755);
    expect(existsSync(join(installDir, "LICENSE"))).toBe(false);
    expect(existsSync(join(installDir, "NOTICE"))).toBe(false);

    // final friendly message ran the freshly installed binary's --version
    expect(result.stdout).toContain("decant 1.2.3-fixture");

    // DECANT_NO_MODIFY_PATH=1 prints the export line instead of editing any rc file
    expect(result.stdout).toContain(`export PATH="${installDir}:$PATH"`);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
    expect(existsSync(join(home, ".profile"))).toBe(false);

    // best-effort attestation used the stub `gh` (which always fails) and warned, not failed
    expect(result.stderr).toContain("attestation verification did not succeed");

    // exact URLs requested, matching the pinned-version download shape
    const requestedUrls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(requestedUrls).toEqual([
      `https://github.com/dosu-ai/decant/releases/download/v1.2.3/${tarballName}`,
      "https://github.com/dosu-ai/decant/releases/download/v1.2.3/SHA256SUMS",
    ]);

    // the mktemp working directory was cleaned up by the EXIT trap
    const tempAfter = decantTempEntries();
    expect([...tempAfter].filter((name) => !tempBefore.has(name))).toEqual([]);
  });

  test("accepts a version with a leading v and resolves the identical pinned URL", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["v1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(0);
    const requestedUrls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(requestedUrls[0]).toBe(
      `https://github.com/dosu-ai/decant/releases/download/v1.2.3/${tarballName}`,
    );
  });

  test("defaults to the latest release when no version is given", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall([], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(0);
    const requestedUrls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(requestedUrls).toEqual([
      `https://github.com/dosu-ai/decant/releases/latest/download/${tarballName}`,
      "https://github.com/dosu-ai/decant/releases/latest/download/SHA256SUMS",
    ]);
  });

  test("falls back to DECANT_VERSION when no positional version is given", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall([], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      DECANT_VERSION: "1.2.3",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(0);
    const requestedUrls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(requestedUrls[0]).toBe(
      `https://github.com/dosu-ai/decant/releases/download/v1.2.3/${tarballName}`,
    );
  });

  test("appends a single guarded PATH line to the shell rc file and stays idempotent on re-install", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);
    const rcFile = join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");

    const envForRun = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      SHELL: "/bin/bash",
      DECANT_INSTALL_DIR: installDir,
      DECANT_VERSION: "1.2.3",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    };

    const first = runInstall([], envForRun);
    expect(first.status).toBe(0);
    expect(existsSync(rcFile)).toBe(true);
    const afterFirst = readFileSync(rcFile, "utf8");
    expect(afterFirst).toContain(`export PATH="${installDir}:$PATH"`);
    expect(afterFirst).toContain("# added by decant install.sh");

    const second = runInstall([], envForRun);
    expect(second.status).toBe(0);
    const afterSecond = readFileSync(rcFile, "utf8");
    const markerCount = afterSecond.split("# added by decant install.sh").length - 1;
    expect(markerCount).toBe(1);
  });

  test("aborts with a non-zero exit and installs nothing when the tarball is corrupted", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    // Tamper the tarball bytes in place; SHA256SUMS still reflects the original.
    const goodBytes = readFileSync(fixture.tarballPath);
    writeFileSync(fixture.tarballPath, Buffer.concat([goodBytes, Buffer.from("corruption")]));

    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);
    const tempBefore = decantTempEntries();

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(existsSync(join(installDir, "decant"))).toBe(false);

    const tempAfter = decantTempEntries();
    expect([...tempAfter].filter((name) => !tempBefore.has(name))).toEqual([]);
  });

  test("aborts with a clear message when SHA256SUMS has no matching entry", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    writeFileSync(fixture.sumsPath, "deadbeef  some-other-file.tar.gz\n");

    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no SHA256SUMS entry");
    expect(existsSync(join(installDir, "decant"))).toBe(false);
  });

  test("aborts with a clear message on an unsupported OS", () => {
    const dir = caseDir();
    const unameDir = buildFakeUnameDir(dir, "Windows_NT", "x86_64");
    const home = freshHome(dir);

    const result = runInstall([], {
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      HOME: home,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported OS 'Windows_NT'");
    expect(result.stderr).toContain(
      "decant-darwin-arm64, decant-darwin-x64, decant-linux-arm64, decant-linux-x64",
    );
  });

  test("aborts with a clear message on an unsupported architecture", () => {
    const dir = caseDir();
    const unameDir = buildFakeUnameDir(dir, "Linux", "riscv64");
    const home = freshHome(dir);

    const result = runInstall([], {
      PATH: `${unameDir}:${process.env.PATH ?? ""}`,
      HOME: home,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported architecture 'riscv64'");
  });

  test("honors DECANT_BASE_URL as the download base (file:// mirror, real curl)", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, '#!/bin/sh\necho "decant 9.9.9-mirror"\n');
    // Lay the mirror out exactly like GitHub Releases: <base>/download/v<ver>/<asset>
    const mirrorRoot = join(dir, "mirror");
    const assetDir = join(mirrorRoot, "download", "v9.9.9");
    mkdirSync(assetDir, { recursive: true });
    copyFileSync(fixture.tarballPath, join(assetDir, tarballName));
    copyFileSync(fixture.sumsPath, join(assetDir, "SHA256SUMS"));

    // Only `gh` is stubbed (attestation must stay offline); curl is the real one.
    const ghDir = join(dir, "gh-bin");
    mkdirSync(ghDir, { recursive: true });
    writeStub(join(ghDir, "gh"), "#!/bin/sh\nexit 1\n");

    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["9.9.9"], {
      PATH: `${ghDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_BASE_URL: `file://${mirrorRoot}`,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
    });

    expect(result.stderr).not.toContain("error:");
    expect(result.status).toBe(0);
    const installedBinary = join(installDir, "decant");
    expect(existsSync(installedBinary)).toBe(true);
    expect(readFileSync(installedBinary, "utf8")).toBe(fixture.binaryContents);
    expect(result.stdout).toContain("checksum verified");
  });

  test("falls back to wget when curl is absent", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, '#!/bin/sh\necho "decant 1.2.3-wget"\n');
    const farm = buildToolFarm(dir, { wget: true });
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["1.2.3"], {
      PATH: farm.binDir,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      WGET_LOG: farm.wgetLog,
    });

    expect(result.stderr).not.toContain("error:");
    expect(result.status).toBe(0);
    const installedBinary = join(installDir, "decant");
    expect(readFileSync(installedBinary, "utf8")).toBe(fixture.binaryContents);
    const requestedUrls = readFileSync(farm.wgetLog, "utf8").trim().split("\n");
    expect(requestedUrls).toEqual([
      `https://github.com/dosu-ai/decant/releases/download/v1.2.3/${tarballName}`,
      "https://github.com/dosu-ai/decant/releases/download/v1.2.3/SHA256SUMS",
    ]);
  });

  test("strips a trailing slash from DECANT_BASE_URL", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      DECANT_BASE_URL: "https://mirror.example.com/decant/releases/",
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(0);
    const requestedUrls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(requestedUrls[0]).toBe(
      `https://mirror.example.com/decant/releases/download/v1.2.3/${tarballName}`,
    );
    for (const url of requestedUrls) {
      expect(url.replace("https://", "")).not.toContain("//");
    }
  });

  test("re-running with a different DECANT_INSTALL_DIR appends a second PATH entry", () => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir } = buildStubBinDir(dir);
    const home = freshHome(dir);
    // install.sh picks .bash_profile for bash on Darwin, .bashrc elsewhere
    const rcFile = join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
    writeFileSync(rcFile, "# existing content\n");

    const common = {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: home,
      SHELL: "/bin/bash",
      FIXTURE_DIR: fixture.fixtureDir,
    };
    const first = runInstall(["1.2.3"], { ...common, DECANT_INSTALL_DIR: join(dir, "bin-a") });
    expect(first.status).toBe(0);
    const second = runInstall(["1.2.3"], { ...common, DECANT_INSTALL_DIR: join(dir, "bin-b") });
    expect(second.status).toBe(0);

    const rc = readFileSync(rcFile, "utf8");
    expect(rc).toContain(`export PATH="${join(dir, "bin-a")}:$PATH"`);
    expect(rc).toContain(`export PATH="${join(dir, "bin-b")}:$PATH"`);
    // and a same-dir re-run stays deduplicated
    const third = runInstall(["1.2.3"], { ...common, DECANT_INSTALL_DIR: join(dir, "bin-b") });
    expect(third.status).toBe(0);
    const rcAfter = readFileSync(rcFile, "utf8");
    expect(rcAfter.split(`export PATH="${join(dir, "bin-b")}:$PATH"`).length - 1).toBe(1);
  });

  test("errors clearly when neither curl nor wget is on PATH", () => {
    const dir = caseDir();
    const farm = buildToolFarm(dir, { wget: false });
    const installDir = join(dir, "install-target");
    const home = freshHome(dir);

    const result = runInstall(["1.2.3"], {
      PATH: farm.binDir,
      HOME: home,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("curl or wget is required");
    expect(existsSync(join(installDir, "decant"))).toBe(false);
  });
});
