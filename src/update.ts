import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getSettings, type SettingsOptions, settingsPath } from "./settings.ts";
import { DECANT_VERSION } from "./version.ts";

export const NPM_PACKAGE = "@dosu/decant";
export const LATEST_VERSION_URL = "https://registry.npmjs.org/@dosu/decant/latest";
export const RELEASES_URL = "https://github.com/dosu-ai/decant/releases";
export const DOCKER_IMAGE = "ghcr.io/dosu-ai/decant:latest";
export const HOMEBREW_FORMULA = "dosu-ai/dosu/decant";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CHECK_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const RELEASE_TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

interface Semver {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (match == null) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] == null ? [] : match[4].split("."),
  };
}

/** Semver precedence: negative when `a` is older than `b`. */
export function compareVersions(a: Semver, b: Semver): number {
  const core = a.core
    .map((part, index) => part - (b.core[index] ?? 0))
    .find((delta) => delta !== 0);
  if (core != null) {
    return core;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left == null || right == null) {
      return left == null ? -1 : 1;
    }
    if (left === right) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number(left) - Number(right);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  return 0;
}

export function sameVersion(reported: string | null, expected: string): boolean {
  return reported != null && reported.trim().replace(/^v/, "") === expected.replace(/^v/, "");
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  return next != null && now != null && compareVersions(next, now) > 0;
}

export type InstallChannel =
  | "npm"
  | "npx"
  | "npm-local"
  | "homebrew"
  | "installer"
  | "docker"
  | "source";

export interface InstallInfo {
  channel: InstallChannel;
  /** The real path of the running binary when Decant may replace it itself. */
  binaryPath: string | null;
}

export interface DetectInstallOptions {
  compiled?: boolean;
  env?: Record<string, string | undefined>;
  execPath?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
}

// Compiled Bun binaries load their entrypoint from an embedded `/$bunfs/`
// filesystem. Anything else is `bun run` from a checkout, where execPath is
// the bun runtime itself and must never be replaced.
export function isCompiledBinary(): boolean {
  return typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
}

export function detectInstall(options: DetectInstallOptions = {}): InstallInfo {
  if (!(options.compiled ?? isCompiledBinary())) {
    return { channel: "source", binaryPath: null };
  }
  const exists = options.exists ?? existsSync;
  // The official image sets the variable because Kubernetes and containerd
  // create neither marker file.
  if (
    (options.env ?? process.env).DECANT_INSTALL_CHANNEL === "docker" ||
    exists("/.dockerenv") ||
    exists("/run/.containerenv")
  ) {
    return { channel: "docker", binaryPath: null };
  }
  const execPath = options.execPath ?? process.execPath;
  let path = execPath;
  try {
    path = (options.realpath ?? realpathSync)(execPath);
  } catch {
    // Fall back to the unresolved path; classification only reads its shape.
  }
  if (path.includes("/Cellar/decant/")) {
    return { channel: "homebrew", binaryPath: null };
  }
  if (/\/node_modules\/@dosu\/decant-[a-z0-9]+-[a-z0-9]+\//.test(path)) {
    if (path.includes("/_npx/")) {
      return { channel: "npx", binaryPath: null };
    }
    // `npm install --global` lays packages out under <prefix>/lib/node_modules
    // on macOS and Linux; any other node_modules belongs to a project.
    return { channel: path.includes("/lib/node_modules/") ? "npm" : "npm-local", binaryPath: null };
  }
  return { channel: "installer", binaryPath: path };
}

/** The command a nudge tells the user to run for this install. */
export function updateCommandFor(channel: InstallChannel): string {
  switch (channel) {
    case "npx":
      return `npx ${NPM_PACKAGE}@latest`;
    case "npm-local":
      return `npm install ${NPM_PACKAGE}@latest`;
    case "docker":
      return `docker pull ${DOCKER_IMAGE}`;
    case "source":
      return "git pull && bun install";
    default:
      return "decant update";
  }
}

export type UpdatePlan =
  | { kind: "run"; argv: string[] }
  | { kind: "replace"; binaryPath: string }
  | { kind: "manual"; instructions: string };

export function planUpdate(install: InstallInfo, version: string): UpdatePlan {
  switch (install.channel) {
    case "npm":
      return { kind: "run", argv: ["npm", "install", "--global", `${NPM_PACKAGE}@${version}`] };
    case "homebrew":
      return { kind: "run", argv: ["brew", "upgrade", HOMEBREW_FORMULA] };
    case "installer":
      if (install.binaryPath != null) {
        return { kind: "replace", binaryPath: install.binaryPath };
      }
      break;
    case "npx":
      return {
        kind: "manual",
        instructions: `npx runs a cached copy. Run \`npx ${NPM_PACKAGE}@latest\` to use the newest release.`,
      };
    case "npm-local":
      return {
        kind: "manual",
        instructions: `This copy belongs to a project's node_modules. Update it there with \`npm install ${NPM_PACKAGE}@${version}\`.`,
      };
    case "docker":
      return {
        kind: "manual",
        instructions: `Containers do not update in place. Pull the new image with \`docker pull ${DOCKER_IMAGE}\` and restart the container.`,
      };
    case "source":
      break;
  }
  return {
    kind: "manual",
    instructions: "This is a source checkout. Update it with `git pull && bun install`.",
  };
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

export async function fetchLatestVersion(
  options: { fetch?: FetchLike; timeoutMs?: number; url?: string } = {},
): Promise<string> {
  const response = await (options.fetch ?? fetch)(options.url ?? LATEST_VERSION_URL, {
    signal: AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`the npm registry returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || parseVersion(body.version) == null) {
    throw new Error("the npm registry did not return a valid version");
  }
  return body.version;
}

export interface UpdateCheckRecord {
  checkedAt: string;
  latest: string | null;
}

export function updateCheckPath(options: SettingsOptions = {}): string {
  return join(dirname(settingsPath(options)), "update-check.json");
}

export function readUpdateCheck(options: SettingsOptions = {}): UpdateCheckRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCheckPath(options), "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof parsed.checkedAt !== "string" || Number.isNaN(Date.parse(parsed.checkedAt))) {
      return null;
    }
    const latest =
      typeof parsed.latest === "string" && parseVersion(parsed.latest) != null
        ? parsed.latest
        : null;
    return { checkedAt: parsed.checkedAt, latest };
  } catch {
    return null;
  }
}

// What this process last checked, per cache file. It holds the daily limit
// when the file cannot be written, such as under a read-only config dir.
const lastChecks = new Map<string, UpdateCheckRecord>();
// A server checking at startup and a browser loading the page at the same
// moment share one request.
const inflightChecks = new Map<string, Promise<CheckAttempt>>();

interface CheckAttempt {
  record: UpdateCheckRecord;
  error: string | null;
}

function writeUpdateCheck(record: UpdateCheckRecord, options: SettingsOptions): void {
  const path = updateCheckPath(options);
  lastChecks.set(path, record);
  // Write then rename, like saveSettings, so a concurrent reader never sees
  // a truncated file and starts a second check.
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    rmSync(temp, { force: true });
  }
}

async function attemptCheck(
  previous: UpdateCheckRecord | null,
  now: Date,
  options: CheckForUpdateOptions,
): Promise<CheckAttempt> {
  let attempt: CheckAttempt;
  try {
    const latest = await fetchLatestVersion({ fetch: options.fetch, timeoutMs: options.timeoutMs });
    attempt = { record: { checkedAt: now.toISOString(), latest }, error: null };
  } catch (failure) {
    // Recording the failed attempt holds an offline machine to one timeout
    // a day instead of one per command.
    attempt = {
      record: { checkedAt: now.toISOString(), latest: previous?.latest ?? null },
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
  writeUpdateCheck(attempt.record, options);
  return attempt;
}

/** `DECANT_UPDATE_CHECK` as a boolean, or null when it is unset or unrecognized. */
function updateCheckFromEnv(env: Record<string, string | undefined>): boolean | null {
  const flag = env.DECANT_UPDATE_CHECK?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on") {
    return true;
  }
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return null;
}

/** `DECANT_UPDATE_CHECK` overrides the saved setting in either direction. */
export function updateCheckEnabled(options: SettingsOptions = {}): boolean {
  return updateCheckFromEnv(options.env ?? process.env) ?? getSettings(options).updateCheck;
}

export interface UpdateStatus {
  enabled: boolean;
  /** True when `DECANT_UPDATE_CHECK` decided `enabled` instead of the setting. */
  envOverride: boolean;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  channel: InstallChannel;
  command: string;
  error: string | null;
}

export interface CheckForUpdateOptions extends SettingsOptions {
  current?: string;
  install?: InstallInfo;
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  /** Contact the registry even when checks are off or the cache is fresh. */
  force?: boolean;
}

/**
 * Reports whether a newer release exists. The registry is contacted only when
 * the user opted in and the cached answer is a day old, or when `force` says
 * the user asked directly.
 */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateStatus> {
  const current = options.current ?? DECANT_VERSION;
  const install = options.install ?? detectInstall();
  const envSetting = updateCheckFromEnv(options.env ?? process.env);
  const enabled = envSetting ?? getSettings(options).updateCheck;
  const force = options.force === true;
  const now = (options.now ?? (() => new Date()))();
  const cachePath = updateCheckPath(options);
  let record = readUpdateCheck(options) ?? lastChecks.get(cachePath) ?? null;
  let error: string | null = null;

  const age =
    record == null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(record.checkedAt);
  // A checkout is never nudged, so a passive check there would be a wasted request.
  const due = enabled && install.channel !== "source" && age >= UPDATE_CHECK_INTERVAL_MS;
  if (force || due) {
    let attempt = force ? undefined : inflightChecks.get(cachePath);
    if (attempt == null) {
      const started = attemptCheck(record, now, options);
      attempt = started;
      if (!force) {
        inflightChecks.set(cachePath, started);
        void started.finally(() => {
          if (inflightChecks.get(cachePath) === started) {
            inflightChecks.delete(cachePath);
          }
        });
      }
    }
    ({ record, error } = await attempt);
  }

  // A result cached by an explicit check must not keep nudging after the
  // user turned checks off.
  const known = enabled || force ? record : null;
  const latest = known?.latest ?? null;
  return {
    enabled,
    envOverride: envSetting != null,
    current,
    latest,
    // A checkout's `git describe` version says nothing about how far it is
    // from a release, so only installed builds are compared.
    updateAvailable:
      install.channel !== "source" && latest != null && isNewerVersion(latest, current),
    checkedAt: known?.checkedAt ?? null,
    channel: install.channel,
    command: updateCommandFor(install.channel),
    error,
  };
}

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const key = `${platform}-${arch}`;
  if (!RELEASE_TARGETS.has(key)) {
    throw new Error(`Decant does not publish a binary for ${platform}/${arch}`);
  }
  return `decant-${key}`;
}

export function checksumFor(sums: string, fileName: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/, 2);
    if (hash != null && name?.replace(/^\*/, "") === fileName && /^[0-9a-f]{64}$/i.test(hash)) {
      return hash.toLowerCase();
    }
  }
  return null;
}

export interface ReplaceBinaryOptions {
  binaryPath: string;
  version: string;
  baseUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: FetchLike;
  extract?: (tarball: string, intoDir: string) => void;
  reportedVersion?: (binary: string) => string | null;
}

/**
 * Downloads a release tarball, checks it against the release's SHA256SUMS,
 * and renames the new binary over `binaryPath`. Mirrors install.sh so both
 * paths trust the same artifacts.
 */
export async function replaceBinary(options: ReplaceBinaryOptions): Promise<void> {
  const version = options.version.replace(/^v/, "");
  const target = releaseTarget(options.platform, options.arch);
  const tarballName = `${target}.tar.gz`;
  const releaseBase = `${(options.baseUrl ?? RELEASES_URL).replace(/\/+$/, "")}/download/v${version}`;
  const download = async (url: string): Promise<Uint8Array> => {
    const response = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    // The release workflow publishes to npm before it creates the GitHub
    // release, so for a few minutes the registry names a version with no assets.
    if (response.status === 404) {
      throw new Error(
        `v${version} is not on the release page yet (HTTP 404 for ${url}). Try again in a few minutes.`,
      );
    }
    if (!response.ok) {
      throw new Error(`failed to download ${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  const [tarball, sums] = await Promise.all([
    download(`${releaseBase}/${tarballName}`),
    download(`${releaseBase}/SHA256SUMS`),
  ]);
  const expected = checksumFor(new TextDecoder().decode(sums), tarballName);
  if (expected == null) {
    throw new Error(`SHA256SUMS has no entry for ${tarballName}`);
  }
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${tarballName}: expected ${expected}, got ${actual}`);
  }

  const installDir = dirname(options.binaryPath);
  try {
    accessSync(installDir, constants.W_OK);
  } catch {
    throw new Error(
      `${installDir} is not writable. Re-run the installer with DECANT_INSTALL_DIR set to a directory you own.`,
    );
  }
  // Staging next to the target keeps the final rename on one filesystem,
  // where it is atomic: a running `decant` keeps its old inode, and the next
  // launch gets the complete new file.
  const staging = mkdtempSync(join(installDir, ".decant-update-"));
  try {
    const tarballPath = join(staging, tarballName);
    writeFileSync(tarballPath, tarball);
    (options.extract ?? extractBinary)(tarballPath, staging);
    const next = join(staging, "decant");
    // lstat, like install.sh's `-f`: a symlink entry would point the chmod
    // and rename below at a file outside the release.
    if (!lstatSync(next, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${tarballName} did not contain a decant binary`);
    }
    chmodSync(next, 0o755);
    const reported = (options.reportedVersion ?? reportedVersion)(next);
    if (!sameVersion(reported, version)) {
      throw new Error(
        `the downloaded binary reports ${reported ?? "no version"}, expected ${version}`,
      );
    }
    renameSync(next, options.binaryPath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function extractBinary(tarball: string, intoDir: string): void {
  const result = spawnSync("tar", ["-xzf", tarball, "-C", intoDir, "decant"], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`failed to extract the release tarball: ${result.stderr.trim()}`);
  }
}

/** What `<binary> --version` prints, or null when it fails to run. */
export function reportedVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}
