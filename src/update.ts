import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSettings, type SettingsOptions, settingsPath } from "./settings.ts";
import { DECANT_VERSION } from "./version.ts";

export const NPM_PACKAGE = "@dosu/decant";
export const LATEST_VERSION_URL = "https://registry.npmjs.org/@dosu/decant/latest";
export const RELEASES_URL = "https://github.com/dosu-ai/decant/releases";
export const DOCKER_IMAGE = "ghcr.io/dosu-ai/decant:latest";
export const HOMEBREW_FORMULA = "dosu-ai/dosu/decant";
export const INSTALLER_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How soon a failed check is retried, so one slow request does not hide a release for a day. */
export const FAILED_CHECK_RETRY_MS = 60 * 60 * 1000;
const NPM_REGISTRY_URL = "https://registry.npmjs.org";

const CHECK_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// GitHub takes one hop to reach its asset CDN. The rest is headroom for a
// mirror that sits behind its own redirects.
const MAX_DOWNLOAD_REDIRECTS = 10;
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

/**
 * The version string as the registry or cache should hold it. parseVersion
 * trims, so without this "1.2.3\n" would pass the check and still reach the
 * cache file and the release URL with the newline attached.
 */
function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return parseVersion(trimmed) == null ? null : trimmed;
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
  | "standalone"
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
  homeDir?: string;
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
  // Only the official image sets this. Marker files like /.dockerenv also
  // exist in devcontainers and CI jobs, where decant came from npm, Homebrew,
  // or install.sh and updates the usual way.
  const env = options.env ?? process.env;
  if (env.DECANT_INSTALL_CHANNEL === "docker") {
    return { channel: "docker", binaryPath: null };
  }
  const realpath = options.realpath ?? realpathSync;
  const resolveReal = (target: string): string => {
    try {
      return realpath(target);
    } catch {
      // Fall back to the unresolved path; classification only reads its shape.
      return target;
    }
  };
  const path = resolveReal(options.execPath ?? process.execPath);
  if (path.includes("/Cellar/decant/")) {
    return { channel: "homebrew", binaryPath: null };
  }
  if (/\/node_modules\/@dosu\/decant-[a-z0-9]+-[a-z0-9]+\//.test(path)) {
    if (path.includes("/_npx/")) {
      return { channel: "npx", binaryPath: null };
    }
    // `npm install --global` lays packages out under <prefix>/lib/node_modules
    // on macOS and Linux. Anything else is a project, or a global install by
    // another package manager such as bun or pnpm.
    return { channel: path.includes("/lib/node_modules/") ? "npm" : "npm-local", binaryPath: null };
  }
  // Only a binary in the installer's directory is Decant's to replace. A copy
  // somewhere else may belong to mise, aqua, a distro package, or a manual
  // download, and renaming over it would desync whatever tracks that file.
  const binaryDir = dirname(path);
  const installDirs = [join(options.homeDir ?? homedir(), ".local", "bin")];
  const customDir = nonEmpty(env.DECANT_INSTALL_DIR);
  if (customDir != null) {
    installDirs.push(customDir);
  }
  for (const dir of installDirs.map((candidate) => resolve(candidate))) {
    if (binaryDir === dir || binaryDir === resolveReal(dir)) {
      return { channel: "installer", binaryPath: path };
    }
  }
  return { channel: "standalone", binaryPath: null };
}

function nonEmpty(value: string | undefined): string | null {
  return value == null || value.trim() === "" ? null : value;
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
      // `decant update` explains what to do for a standalone copy. A bare
      // installer command would install a second copy in ~/.local/bin.
      return "decant update";
  }
}

export interface PlanCommand {
  argv: string[];
  /** A failure is reported but does not stop the commands after it. */
  bestEffort?: boolean;
}

export type UpdatePlan =
  /** Commands run in order; a failure stops the rest unless it is best effort. */
  | { kind: "run"; commands: PlanCommand[] }
  | { kind: "replace"; binaryPath: string }
  | { kind: "manual"; instructions: string };

export function planUpdate(install: InstallInfo, version: string): UpdatePlan {
  switch (install.channel) {
    case "npm":
      return {
        kind: "run",
        commands: [{ argv: ["npm", "install", "--global", `${NPM_PACKAGE}@${version}`] }],
      };
    case "homebrew":
      // `brew upgrade` refreshes taps only once a day (HOMEBREW_AUTO_UPDATE_SECS),
      // so without `brew update` a fresh tap push stays invisible until then.
      // `brew update` exits 1 when any unrelated tap fails to fetch, so it must
      // not block the upgrade; the PATH check afterwards catches a stale tap.
      return {
        kind: "run",
        commands: [
          { argv: ["brew", "update"], bestEffort: true },
          { argv: ["brew", "upgrade", HOMEBREW_FORMULA] },
        ],
      };
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
    case "standalone":
      return {
        kind: "manual",
        instructions:
          "Decant did not install this binary, so it will not replace it. Update it with the tool that " +
          "installed it. If you used the shell installer with DECANT_INSTALL_DIR, set it to this " +
          "binary's directory and run `decant update` again. Otherwise remove this copy and reinstall " +
          `with \`${INSTALLER_COMMAND}\`, which installs into ~/.local/bin.`,
      };
    case "npm-local":
      return {
        kind: "manual",
        instructions: `This copy lives in a node_modules folder that \`npm install --global\` does not manage. Update it with the package manager that installed it, for example \`npm install ${NPM_PACKAGE}@${version}\` in that project.`,
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
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    redirect?: RequestRedirect;
  },
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
  const version = cleanVersion(body.version);
  if (version == null) {
    throw new Error("the npm registry did not return a valid version");
  }
  return version;
}

export interface UpdateCheckRecord {
  checkedAt: string;
  latest: string | null;
  /** Set when this attempt failed, which makes the next one due sooner. */
  failed?: boolean;
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
    return {
      checkedAt: parsed.checkedAt,
      latest: cleanVersion(parsed.latest),
      ...(parsed.failed === true ? { failed: true } : {}),
    };
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
    // an hour instead of one per command. Waiting a full day would let one
    // slow answer to a short CLI timeout hide a release from serve too.
    attempt = {
      record: { checkedAt: now.toISOString(), latest: previous?.latest ?? null, failed: true },
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
  writeUpdateCheck(attempt.record, options);
  return attempt;
}

function newerRecord(
  a: UpdateCheckRecord | null,
  b: UpdateCheckRecord | null,
): UpdateCheckRecord | null {
  if (a == null || b == null) {
    return a ?? b;
  }
  return Date.parse(b.checkedAt) > Date.parse(a.checkedAt) ? b : a;
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
  // The file can be older than this process's last check when the config dir
  // is read-only, so the newer of the two holds the daily limit.
  let record = newerRecord(readUpdateCheck(options), lastChecks.get(cachePath) ?? null);
  let error: string | null = null;

  const age =
    record == null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(record.checkedAt);
  // A checkout is never nudged, so a passive check there would be a wasted request.
  // A negative age means the clock was wrong when the cache was written, and
  // trusting it would stop checks until that date.
  const interval = record?.failed === true ? FAILED_CHECK_RETRY_MS : UPDATE_CHECK_INTERVAL_MS;
  const due = enabled && install.channel !== "source" && (age < 0 || age >= interval);
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

/** Where npm serves the platform package `npm install` needs for this machine. */
export function npmPlatformTarballUrl(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const target = releaseTarget(platform, arch);
  return `${NPM_REGISTRY_URL}/@dosu/${target}/-/${target}-${version}.tgz`;
}

/**
 * Confirms npm can serve this machine's platform package before
 * `npm install --global` replaces a working install. The registry can name a
 * new version minutes before its platform tarballs download, and npm skips an
 * optional dependency it cannot fetch, leaving a launcher with no binary.
 */
export async function assertNpmPlatformPackage(options: {
  version: string;
  fetch?: FetchLike;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<void> {
  if (parseVersion(options.version) == null) {
    throw new Error(`refusing to install an invalid version: ${options.version}`);
  }
  const url = npmPlatformTarballUrl(options.version, options.platform, options.arch);
  const response = await (options.fetch ?? fetch)(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new Error(
      `npm has not finished publishing v${options.version} for this platform yet. Try again in a few minutes.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `could not confirm the npm package for v${options.version}: HTTP ${response.status}`,
    );
  }
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
 * SHA256SUMS is only as trustworthy as the channel it arrives on, so a mirror
 * must be HTTPS. file:// and plain HTTP to this machine's own loopback
 * address (an SSH port forward, say) stay allowed because neither crosses a
 * network. install.sh accepts the same three forms and the same host names.
 */
export function releaseBaseUrl(baseUrl: string | undefined): string {
  const base = (baseUrl ?? RELEASES_URL).replace(/\/+$/, "");
  if (!isTrustedMirror(base)) {
    throw new Error(
      "DECANT_BASE_URL must be an https:// or file:// URL, or http:// to localhost, " +
        `127.0.0.1, or [::1] (got ${JSON.stringify(base)})`,
    );
  }
  return base;
}

const LOOPBACK_MIRROR_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isTrustedMirror(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === "https:" || url.protocol === "file:") {
    return true;
  }
  return url.protocol === "http:" && LOOPBACK_MIRROR_HOSTS.has(url.hostname);
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has("location");
}

/**
 * Downloads a release tarball, checks it against the release's SHA256SUMS,
 * and renames the new binary over `binaryPath`. Mirrors install.sh so both
 * paths trust the same artifacts.
 */
export async function replaceBinary(options: ReplaceBinaryOptions): Promise<void> {
  const version = cleanVersion(options.version)?.replace(/^v/, "");
  if (version == null) {
    throw new Error(`not a release version: ${JSON.stringify(options.version)}`);
  }
  const base = releaseBaseUrl(options.baseUrl);
  const target = releaseTarget(options.platform, options.arch);
  const tarballName = `${target}.tar.gz`;
  // Checked before downloading, so a read-only install fails without fetching
  // the whole release first.
  const installDir = dirname(options.binaryPath);
  try {
    accessSync(installDir, constants.W_OK);
  } catch {
    throw new Error(
      `${installDir} is not writable. Run decant update as a user who can write there, or remove ` +
        "this copy and reinstall into ~/.local/bin with the shell installer.",
    );
  }
  const releaseBase = `${base}/download/v${version}`;
  const download = async (url: string): Promise<Uint8Array> => {
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    let current = url;
    let response = await (options.fetch ?? fetch)(current, { redirect: "manual", signal });
    // GitHub redirects release assets to its CDN, so redirects are followed
    // here, one hop at a time. A hop to plain HTTP would let an on-path
    // attacker swap the tarball and SHA256SUMS together, so only HTTPS hops
    // are accepted, the same rule as install.sh's curl --proto-redir.
    for (let hops = 0; isRedirect(response); hops++) {
      if (hops === MAX_DOWNLOAD_REDIRECTS) {
        throw new Error(`too many redirects downloading ${url}`);
      }
      const next = new URL(response.headers.get("location") ?? "", current);
      if (next.protocol !== "https:") {
        throw new Error(`refusing to follow a redirect from ${current} to ${next.href}`);
      }
      current = next.href;
      response = await (options.fetch ?? fetch)(current, { redirect: "manual", signal });
    }
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
