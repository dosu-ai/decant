import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SERVE_PORT } from "./serve-defaults.ts";
import { detectInstall, type InstallInfo } from "./update.ts";

/**
 * The background service: the OS starts `decant serve` at login and restarts
 * it if it fails. It is the same single process that owns the archive when
 * `decant serve` runs in a terminal, only supervised by launchd or systemd.
 */

export type ServiceManager = "launchd" | "systemd";

export const LAUNCHD_LABEL = "dev.dosu.decant";
export const SYSTEMD_UNIT = "decant.service";
/** Set in the service's environment so a process knows the OS supervises it. */
export const SERVICE_ENV = "DECANT_SERVICE";
/**
 * Exit code a supervised server uses to ask for a restart (EX_TEMPFAIL). Both
 * unit files restart only on a failing exit, so a clean stop stays stopped.
 */
export const SERVICE_RESTART_EXIT_CODE = 75;

export interface ServiceStatus {
  supported: boolean;
  manager: ServiceManager | null;
  /** Why the service cannot be used here, when `supported` is false. */
  reason: string | null;
  /** The unit file exists, so the OS starts Decant at login. */
  installed: boolean;
  /** The OS reports the service as running now. */
  running: boolean;
  unitPath: string | null;
  /** The command the unit file runs, when it can be read back. */
  command: string[] | null;
  /** Where the service serves the UI, read from its command. */
  url: string | null;
  /** True when the process answering is the service itself. */
  current: boolean;
}

export interface ServiceSpec {
  binary: string;
  dbPath: string;
  port: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (argv: string[]) => Promise<CommandResult>;

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  uid?: number;
  run?: RunCommand;
  /** Test seam: the install `serviceBinary` classifies. */
  install?: InstallInfo;
  /** Test seam: the running binary's path. */
  execPath?: string;
  /** Test seam: how long to wait for launchd to finish unloading the job. */
  unloadTimeoutMs?: number;
}

export class ServiceUnavailableError extends Error {}

/**
 * A path the unit file would need cannot be written into it safely. It extends
 * ServiceUnavailableError so callers report it the same way: nothing was
 * written, and the user has to pick a different path.
 */
export class UnsafeServicePathError extends ServiceUnavailableError {}

export function isServiceProcess(env: Record<string, string | undefined> = process.env): boolean {
  return env[SERVICE_ENV] === "1";
}

export function serviceManager(
  platform: NodeJS.Platform = process.platform,
): ServiceManager | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

export function unitPath(manager: ServiceManager, options: ServiceOptions = {}): string {
  const env = options.env ?? process.env;
  const home = (options.homeDir ?? homedir()) || ".";
  if (manager === "launchd") {
    return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  return join(configHome, "systemd", "user", SYSTEMD_UNIT);
}

export function serviceLogPath(options: ServiceOptions = {}): string {
  const home = (options.homeDir ?? homedir()) || ".";
  return join(home, "Library", "Logs", "decant", "serve.log");
}

/**
 * The path the unit file should run. A Homebrew upgrade installs into a new
 * versioned Cellar directory and removes the old one, so the unit points at the
 * stable `opt` symlink instead of the path the running binary resolves to.
 */
export function serviceBinary(
  options: ServiceOptions = {},
): { path: string; reason: null } | { path: null; reason: string } {
  const install =
    options.install ?? detectInstall({ env: options.env, execPath: options.execPath });
  switch (install.channel) {
    case "source":
      return {
        path: null,
        reason:
          "This is a source checkout running under bun. Install a Decant release to run it in the background.",
      };
    case "npx":
      return {
        path: null,
        reason:
          "npx runs Decant from a temporary copy. Install it with npm, Homebrew, or the installer first.",
      };
    case "docker":
      return {
        path: null,
        reason:
          "The container already runs Decant. Use Docker's restart policy to keep it running.",
      };
    default:
      break;
  }
  const execPath = options.execPath ?? process.execPath;
  const real = safeRealpath(execPath);
  const cellar = /^(.*)\/Cellar\/decant\/[^/]+\/bin\/decant$/.exec(real);
  if (cellar != null) {
    return { path: `${cellar[1]}/opt/decant/bin/decant`, reason: null };
  }
  return { path: real, reason: null };
}

export function serviceArgs(spec: ServiceSpec): string[] {
  return [spec.binary, "--db", spec.dbPath, "serve", "--no-open", "--port", String(spec.port)];
}

export function launchdPlist(spec: ServiceSpec, options: ServiceOptions = {}): string {
  const log = serviceLogPath(options);
  assertUnitSafe(spec, "launchd");
  assertNoControlCharacters("log path", log, "launchd");
  const args = serviceArgs(spec)
    .map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCHD_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>${SERVICE_ENV}</key>
\t\t<string>1</string>
\t\t<key>DECANT_LOG_LEVEL</key>
\t\t<string>warning</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(spec: ServiceSpec): string {
  assertUnitSafe(spec, "systemd");
  const exec = serviceArgs(spec).map(systemdQuote).join(" ");
  return `[Unit]
Description=Decant local UI and session sync
Documentation=https://github.com/dosu-ai/decant

[Service]
ExecStart=${exec}
Environment=${SERVICE_ENV}=1
Environment=DECANT_LOG_LEVEL=warning
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Read the command back out of an installed unit file, or null if it is not ours. */
export function parseUnitCommand(manager: ServiceManager, body: string): string[] | null {
  if (manager === "launchd") {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body);
    if (block == null) return null;
    return [...(block[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
      xmlUnescape(m[1] ?? ""),
    );
  }
  const line = /^ExecStart=(.*)$/m.exec(body);
  if (line == null) return null;
  const args: string[] = [];
  for (const match of (line[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const raw = match[1] != null ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? "");
    args.push(raw.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  }
  return args;
}

export function urlFromCommand(command: string[] | null): string | null {
  if (command == null) return null;
  const index = command.indexOf("--port");
  const port = index >= 0 ? Number(command[index + 1]) : DEFAULT_SERVE_PORT;
  return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
}

export async function serviceStatus(options: ServiceOptions = {}): Promise<ServiceStatus> {
  const env = options.env ?? process.env;
  const manager = serviceManager(options.platform);
  const base: ServiceStatus = {
    supported: false,
    manager,
    reason: null,
    installed: false,
    running: false,
    unitPath: null,
    command: null,
    url: null,
    current: isServiceProcess(env),
  };
  if (manager == null) {
    return { ...base, reason: "The background service runs on macOS and Linux only." };
  }
  const binary = serviceBinary(options);
  const run = options.run ?? runCommand;
  const path = unitPath(manager, options);
  const command = readUnitCommand(manager, path);
  const installed = existsSync(path);
  let reason = binary.reason;
  let running = false;
  if (manager === "launchd") {
    const printed = await run(["launchctl", "print", launchdTarget(options)]);
    running = printed.code === 0 && /^\s*state = running\s*$/m.test(printed.stdout);
  } else {
    // `show-environment` succeeds only when a systemd user manager is reachable,
    // which rules out containers and WSL without systemd.
    const probe = await run(["systemctl", "--user", "show-environment"]);
    if (probe.code !== 0) {
      reason ??= "No systemd user session is available, so Decant cannot register a service.";
    } else {
      const active = await run(["systemctl", "--user", "is-active", SYSTEMD_UNIT]);
      running = active.stdout.trim() === "active";
    }
  }
  return {
    ...base,
    supported: reason == null,
    reason,
    installed,
    running,
    unitPath: path,
    command,
    url: urlFromCommand(command),
  };
}

/**
 * Write the unit file and start the service. Idempotent: an installed service
 * with the same command is left alone.
 */
export async function installService(
  spec: Omit<ServiceSpec, "binary"> & { binary?: string },
  options: ServiceOptions = {},
): Promise<ServiceStatus> {
  const env = options.env ?? process.env;
  const manager = serviceManager(options.platform);
  const before = await serviceStatus(options);
  if (manager == null || !before.supported) {
    throw new ServiceUnavailableError(
      before.reason ?? "The background service is not supported here.",
    );
  }
  const binary = spec.binary ?? serviceBinary(options).path;
  if (binary == null) {
    throw new ServiceUnavailableError(before.reason ?? "Decant could not find its own binary.");
  }
  // The service starts in launchd's or systemd's working directory, not the
  // caller's, so a relative --db would open a different file or none at all.
  const full: ServiceSpec = { ...spec, dbPath: resolve(spec.dbPath), binary };
  const path = unitPath(manager, options);
  const body = manager === "launchd" ? launchdPlist(full, options) : systemdUnit(full);
  const run = options.run ?? runCommand;
  const target = launchdTarget(options);
  let loaded = false;
  let loadedArgs: string[] | null = null;
  if (manager === "launchd") {
    const printed = await run(["launchctl", "print", target]);
    loaded = printed.code === 0;
    loadedArgs = loaded ? parseLaunchdArguments(printed.stdout) : null;
  }
  // launchd keeps the arguments it read at bootstrap, and kickstart reuses
  // them, so a loaded job can be stale even when the file on disk matches.
  const changed =
    readText(path) !== body || (loadedArgs != null && !sameArgs(loadedArgs, serviceArgs(full)));
  if (!changed && before.running) {
    return before;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o644 });
  // Reloading means stopping the job first. When the caller is the running
  // service, that would kill it mid-request, so the new unit file applies the
  // next time the manager loads it instead.
  const reload = changed && !isServiceProcess(env);
  if (manager === "launchd") {
    mkdirSync(dirname(serviceLogPath(options)), { recursive: true });
    if (reload && loaded) {
      if (!(await bootoutAndWait(run, target, options))) {
        throw new Error(
          `launchd was still stopping ${LAUNCHD_LABEL} after ${Math.round(unloadTimeout(options) / 1000)}s. ` +
            "Run the command again once it exits.",
        );
      }
      loaded = false;
    }
    // A label the user once disabled stays disabled across bootstrap.
    await check(run, ["launchctl", "enable", target]);
    if (!loaded) {
      // RunAtLoad starts the job as soon as it is bootstrapped.
      await check(run, ["launchctl", "bootstrap", launchdDomain(options), path]);
    } else if (!before.running) {
      // Loaded with the current arguments but stopped, such as after a crash loop.
      await check(run, ["launchctl", "kickstart", target]);
    }
  } else {
    await check(run, ["systemctl", "--user", "daemon-reload"]);
    await check(run, ["systemctl", "--user", "enable", SYSTEMD_UNIT]);
    // After daemon-reload, start runs the new unit; only a running one needs a restart.
    const restart = reload && before.running;
    await check(run, ["systemctl", "--user", restart ? "restart" : "start", SYSTEMD_UNIT]);
  }
  return serviceStatus(options);
}

/**
 * Unregister the service without stopping it, so the caller can answer a
 * request before `stopService` ends the process when the caller is the service.
 */
export async function removeService(options: ServiceOptions = {}): Promise<void> {
  const manager = serviceManager(options.platform);
  if (manager == null) return;
  const run = options.run ?? runCommand;
  const path = unitPath(manager, options);
  if (manager === "systemd") {
    await run(["systemctl", "--user", "disable", SYSTEMD_UNIT]);
  }
  rmSync(path, { force: true });
  if (manager === "systemd") {
    await run(["systemctl", "--user", "daemon-reload"]);
  }
}

export async function stopService(options: ServiceOptions = {}): Promise<void> {
  const manager = serviceManager(options.platform);
  if (manager == null) return;
  const run = options.run ?? runCommand;
  if (manager === "launchd") {
    // A job still exiting at the deadline is gone soon after, since launchd
    // kills it at its ExitTimeOut; the caller's status read reports it meanwhile.
    await bootoutAndWait(run, launchdTarget(options), options);
  } else {
    await run(["systemctl", "--user", "stop", "--no-block", SYSTEMD_UNIT]);
  }
}

export async function uninstallService(options: ServiceOptions = {}): Promise<ServiceStatus> {
  await removeService(options);
  await stopService(options);
  return serviceStatus(options);
}

export interface BinaryFingerprint {
  path: string;
  ino: number;
  mtimeMs: number;
  size: number;
}

export function binaryFingerprint(path: string): BinaryFingerprint | null {
  try {
    const real = realpathSync(path);
    const stat = statSync(real);
    return { path: real, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Decide whether the binary the service runs has been replaced, so the running
 * server should exit and let the OS start the new version.
 *
 * How each install channel updates the file:
 * - Homebrew installs into a new Cellar directory, so the `opt` symlink
 *   resolves to a different `path`.
 * - The installer and `decant update` write a new file and rename it over the
 *   old one, so `ino` changes while `path` stays the same.
 * - npm replaces the platform package's directory contents.
 *
 * `next` is null while the file is missing, which happens for a moment in the
 * middle of an upgrade.
 */
export function binaryChanged(
  previous: BinaryFingerprint,
  next: BinaryFingerprint | null,
): boolean {
  // A missing file is the middle of an upgrade, not a new binary. The next
  // check sees whatever lands there.
  if (next == null) return false;
  return (
    next.path !== previous.path ||
    next.ino !== previous.ino ||
    next.size !== previous.size ||
    next.mtimeMs !== previous.mtimeMs
  );
}

export interface BinaryWatchOptions {
  intervalMs: number;
  /** How long a changed file must stay the same before it counts as replaced. */
  settleMs: number;
  /** The fingerprint the process started from, when taken before watching began. */
  initial?: BinaryFingerprint | null;
}

/**
 * Call `onChange` once the binary at `path` has been replaced and has stopped
 * changing, so a restart never runs a file an upgrade is still writing.
 * Returns a function that stops watching, or null if the binary is unreadable.
 */
export function watchBinary(
  path: string,
  onChange: () => void,
  options: BinaryWatchOptions,
): (() => void) | null {
  const initial = options.initial ?? binaryFingerprint(path);
  if (initial == null) return null;
  let candidate: BinaryFingerprint | null = null;
  let settling = false;
  let fired = false;
  const check = (): void => {
    if (fired) return;
    const next = binaryFingerprint(path);
    if (!binaryChanged(initial, next)) {
      candidate = null;
      return;
    }
    if (candidate != null && next != null && !binaryChanged(candidate, next)) {
      fired = true;
      onChange();
      return;
    }
    candidate = next;
    settling = true;
    const settle = setTimeout(() => {
      settling = false;
      check();
    }, options.settleMs);
    settle.unref?.();
  };
  const timer = setInterval(() => {
    if (!settling) check();
  }, options.intervalMs);
  timer.unref?.();
  return () => {
    fired = true;
    clearInterval(timer);
  };
}

/** The ProgramArguments launchd loaded, from `launchctl print`, or null if absent. */
export function parseLaunchdArguments(printed: string): string[] | null {
  const block = /^\s*arguments = \{\n([\s\S]*?)\n\s*\}\s*$/m.exec(printed);
  if (block == null) return null;
  return (block[1] ?? "").split("\n").map((line) => line.trim());
}

function sameArgs(loaded: string[], wanted: string[]): boolean {
  // launchctl print indents each argument, so compare without edge whitespace.
  return (
    loaded.length === wanted.length && loaded.every((arg, index) => arg === wanted[index]?.trim())
  );
}

const UNLOAD_POLL_MS = 100;
// launchd sends SIGKILL after the job's ExitTimeOut, 20 seconds by default.
const UNLOAD_TIMEOUT_MS = 30_000;

function unloadTimeout(options: ServiceOptions): number {
  return options.unloadTimeoutMs ?? UNLOAD_TIMEOUT_MS;
}

/**
 * Unload the job and wait until launchd forgets it, returning false if it is
 * still registered at the deadline. bootout returns while the old process is
 * still shutting down, and launchd answers a bootstrap of the same label with
 * "5: Input/output error" until that process exits.
 */
async function bootoutAndWait(
  run: RunCommand,
  target: string,
  options: ServiceOptions,
): Promise<boolean> {
  // bootout fails when the job is not loaded, which is the state we want.
  await run(["launchctl", "bootout", target]);
  const deadline = Date.now() + unloadTimeout(options);
  for (;;) {
    if ((await run(["launchctl", "print", target])).code !== 0) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(UNLOAD_POLL_MS);
  }
}

function readUnitCommand(manager: ServiceManager, path: string): string[] | null {
  const body = readText(path);
  return body == null ? null : parseUnitCommand(manager, body);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function launchdDomain(options: ServiceOptions): string {
  return `gui/${options.uid ?? process.getuid?.() ?? 0}`;
}

function launchdTarget(options: ServiceOptions): string {
  return `${launchdDomain(options)}/${LAUNCHD_LABEL}`;
}

async function check(run: RunCommand, argv: string[], allowed: number[] = []): Promise<void> {
  const result = await run(argv);
  if (result.code !== 0 && !allowed.includes(result.code)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${argv.join(" ")} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    // A missing launchctl or systemctl reads as a failed command, not a crash.
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function assertUnitSafe(spec: ServiceSpec, manager: ServiceManager): void {
  assertNoControlCharacters("Decant executable path", spec.binary, manager);
  assertNoControlCharacters("archive path", spec.dbPath, manager);
}

// No escaping makes these safe. In a systemd unit a newline ends ExecStart and
// starts a new directive, even inside quotes. In a plist, XML 1.0 forbids most
// C0 characters outright and parsers fold CR and CRLF into LF, so the path
// launchd ran would differ from the one the user chose.
function assertNoControlCharacters(label: string, value: string, manager: ServiceManager): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new UnsafeServicePathError(
        `The ${label} ${JSON.stringify(value)} contains a control character, which a ${manager} unit file cannot hold. Use a path without one.`,
      );
    }
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// systemd expands % specifiers and $ variables inside ExecStart, even in quotes.
function systemdQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

function nonEmpty(value: string | undefined): string | null {
  return value == null || value.trim() === "" ? null : value;
}
