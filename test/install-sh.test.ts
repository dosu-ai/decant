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
// `curl` serves pre-built fixture files from a temp dir based on the requested
// URL, and a fake `gh` stands in for the attestation check so it can't reach
// out even if the real `gh` happens to be installed and earlier on PATH.

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
 * logs every requested URL to CURL_LOG) and a fake `gh`. The fake `gh` logs its
 * arguments to GH_LOG; `gh auth token` succeeds only when FAKE_GH_AUTH=ok and
 * `gh attestation verify` only when FAKE_GH_VERIFY=ok, so by default it acts
 * like a logged-out gh.
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
    --proto-redir)
      if [ -n "\${CURL_PROTO_REDIR_LOG:-}" ]; then
        printf '%s\\n' "$2" >> "$CURL_PROTO_REDIR_LOG"
      fi
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

  writeStub(join(binDir, "gh"), FAKE_GH);

  return { binDir, curlLog };
}

const FAKE_GH = `#!/bin/sh
if [ -n "\${GH_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$GH_LOG"
fi
case "$1" in
  auth) [ "$2" = token ] && [ "\${FAKE_GH_AUTH:-}" = ok ] && echo gho_fake ;;
  attestation)
    if [ "\${FAKE_GH_OLD:-}" = 1 ]; then
      echo 'unknown command "attestation" for "gh"' >&2
      exit 1
    fi
    [ "$2" = --help ] && exit 0
    if [ "\${FAKE_GH_VERIFY:-}" = ok ]; then
      echo "fake gh: verification succeeded"
    else
      echo "fake gh: no matching attestation found" >&2
      exit 1
    fi
    ;;
  *) exit 1 ;;
esac
`;

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
# What wget -S prints to stderr, such as a redirect's Location header.
if [ -n "\${WGET_HEADERS:-}" ]; then
  printf '%s\\n' "$WGET_HEADERS" >&2
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
    env: {
      ...process.env,
      SHELL: "/bin/bash",
      DECANT_SKIP_ATTESTATION: undefined,
      ...envOverrides,
    },
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

    // the stub `gh` is logged out, so the attestation check was skipped, not failed
    expect(result.stdout).toContain(
      "skipped the attestation check: gh is not installed or not logged in to github.com",
    );

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

  describe("attestation check with a logged-in gh", () => {
    function installWithGh(env: Record<string, string>) {
      const dir = caseDir();
      const fixture = buildFixture(dir, '#!/bin/sh\necho "decant 1.2.3-attested"\n');
      const { binDir, curlLog } = buildStubBinDir(dir);
      const installDir = join(dir, "install-target");
      const ghLog = join(dir, "gh.log");
      const tempBefore = decantTempEntries();
      const result = runInstall(["1.2.3"], {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: freshHome(dir),
        DECANT_INSTALL_DIR: installDir,
        DECANT_NO_MODIFY_PATH: "1",
        FIXTURE_DIR: fixture.fixtureDir,
        CURL_LOG: curlLog,
        GH_LOG: ghLog,
        FAKE_GH_AUTH: "ok",
        ...env,
      });
      const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : [];
      const leftovers = [...decantTempEntries()].filter((name) => !tempBefore.has(name));
      return { result, installedBinary: join(installDir, "decant"), ghCalls, leftovers };
    }

    test("installs after gh verifies the tarball against this repository", () => {
      const { result, installedBinary, ghCalls } = installWithGh({ FAKE_GH_VERIFY: "ok" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("attestation verified");
      expect(existsSync(installedBinary)).toBe(true);
      expect(ghCalls[0]).toBe("auth token --hostname github.com");
      expect(ghCalls[1]).toBe("attestation --help");
      expect(ghCalls[2]).toMatch(
        new RegExp(
          `^attestation verify .*/${tarballName.replaceAll(".", "\\.")} -R dosu-ai/decant$`,
        ),
      );
    });

    test("aborts and installs nothing when gh cannot verify the tarball", () => {
      const { result, installedBinary, leftovers } = installWithGh({ FAKE_GH_VERIFY: "fail" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fake gh: no matching attestation found");
      expect(result.stderr).toContain(
        `decant install: error: attestation verification failed for ${tarballName}, so it was not installed.`,
      );
      expect(result.stderr).toContain("docs/distribution.md#shell-installer");
      expect(existsSync(installedBinary)).toBe(false);
      expect(leftovers).toEqual([]);
    });

    test("DECANT_SKIP_ATTESTATION=1 skips gh entirely and warns", () => {
      const { result, installedBinary, ghCalls } = installWithGh({
        FAKE_GH_VERIFY: "fail",
        DECANT_SKIP_ATTESTATION: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "skipping the attestation check because DECANT_SKIP_ATTESTATION=1",
      );
      expect(existsSync(installedBinary)).toBe(true);
      expect(ghCalls).toEqual([]);
    });

    test("a logged-out gh never runs the verification", () => {
      const { result, installedBinary, ghCalls } = installWithGh({
        FAKE_GH_AUTH: "fail",
        FAKE_GH_VERIFY: "fail",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipped the attestation check");
      expect(existsSync(installedBinary)).toBe(true);
      expect(ghCalls).toEqual(["auth token --hostname github.com"]);
    });

    test("a logged-in gh without the attestation command aborts with an upgrade hint", () => {
      const { result, installedBinary, ghCalls, leftovers } = installWithGh({ FAKE_GH_OLD: "1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "decant install: error: gh is logged in but too old to verify attestations; upgrade gh to 2.49 or newer",
      );
      expect(existsSync(installedBinary)).toBe(false);
      expect(leftovers).toEqual([]);
      expect(ghCalls).toEqual(["auth token --hostname github.com", "attestation --help"]);
    });
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
    writeStub(join(ghDir, "gh"), FAKE_GH);

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
    // no gh on this PATH at all
    expect(result.stdout).toContain("skipped the attestation check");
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

  test.each([
    "http://mirror.example.com/decant/releases",
    // Userinfo, not the host: curl connects to evil.example.
    "http://127.0.0.1:80@evil.example/releases",
    "http://127.0.0.1.evil.example/releases",
    "http://localhost:80.evil.example/releases",
    "ftp://mirror.example.com/releases",
  ])("refuses the mirror %s before downloading", (baseUrl) => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const installDir = join(dir, "install-target");

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: freshHome(dir),
      DECANT_BASE_URL: baseUrl,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DECANT_BASE_URL must be an https:// or file:// URL");
    expect(existsSync(curlLog) ? readFileSync(curlLog, "utf8").trim() : "").toBe("");
    expect(existsSync(join(installDir, "decant"))).toBe(false);
  });

  test.each([
    "http://localhost:8080/decant/releases",
    "http://127.0.0.1/decant/releases",
    "http://[::1]:8080/decant/releases",
  ])("accepts the loopback HTTP mirror %s and limits redirects to HTTPS", (baseUrl) => {
    const dir = caseDir();
    const fixture = buildFixture(dir, "#!/bin/sh\necho fixture\n");
    const { binDir, curlLog } = buildStubBinDir(dir);
    const protoRedirLog = join(dir, "proto-redir.log");
    const installDir = join(dir, "install-target");

    const result = runInstall(["1.2.3"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: freshHome(dir),
      DECANT_BASE_URL: baseUrl,
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      CURL_LOG: curlLog,
      CURL_PROTO_REDIR_LOG: protoRedirLog,
    });

    expect(result.stderr).not.toContain("error:");
    expect(result.status).toBe(0);
    expect(readFileSync(curlLog, "utf8").trim().split("\n")).toEqual([
      `${baseUrl}/download/v1.2.3/${tarballName}`,
      `${baseUrl}/download/v1.2.3/SHA256SUMS`,
    ]);
    expect(readFileSync(protoRedirLog, "utf8").trim().split("\n")).toEqual(["=https", "=https"]);
    expect(readFileSync(join(installDir, "decant"), "utf8")).toBe(fixture.binaryContents);
  });

  test.each([
    "  Location: http://cdn.example/decant",
    "  location: HTTP://cdn.example/decant",
    "  Location: //cdn.example/decant",
    "  Location: ftp://cdn.example/decant",
  ])("wget refuses a redirect away from HTTPS (%s)", (header) => {
    const dir = caseDir();
    const fixture = buildFixture(dir, '#!/bin/sh\necho "decant 1.2.3-wget"\n');
    const farm = buildToolFarm(dir, { wget: true });
    const installDir = join(dir, "install-target");

    const result = runInstall(["1.2.3"], {
      PATH: farm.binDir,
      HOME: freshHome(dir),
      DECANT_INSTALL_DIR: installDir,
      DECANT_NO_MODIFY_PATH: "1",
      FIXTURE_DIR: fixture.fixtureDir,
      WGET_LOG: farm.wgetLog,
      WGET_HEADERS: `  HTTP/1.1 302 Found\n${header}\n  HTTP/1.1 200 OK`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing a redirect away from HTTPS");
    expect(existsSync(join(installDir, "decant"))).toBe(false);
  });

  test.each(["  Location: https://release-assets.example/decant", "  Location: /releases/decant"])(
    "wget follows an HTTPS or relative redirect (%s)",
    (header) => {
      const dir = caseDir();
      const fixture = buildFixture(dir, '#!/bin/sh\necho "decant 1.2.3-wget"\n');
      const farm = buildToolFarm(dir, { wget: true });
      const installDir = join(dir, "install-target");

      const result = runInstall(["1.2.3"], {
        PATH: farm.binDir,
        HOME: freshHome(dir),
        DECANT_INSTALL_DIR: installDir,
        DECANT_NO_MODIFY_PATH: "1",
        FIXTURE_DIR: fixture.fixtureDir,
        WGET_LOG: farm.wgetLog,
        WGET_HEADERS: `  HTTP/1.1 302 Found\n${header}\n  HTTP/1.1 200 OK`,
      });

      expect(result.stderr).not.toContain("error:");
      expect(result.status).toBe(0);
      expect(readFileSync(join(installDir, "decant"), "utf8")).toBe(fixture.binaryContents);
    },
  );

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
