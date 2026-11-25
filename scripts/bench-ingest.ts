import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { cpus, homedir, release, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type CorpusManifest,
  type CorpusProfile,
  generateCorpus,
  generateLiveAppendChunk,
  type LiveAppenderState,
} from "./bench-corpus.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");
const DEFAULT_SEED = 20261125;
const DEFAULT_IMAGE = "decant-bench:local";
const DEFAULT_WORK_DIR = join(homedir(), ".cache", "decant-bench");
const CONTAINER_WORK_DIR = "/bench";
const CONTAINER_RUN_ROOT = "/var/tmp/decant-bench-run";
const CONTAINER_RUN_DIR_MOUNT = "/bench-runs";
const CORPUS_FORMAT = 2;
const SAMPLE_INTERVAL_MS = 5_000;
const FRESHNESS_POLL_MS = 500;
const RSS_POLL_MS = 5;
const DRAIN_TIMEOUT_MS = 10_000;
const SCALING_APPENDS = 5;
const MARKER_PREFIX = "decantbenchm";
const LIVE_CHUNK_PATTERN = ["tool_burst", "tool_burst", "tool_burst", "assistant_turn"] as const;
const MB = 1_000_000;

const DOCKERFILE = `FROM oven/bun:1.4.4-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends strace procps sqlite3 curl ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
`;

const USAGE = `usage: bun run scripts/bench-ingest.ts [options]

Replays a deterministic synthetic corpus against \`decant serve\` on Linux and
measures steady-state ingest cost from outside the process (/proc and strace).

  --profile pi|small        corpus profile (default pi)
  --duration-sec <n>        steady-state replay window (default 600)
  --cadence-ms <n>          one live append every n ms (default 2000)
  --work-dir <dir>          corpus, seed, and log cache, kept owner-only
                            (default ~/.cache/decant-bench)
  --run-dir <dir>           where each run's database copy lives (default <work-dir>/runs;
                            --docker mounts it, and without it a run stays in the
                            container unless --keep-run-db keeps it in <work-dir>/runs)
  --seed <n>                corpus seed (default ${DEFAULT_SEED})
  --rebuild-seed            regenerate the corpus and seeded databases
  --scaling                 also run the 1/5/20/60 MB session-size sub-benchmark
  --scaling-only            run only the scaling sub-benchmark
  --out-json <path>         write the full structured report
  --native | --docker       run here (Linux) or inside Docker (default: docker on macOS)
  --docker-image <name>     image for --docker (default ${DEFAULT_IMAGE}; built if missing)
  --strace launch|attach|off
                            launch: start serve under strace --seccomp-bpf -f, which
                              traps only fsync/fdatasync and follows sync-worker threads
                            attach: strace -f -p after startup; seccomp-bpf is
                              unavailable when attaching, so every syscall stops
                            off: no fsync counting
                            (default launch)
  --keep-run-db             keep each run's database copy after inspection
  --serve-arg <arg>         forwarded to decant serve (repeatable)
  --env <KEY=VAL>           added to the decant serve environment (repeatable)
`;

type StraceMode = "launch" | "attach" | "off";

interface Options {
  profile: CorpusProfile;
  durationSec: number;
  cadenceMs: number;
  workDir: string;
  runDir: string | null;
  seed: number;
  rebuildSeed: boolean;
  scaling: boolean;
  scalingOnly: boolean;
  outJson: string | null;
  mode: "native" | "docker";
  dockerImage: string;
  strace: StraceMode;
  keepRunDb: boolean;
  serveArgs: string[];
  env: Record<string, string>;
}

class UsageError extends Error {}

function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0 && stats.uid !== uid) {
    throw new Error(`${dir} is not owned by the current user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
  return dir;
}

function siblingTempPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
}

function publishAtomically(target: string, fill: (temp: string) => void): void {
  const temp = siblingTempPath(target);
  try {
    fill(temp);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function publishText(target: string, contents: string): void {
  publishAtomically(target, (temp) => {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, contents);
    } finally {
      closeSync(fd);
    }
  });
}

function publishCopy(source: string, target: string): void {
  publishAtomically(target, (temp) => {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o600);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  return resolve(child).startsWith(`${resolve(parent)}/`);
}

function parseArgs(argv: string[]): Options | null {
  const options: Options = {
    profile: "pi",
    durationSec: 600,
    cadenceMs: 2000,
    workDir: DEFAULT_WORK_DIR,
    runDir: null,
    seed: DEFAULT_SEED,
    rebuildSeed: false,
    scaling: false,
    scalingOnly: false,
    outJson: null,
    mode: process.platform === "linux" ? "native" : "docker",
    dockerImage: DEFAULT_IMAGE,
    strace: "launch",
    keepRunDb: false,
    serveArgs: [],
    env: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        throw new UsageError(`${flag} needs a value`);
      }
      i += 1;
      return next;
    };
    const positiveInt = (): number => {
      const text = value();
      const parsed = Number(text);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new UsageError(`${flag} expects a positive integer, got ${text}`);
      }
      return parsed;
    };
    switch (flag) {
      case "-h":
      case "--help":
        return null;
      case "--profile": {
        const profile = value();
        if (profile !== "pi" && profile !== "small") {
          throw new UsageError(`unknown profile: ${profile}`);
        }
        options.profile = profile;
        break;
      }
      case "--duration-sec":
        options.durationSec = positiveInt();
        break;
      case "--cadence-ms":
        options.cadenceMs = positiveInt();
        break;
      case "--work-dir":
        options.workDir = resolve(value());
        break;
      case "--run-dir":
        options.runDir = resolve(value());
        break;
      case "--seed": {
        const text = value();
        const seed = Number(text);
        if (!Number.isSafeInteger(seed)) {
          throw new UsageError(`--seed expects an integer, got ${text}`);
        }
        options.seed = seed;
        break;
      }
      case "--rebuild-seed":
        options.rebuildSeed = true;
        break;
      case "--scaling":
        options.scaling = true;
        break;
      case "--scaling-only":
        options.scalingOnly = true;
        options.scaling = true;
        break;
      case "--out-json":
        options.outJson = resolve(value());
        break;
      case "--native":
        options.mode = "native";
        break;
      case "--docker":
        options.mode = "docker";
        break;
      case "--docker-image":
        options.dockerImage = value();
        break;
      case "--strace": {
        const mode = value();
        if (mode !== "launch" && mode !== "attach" && mode !== "off") {
          throw new UsageError(`--strace expects launch, attach, or off, got ${mode}`);
        }
        options.strace = mode;
        break;
      }
      case "--keep-run-db":
        options.keepRunDb = true;
        break;
      case "--serve-arg":
        options.serveArgs.push(value());
        break;
      case "--env": {
        const pair = value();
        const split = pair.indexOf("=");
        if (split <= 0) {
          throw new UsageError(`--env expects KEY=VAL, got ${pair}`);
        }
        options.env[pair.slice(0, split)] = pair.slice(split + 1);
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${raw}`);
    }
  }
  return options;
}

async function runCommand(
  cmd: string[],
  opts: { stdin?: string; quiet?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function ensureDockerImage(image: string): Promise<void> {
  const inspect = await runCommand(["docker", "image", "inspect", image]);
  if (inspect.code === 0) {
    return;
  }
  console.error(`[bench] building ${image} (oven/bun:1.4.4-slim + strace, procps, sqlite3)`);
  const build = Bun.spawn(["docker", "build", "-t", image, "-"], {
    stdin: new TextEncoder().encode(DOCKERFILE),
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`docker build for ${image} failed`);
  }
}

function forwardedArgs(options: Options, outJson: string | null, runDir: string): string[] {
  const args = [
    "--native",
    "--work-dir",
    CONTAINER_WORK_DIR,
    "--run-dir",
    runDir,
    "--profile",
    options.profile,
    "--duration-sec",
    String(options.durationSec),
    "--cadence-ms",
    String(options.cadenceMs),
    "--seed",
    String(options.seed),
    "--strace",
    options.strace,
  ];
  if (options.rebuildSeed) args.push("--rebuild-seed");
  if (options.scalingOnly) args.push("--scaling-only");
  else if (options.scaling) args.push("--scaling");
  if (options.keepRunDb) args.push("--keep-run-db");
  if (outJson !== null) args.push("--out-json", outJson);
  for (const arg of options.serveArgs) args.push(`--serve-arg=${arg}`);
  for (const [key, val] of Object.entries(options.env)) args.push("--env", `${key}=${val}`);
  return args;
}

async function runInDocker(options: Options): Promise<number> {
  await ensureDockerImage(options.dockerImage);
  ensurePrivateDir(options.workDir);
  const hostWorkDir = realpathSync(options.workDir);
  const hostRunDir =
    options.runDir === null ? null : realpathSync(ensurePrivateDir(options.runDir));
  const containerRunDir =
    hostRunDir !== null
      ? CONTAINER_RUN_DIR_MOUNT
      : options.keepRunDb
        ? `${CONTAINER_WORK_DIR}/runs`
        : CONTAINER_RUN_ROOT;
  const reportName = `report-${Date.now()}.json`;
  const containerOut =
    options.outJson === null ? null : `${CONTAINER_WORK_DIR}/reports/${reportName}`;
  const name = `decant-bench-${process.pid}-${Date.now()}`;
  const cmd = [
    "docker",
    "run",
    "--rm",
    "--name",
    name,
    "--cap-add=SYS_PTRACE",
    "--security-opt",
    "seccomp=unconfined",
    "-v",
    `${REPO_ROOT}:/repo:ro`,
    "-v",
    `${hostWorkDir}:${CONTAINER_WORK_DIR}`,
    ...(hostRunDir === null ? [] : ["-v", `${hostRunDir}:${CONTAINER_RUN_DIR_MOUNT}`]),
    "-w",
    "/tmp",
    options.dockerImage,
    "bun",
    "run",
    "/repo/scripts/bench-ingest.ts",
    ...forwardedArgs(options, containerOut, containerRunDir),
  ];
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const stop = (): void => {
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const code = await proc.exited;
  if (options.outJson !== null) {
    const produced = join(hostWorkDir, "reports", reportName);
    if (existsSync(produced)) {
      mkdirSync(dirname(options.outJson), { recursive: true, mode: 0o700 });
      publishText(options.outJson, readFileSync(produced, "utf8"));
      unlinkSync(produced);
      console.error(`[bench] wrote ${options.outJson}`);
    } else {
      console.error(`[bench] container did not produce ${produced}`);
    }
  }
  return code;
}

interface ProcIo {
  rchar: number;
  wchar: number;
  syscr: number;
  syscw: number;
  read_bytes: number;
  write_bytes: number;
  cancelled_write_bytes: number;
}

interface ProcStatus {
  vmRssKb: number;
  vmHwmKb: number;
  threads: number;
}

interface FileSizes {
  db: number;
  wal: number;
  shm: number;
}

interface SqliteHandles {
  totalFds: number;
  sqliteFds: number;
  dbMappedKb: number;
  dbMappedRssKb: number;
  shmMappedKb: number;
}

interface ProcSnapshot {
  tMs: number;
  io: ProcIo;
  cpuTicks: { utime: number; stime: number };
  status: ProcStatus;
  files: FileSizes;
  handles: SqliteHandles;
}

function readProcIo(pid: number | "self"): ProcIo {
  return parseProcIo(readFileSync(`/proc/${pid}/io`, "utf8"));
}

function readOwnIo(): { io: ProcIo; readBytes: number } {
  const text = readFileSync("/proc/self/io", "utf8");
  return { io: parseProcIo(text), readBytes: Buffer.byteLength(text) };
}

function parseProcIo(text: string): ProcIo {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, val] = line.split(":");
    if (key !== undefined && val !== undefined) {
      fields.set(key.trim(), Number(val.trim()));
    }
  }
  const get = (key: string): number => fields.get(key) ?? 0;
  return {
    rchar: get("rchar"),
    wchar: get("wchar"),
    syscr: get("syscr"),
    syscw: get("syscw"),
    read_bytes: get("read_bytes"),
    write_bytes: get("write_bytes"),
    cancelled_write_bytes: get("cancelled_write_bytes"),
  };
}

function ioDelta(a: ProcIo, b: ProcIo): ProcIo {
  return {
    rchar: b.rchar - a.rchar,
    wchar: b.wchar - a.wchar,
    syscr: b.syscr - a.syscr,
    syscw: b.syscw - a.syscw,
    read_bytes: b.read_bytes - a.read_bytes,
    write_bytes: b.write_bytes - a.write_bytes,
    cancelled_write_bytes: b.cancelled_write_bytes - a.cancelled_write_bytes,
  };
}

function readCpuTicks(pid: number): { utime: number; stime: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields after the parenthesized comm start at field 3 (state); utime and stime are fields 14 and 15.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { utime: Number(fields[11]), stime: Number(fields[12]) };
}

function readStatus(pid: number): ProcStatus {
  const status: ProcStatus = { vmRssKb: 0, vmHwmKb: 0, threads: 0 };
  for (const line of readFileSync(`/proc/${pid}/status`, "utf8").split("\n")) {
    const match = /^(VmRSS|VmHWM|Threads):\s+(\d+)/.exec(line);
    if (match?.[1] === "VmRSS") status.vmRssKb = Number(match[2]);
    else if (match?.[1] === "VmHWM") status.vmHwmKb = Number(match[2]);
    else if (match?.[1] === "Threads") status.threads = Number(match[2]);
  }
  return status;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileSizes(dbPath: string): FileSizes {
  return { db: sizeOf(dbPath), wal: sizeOf(`${dbPath}-wal`), shm: sizeOf(`${dbPath}-shm`) };
}

function sqliteHandles(pid: number, dbPath: string): SqliteHandles {
  const handles: SqliteHandles = {
    totalFds: 0,
    sqliteFds: 0,
    dbMappedKb: 0,
    dbMappedRssKb: 0,
    shmMappedKb: 0,
  };
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      handles.totalFds += 1;
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith(dbPath)) handles.sqliteFds += 1;
      } catch {}
    }
    let current: "db" | "shm" | null = null;
    for (const line of readFileSync(`/proc/${pid}/smaps`, "utf8").split("\n")) {
      if (/^[0-9a-f]+-[0-9a-f]+ /.test(line)) {
        const path = line.split(/\s+/).slice(5).join(" ");
        current = path === dbPath ? "db" : path === `${dbPath}-shm` ? "shm" : null;
        continue;
      }
      if (current === null) continue;
      const size = /^Size:\s+(\d+)/.exec(line);
      const rss = /^Rss:\s+(\d+)/.exec(line);
      if (size !== null) {
        if (current === "db") handles.dbMappedKb += Number(size[1]);
        else handles.shmMappedKb += Number(size[1]);
      } else if (rss !== null && current === "db") {
        handles.dbMappedRssKb += Number(rss[1]);
      }
    }
  } catch {}
  return handles;
}

function snapshot(pid: number, dbPath: string): ProcSnapshot {
  return {
    tMs: performance.now(),
    io: readProcIo(pid),
    cpuTicks: readCpuTicks(pid),
    status: readStatus(pid),
    files: fileSizes(dbPath),
    handles: sqliteHandles(pid, dbPath),
  };
}

function clockTicks(): number {
  const result = Bun.spawnSync(["getconf", "CLK_TCK"]);
  const parsed = Number(result.stdout.toString().trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

interface FsyncCounts {
  fsync: number;
  fdatasync: number;
  byFile: Record<string, number>;
  mainThread: number;
  otherThreads: number;
  distinctThreads: number;
}

function fsyncTarget(path: string | undefined): string {
  if (path === undefined) return "?";
  try {
    if (statSync(path).isDirectory()) return "(directory)";
  } catch {}
  return basename(path);
}

function countFsyncs(
  straceFile: string,
  mainPid: number | null,
  fromSec = 0,
  toSec = Number.POSITIVE_INFINITY,
) {
  const counts: FsyncCounts = {
    fsync: 0,
    fdatasync: 0,
    byFile: {},
    mainThread: 0,
    otherThreads: 0,
    distinctThreads: 0,
  };
  if (!existsSync(straceFile)) return counts;
  const pattern = /^(\d+)\s+(\d+\.\d+)\s+(fsync|fdatasync)\(\d+(?:<([^>]*)>)?/;
  const threads = new Set<number>();
  for (const line of readFileSync(straceFile, "utf8").split("\n")) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const at = Number(match[2]);
    if (at < fromSec || at > toSec) continue;
    if (match[3] === "fsync") counts.fsync += 1;
    else counts.fdatasync += 1;
    const tid = Number(match[1]);
    threads.add(tid);
    if (tid === mainPid) counts.mainThread += 1;
    else counts.otherThreads += 1;
    const file = fsyncTarget(match[4]);
    counts.byFile[file] = (counts.byFile[file] ?? 0) + 1;
  }
  counts.distinctThreads = threads.size;
  return counts;
}

function straceArgs(straceFile: string): string[] {
  return ["strace", "-f", "-ttt", "-y", "-e", "trace=fsync,fdatasync", "-o", straceFile];
}

function decantChild(parentPid: number): number | null {
  try {
    const first = readFileSync(`/proc/${parentPid}/task/${parentPid}/children`, "utf8")
      .trim()
      .split(/\s+/)[0];
    if (first === undefined || first === "") return null;
    const pid = Number(first);
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(CLI_PATH) ? pid : null;
  } catch {
    return null;
  }
}

async function childPid(parentPid: number, timeoutMs = 10_000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const pid = decantChild(parentPid);
    if (pid !== null) return pid;
    await Bun.sleep(20);
  }
  throw new Error(`no decant child appeared under strace pid ${parentPid}`);
}

interface SourceDirs {
  claude?: string;
  codex?: string;
  copilot?: string;
}

function isolatedEnv(
  runDir: string,
  dbPath: string,
  sources: SourceDirs,
  extra: Record<string, string> = {},
): Record<string, string> {
  const empty = join(runDir, "empty");
  const dirs = {
    home: join(runDir, "home"),
    xdgData: join(runDir, "xdg-data"),
    xdgConfig: join(runDir, "xdg-config"),
    xdgCache: join(runDir, "xdg-cache"),
    config: join(runDir, "decant-config"),
  };
  for (const dir of [empty, ...Object.values(dirs)]) ensurePrivateDir(dir);
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: dirs.home,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_CACHE_HOME: dirs.xdgCache,
    DECANT_CONFIG_DIR: dirs.config,
    DECANT_DB: dbPath,
    DECANT_NO_OPEN: "1",
    DECANT_UPDATE_CHECK: "off",
    DECANT_CLAUDE_DIR: sources.claude ?? empty,
    DECANT_CODEX_DIR: sources.codex ?? empty,
    DECANT_COPILOT_DIR: sources.copilot ?? empty,
    DECANT_GEMINI_DIR: empty,
    DECANT_OPENCODE_DIR: empty,
    DECANT_CURSOR_DIR: empty,
    DECANT_VSCODE_COPILOT_DIR: empty,
    DECANT_ATIF_DIR: empty,
    DECANT_HERMES_DIR: empty,
    DECANT_PI_DIR: empty,
    OPENCODE_DATA_DIR: empty,
    OPENCODE_CONFIG_DIR: empty,
    OPENCODE_MODELS_PATH: join(empty, "models.json"),
    HERMES_HOME: empty,
    COPILOT_HOME: empty,
    PI_CODING_AGENT_DIR: empty,
    ...extra,
  };
}

interface CorpusInfo {
  dir: string;
  manifest: CorpusManifest;
  generatedNow: boolean;
  generateMs: number | null;
}

function liveOrigPath(corpusDir: string): string {
  return join(corpusDir, "live-session.orig.jsonl");
}

function scalingOrigPath(corpusDir: string, label: string): string {
  return join(corpusDir, "scaling-orig", `${label}.jsonl`);
}

function pinnedMtimeSec(lastTimestampMs: number): number {
  return Math.floor(lastTimestampMs / 1000);
}

function restoreSource(origPath: string, livePath: string, mtimeSec: number): void {
  copyFileSync(origPath, livePath);
  utimesSync(livePath, mtimeSec, mtimeSec);
}

function endsWithNewline(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function corpusLockPath(workDir: string, profile: string, seed: number): string {
  return join(workDir, `.bench-${profile}-${seed}.lock`);
}

export function acquireCorpusLock(lockPath: string): () => void {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new Error(`another bench run holds ${lockPath}; remove the lock if no run is active`);
    }
    throw error;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return () => rmSync(lockPath, { force: true });
}

type CorpusOptions = Pick<Options, "workDir" | "profile" | "seed" | "rebuildSeed">;

export async function prepareLockedCorpus(
  options: CorpusOptions,
): Promise<{ corpus: CorpusInfo; releaseLock: () => void }> {
  ensurePrivateDir(options.workDir);
  const releaseLock = acquireCorpusLock(
    corpusLockPath(options.workDir, options.profile, options.seed),
  );
  try {
    return { corpus: await ensureCorpus(options), releaseLock };
  } catch (error) {
    releaseLock();
    throw error;
  }
}

function assertInside(parent: string, child: string): void {
  if (!isInside(parent, child)) {
    throw new Error(`refusing to delete ${child}: outside ${parent}`);
  }
}

export function trustedCorpusManifest(value: unknown, dir: string): CorpusManifest | null {
  if (!isRecord(value)) return null;
  const expectedDirs: Record<string, string> = {
    outDir: dir,
    claudeDir: join(dir, "claude"),
    codexDir: join(dir, "codex"),
    copilotDir: join(dir, "copilot"),
  };
  for (const [key, expected] of Object.entries(expectedDirs)) {
    if (value[key] !== expected) return null;
  }
  const live = value.liveSession;
  if (
    !isRecord(live) ||
    typeof live.filePath !== "string" ||
    !isInside(expectedDirs.claudeDir as string, live.filePath)
  ) {
    return null;
  }
  const scaling = value.scalingFiles;
  if (!Array.isArray(scaling)) return null;
  for (const file of scaling) {
    if (
      !isRecord(file) ||
      typeof file.label !== "string" ||
      !/^[a-z0-9]+$/.test(file.label) ||
      typeof file.claudeDir !== "string" ||
      typeof file.filePath !== "string" ||
      !isInside(dir, file.claudeDir) ||
      !isInside(file.claudeDir, file.filePath)
    ) {
      return null;
    }
  }
  return value as unknown as CorpusManifest;
}

function mapManifestPaths(value: unknown, map: (path: string) => string): unknown {
  if (!isRecord(value)) return value;
  const at = (path: unknown): unknown => (typeof path === "string" ? map(path) : path);
  const live = value.liveSession;
  const scaling = value.scalingFiles;
  return {
    ...value,
    outDir: at(value.outDir),
    claudeDir: at(value.claudeDir),
    codexDir: at(value.codexDir),
    copilotDir: at(value.copilotDir),
    liveSession: isRecord(live) ? { ...live, filePath: at(live.filePath) } : live,
    scalingFiles: Array.isArray(scaling)
      ? scaling.map((file: unknown) =>
          isRecord(file)
            ? { ...file, claudeDir: at(file.claudeDir), filePath: at(file.filePath) }
            : file,
        )
      : scaling,
  };
}

export function portableCorpusManifest(manifest: CorpusManifest, dir: string): unknown {
  return mapManifestPaths(manifest, (path) => relative(dir, path) || ".");
}

export function cachedCorpusManifest(value: unknown, dir: string): CorpusManifest | null {
  return trustedCorpusManifest(
    mapManifestPaths(value, (path) => resolve(dir, path)),
    dir,
  );
}

function readCachedManifest(manifestPath: string, dir: string): CorpusManifest | null {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  try {
    return cachedCorpusManifest(JSON.parse(text), dir);
  } catch {
    return null;
  }
}

export function corpusNamespace(corpusDir: string): string {
  return createHash("sha256").update(resolve(corpusDir)).digest("hex").slice(0, 12);
}

export function corpusDirFor(options: Pick<Options, "workDir" | "profile" | "seed">): string {
  return resolve(options.workDir, `corpus-v${CORPUS_FORMAT}-${options.profile}-${options.seed}`);
}

async function ensureCorpus(options: CorpusOptions): Promise<CorpusInfo> {
  const dir = corpusDirFor(options);
  const manifestPath = join(dir, "manifest.json");
  const cached = options.rebuildSeed ? null : readCachedManifest(manifestPath, dir);
  if (cached !== null) {
    return { dir, manifest: cached, generatedNow: false, generateMs: null };
  }
  if (existsSync(dir)) {
    assertInside(options.workDir, dir);
    rmSync(dir, { recursive: true, force: true });
  }
  console.error(`[bench] generating ${options.profile} corpus (seed ${options.seed}) in ${dir}`);
  const started = performance.now();
  const manifest = await generateCorpus({
    outDir: dir,
    profile: options.profile,
    seed: options.seed,
    withScaling: true,
  });
  const live = manifest.liveSession;
  utimesSync(
    live.filePath,
    pinnedMtimeSec(live.lastTimestampMs),
    pinnedMtimeSec(live.lastTimestampMs),
  );
  publishCopy(live.filePath, liveOrigPath(dir));
  ensurePrivateDir(join(dir, "scaling-orig"));
  for (const file of manifest.scalingFiles ?? []) {
    const mtime = pinnedMtimeSec(file.lastTimestampMs);
    utimesSync(file.filePath, mtime, mtime);
    publishCopy(file.filePath, scalingOrigPath(dir, file.label));
  }
  const generateMs = performance.now() - started;
  publishText(manifestPath, `${JSON.stringify(portableCorpusManifest(manifest, dir), null, 2)}\n`);
  return { dir, manifest, generatedNow: true, generateMs };
}

async function schemaTag(): Promise<string> {
  const { LATEST_SCHEMA_VERSION } = await import("../src/db.ts");
  const { INGEST_PIPELINE_REVISION } = await import("../src/ingest.ts");
  return `s${LATEST_SCHEMA_VERSION}-r${INGEST_PIPELINE_REVISION}`;
}

interface DbStatRow {
  name: string;
  bytes: number;
  pages: number;
}

interface DbInspection {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  freelistBytes: number;
  autoVacuum: number;
  journalMode: string;
  dbstat: DbStatRow[] | null;
  dbstatError: string | null;
  integrityCheck: string | null;
  ftsIntegrityCheck: string | null;
}

function pragmaValue(db: Database, pragma: string): unknown {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null;
  return row === null ? null : Object.values(row)[0];
}

function inspectDb(path: string, opts: { integrity: boolean }): DbInspection {
  const db = new Database(path, { readonly: true });
  let inspection: DbInspection;
  try {
    const pageSize = Number(pragmaValue(db, "page_size"));
    const freelistCount = Number(pragmaValue(db, "freelist_count"));
    let dbstat: DbStatRow[] | null = null;
    let dbstatError: string | null = null;
    try {
      dbstat = db
        .query(
          "SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC",
        )
        .all() as DbStatRow[];
    } catch (error) {
      dbstatError = error instanceof Error ? error.message : String(error);
    }
    let integrityCheck: string | null = null;
    if (opts.integrity) {
      const rows = db.query("PRAGMA integrity_check").all() as Array<Record<string, string>>;
      integrityCheck = rows.map((row) => Object.values(row)[0]).join("; ");
    }
    inspection = {
      pageCount: Number(pragmaValue(db, "page_count")),
      pageSize,
      freelistCount,
      freelistBytes: freelistCount * pageSize,
      autoVacuum: Number(pragmaValue(db, "auto_vacuum")),
      journalMode: String(pragmaValue(db, "journal_mode")),
      dbstat,
      dbstatError,
      integrityCheck,
      ftsIntegrityCheck: null,
    };
  } finally {
    db.close();
  }
  if (opts.integrity) {
    const rw = new Database(path);
    try {
      rw.exec("INSERT INTO block_fts(block_fts, rank) VALUES ('integrity-check', 1)");
      inspection.ftsIntegrityCheck = "ok";
    } catch (error) {
      inspection.ftsIntegrityCheck = error instanceof Error ? error.message : String(error);
    } finally {
      rw.close();
    }
  }
  return inspection;
}

function checkpointAndClose(path: string): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}

function copyDb(from: string, to: string): void {
  removeDbFiles(to);
  copyFileSync(from, to, constants.COPYFILE_EXCL);
  chmodSync(to, 0o600);
}

interface SyncMeasurement {
  wallMs: number;
  exitCode: number;
  io: ProcIo;
  peakRssBytes: number;
  rssSamples: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  blockInBytes: number;
  blockOutBytes: number;
  fsync: FsyncCounts | null;
  report: Record<string, unknown> | null;
}

async function measureSync(
  env: Record<string, string>,
  cwd: string,
  straceFile: string | null,
): Promise<SyncMeasurement> {
  const base = [process.execPath, "run", CLI_PATH, "sync", "--json"];
  const cmd = straceFile === null ? base : [...straceArgs(straceFile), "--seccomp-bpf", ...base];
  const before = readOwnIo();
  let pollingRchar = before.readBytes;
  const started = performance.now();
  const proc = Bun.spawn(cmd, { env, cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let target: number | null = straceFile === null ? proc.pid : null;
  let peakRssKb = 0;
  let rssSamples = 0;
  const pollRss = (): void => {
    target ??= decantChild(proc.pid);
    if (target === null) return;
    try {
      peakRssKb = Math.max(peakRssKb, readStatus(target).vmHwmKb);
      rssSamples += 1;
    } catch {}
  };
  const rssPoller = setInterval(() => {
    const pre = readOwnIo();
    try {
      pollRss();
    } finally {
      const post = readOwnIo();
      pollingRchar += post.io.rchar - pre.io.rchar + post.readBytes;
    }
  }, RSS_POLL_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearInterval(rssPoller);
  const wallMs = performance.now() - started;
  const harnessIo = ioDelta(before.io, readProcIo("self"));
  const io = { ...harnessIo, rchar: Math.max(0, harnessIo.rchar - pollingRchar) };
  const usage = proc.resourceUsage();
  let report: Record<string, unknown> | null = null;
  try {
    report = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    if (exitCode !== 0) console.error(stderr.slice(-2000));
  }
  return {
    wallMs,
    exitCode,
    io,
    peakRssBytes: peakRssKb * 1024,
    rssSamples,
    cpuUserMs: Number(usage?.cpuTime.user ?? 0n) / 1000,
    cpuSystemMs: Number(usage?.cpuTime.system ?? 0n) / 1000,
    blockInBytes: (usage?.ops.in ?? 0) * 512,
    blockOutBytes: (usage?.ops.out ?? 0) * 512,
    fsync: straceFile === null ? null : countFsyncs(straceFile, target),
    report,
  };
}

function requireSyncSucceeded(label: string, measured: SyncMeasurement): void {
  const failure = syncFailure(measured);
  if (failure !== null) {
    throw new Error(`${label} ${failure}; the scaling run cannot be averaged`);
  }
}

function syncFailure(measured: SyncMeasurement): string | null {
  if (measured.exitCode !== 0) return `exited ${measured.exitCode}`;
  if (measured.report === null) return "printed no JSON report";
  if (measured.report.failed !== 0) return `reported failed=${String(measured.report.failed)}`;
  return null;
}

interface SeedInfo {
  path: string;
  cached: boolean;
  durationMs: number;
  exitCode: number;
  report: Record<string, unknown> | null;
  files: FileSizes;
  inspection: DbInspection;
}

async function ensureSeed(
  options: Options,
  label: string,
  cachePath: string,
  sources: SourceDirs,
  restore: () => void,
  scratchRoot: string,
): Promise<SeedInfo> {
  const metaPath = `${cachePath}.json`;
  if (!options.rebuildSeed && existsSync(cachePath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SeedInfo;
    return { ...meta, path: cachePath, cached: true };
  }
  console.error(`[bench] seeding ${label} database`);
  restore();
  const buildDir = join(scratchRoot, `seed-build-${label}-${Date.now()}`);
  ensurePrivateDir(buildDir);
  const buildDb = join(buildDir, "decant.db");
  const env = isolatedEnv(buildDir, buildDb, sources);
  const measured = await measureSync(env, buildDir, null);
  const failure = syncFailure(measured);
  if (failure !== null) {
    throw new Error(`seed sync for ${label} ${failure}; not caching its database`);
  }
  checkpointAndClose(buildDb);
  const info: SeedInfo = {
    path: cachePath,
    cached: false,
    durationMs: measured.wallMs,
    exitCode: measured.exitCode,
    report: measured.report,
    files: fileSizes(buildDb),
    inspection: inspectDb(buildDb, { integrity: false }),
  };
  publishCopy(buildDb, cachePath);
  publishText(metaPath, `${JSON.stringify(info, null, 2)}\n`);
  assertInside(scratchRoot, buildDir);
  rmSync(buildDir, { recursive: true, force: true });
  return info;
}

class Api {
  constructor(readonly base: string) {}

  async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return (await response.json()) as unknown;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`POST ${path} -> ${response.status}`);
    return (await response.json()) as unknown;
  }
}

interface SseEvent {
  type: string;
  atMs: number;
}

function streamEvents(api: Api, onEvent: (event: SseEvent) => void): AbortController {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(`${api.base}/api/events`, { signal: controller.signal });
      if (response.body === null) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
          let type = "message";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
          }
          onEvent({ type, atMs: performance.now() });
        }
      }
    } catch {}
  })();
  return controller;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown = null;
  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}${lastError === null ? "" : `: ${lastError}`}`);
}

interface SessionDetailPage {
  messageCount: number;
  messageCountOnPage: number;
  searchableText: string;
  hasMoreMessages: boolean;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative integer`);
  }
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sessionDetailPage(value: unknown): SessionDetailPage {
  if (!isRecord(value) || !isRecord(value.summary) || !Array.isArray(value.messages)) {
    throw new Error("session detail response has an unexpected shape");
  }
  const text: string[] = [];
  for (const message of value.messages) {
    const blocks = isRecord(message) && Array.isArray(message.blocks) ? message.blocks : [];
    for (const block of blocks) {
      if (isRecord(block)) {
        text.push(
          `${optionalString(block.text)}\n${optionalString(block.tool_input)}\n${optionalString(block.tool_result)}`,
        );
      }
    }
  }
  return {
    messageCount: nonNegativeInteger(value.summary.message_count, "summary.message_count"),
    messageCountOnPage: value.messages.length,
    searchableText: text.join("\n"),
    hasMoreMessages: value.has_more_messages === true,
  };
}

function syncIdle(value: unknown): boolean {
  if (!isRecord(value) || typeof value.in_progress !== "boolean") {
    throw new Error("sync status response has an unexpected shape");
  }
  return !value.in_progress && typeof value.last_sync_at === "string";
}

function searchHitCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return isRecord(value) && Array.isArray(value.results) ? value.results.length : 0;
}

async function findSessionId(api: Api, sourceSessionId: string): Promise<number> {
  for (let offset = 0; offset < 100_000; offset += 100) {
    const rows = await api.get(`/api/sessions?limit=100&offset=${offset}`);
    if (!Array.isArray(rows)) throw new Error("session list response is not an array");
    const match = rows.find(
      (row): row is Record<string, unknown> =>
        isRecord(row) && row.source_session_id === sourceSessionId,
    );
    if (match !== undefined) return nonNegativeInteger(match.id, "session id");
    if (rows.length < 100) break;
  }
  throw new Error(`live session ${sourceSessionId} is not in the archive`);
}

interface Distribution {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`;
}

function ms(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)} ms`;
}

function table(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n");
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

interface MarkerRecord {
  seq: number;
  marker: string;
  kind: (typeof LIVE_CHUNK_PATTERN)[number];
  bytes: number;
  appendedAtMs: number;
  apiMs: number | null;
  ftsMs: number | null;
}

interface ReplayContext {
  options: Options;
  corpus: CorpusInfo;
  seed: SeedInfo;
  clkTck: number;
}

async function runReplay(ctx: ReplayContext) {
  const { options, corpus } = ctx;
  const live = corpus.manifest.liveSession;
  const runStamp = stamp();
  const logDir = join(options.workDir, "runs", `${runStamp}-${options.profile}`);
  const runDir = join(options.runDir ?? join(options.workDir, "runs"), `${runStamp}-replay`);
  ensurePrivateDir(logDir);
  ensurePrivateDir(runDir);
  const dbPath = join(runDir, "decant.db");
  copyDb(ctx.seed.path, dbPath);
  restoreSource(liveOrigPath(corpus.dir), live.filePath, pinnedMtimeSec(live.lastTimestampMs));
  const needsLeadingNewline = !endsWithNewline(live.filePath);

  const env = isolatedEnv(
    runDir,
    dbPath,
    {
      claude: corpus.manifest.claudeDir,
      codex: corpus.manifest.codexDir,
      copilot: corpus.manifest.copilotDir,
    },
    options.env,
  );
  const port = await freePort();
  const serveCmd = [
    process.execPath,
    "run",
    CLI_PATH,
    "serve",
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    ...options.serveArgs,
  ];
  const straceFile = join(logDir, "strace.txt");
  const cmd =
    options.strace === "launch"
      ? [...straceArgs(straceFile), "--seccomp-bpf", ...serveCmd]
      : serveCmd;
  const spawnedAt = performance.now();
  const proc = Bun.spawn(cmd, {
    env,
    cwd: runDir,
    stdin: "ignore",
    stdout: Bun.file(join(logDir, "serve.stdout.log")),
    stderr: Bun.file(join(logDir, "serve.stderr.log")),
  });
  const cleanup = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  process.on("exit", cleanup);
  const servePid = options.strace === "launch" ? await childPid(proc.pid) : proc.pid;
  const api = new Api(`http://127.0.0.1:${port}`);

  await waitFor("GET /api/health", 120_000, async () =>
    (await fetch(`${api.base}/api/health`)).ok ? true : null,
  );
  const healthMs = performance.now() - spawnedAt;
  await waitFor("startup sync", 1_800_000, async () =>
    syncIdle(await api.get("/api/sync-status")) ? true : null,
  );
  const startupSyncMs = performance.now() - spawnedAt;
  const sessionId = await findSessionId(api, live.sessionId);
  const initialDetail = sessionDetailPage(
    await api.get(`/api/sessions/${sessionId}?message_limit=1&message_offset=0`),
  );
  let knownMessageCount = initialDetail.messageCount;
  let scannedOffset = knownMessageCount;
  const initialMessageCount = knownMessageCount;

  const events: SseEvent[] = [];
  let triggerCheck: () => void = () => undefined;
  const sse = streamEvents(api, (event) => {
    events.push(event);
    if (event.type === "archive_updated") triggerCheck();
  });

  let attachProc: ReturnType<typeof Bun.spawn> | null = null;
  if (options.strace === "attach") {
    attachProc = Bun.spawn([...straceArgs(straceFile), "-p", String(servePid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(join(logDir, "strace.attach.log")),
    });
    await Bun.sleep(1_000);
  }

  const markers: MarkerRecord[] = [];
  let acceptResults = true;
  let checking = false;
  let rerun = false;
  let checksRun = 0;
  const check = async (): Promise<void> => {
    if (checking) {
      rerun = true;
      return;
    }
    checking = true;
    try {
      do {
        rerun = false;
        const pendingApi = markers.filter((m) => m.apiMs === null);
        const pendingFts = markers.filter((m) => m.ftsMs === null);
        if (pendingApi.length === 0 && pendingFts.length === 0) break;
        checksRun += 1;
        if (pendingApi.length > 0) {
          let offset = Math.max(0, scannedOffset - 20);
          for (let page = 0; page < 10; page += 1) {
            const detail = sessionDetailPage(
              await api.get(
                `/api/sessions/${sessionId}?message_limit=200&message_offset=${offset}`,
              ),
            );
            if (!acceptResults) return;
            const seenAt = performance.now();
            const text = detail.searchableText;
            for (const marker of pendingApi) {
              if (marker.apiMs === null && text.includes(`${marker.marker} `)) {
                marker.apiMs = seenAt - marker.appendedAtMs;
              }
            }
            knownMessageCount = Math.max(knownMessageCount, detail.messageCount);
            offset += detail.messageCountOnPage;
            scannedOffset = Math.max(scannedOffset, offset);
            if (!detail.hasMoreMessages) break;
          }
        }
        for (const marker of pendingFts) {
          const result = await api.post("/api/search", {
            query: marker.marker,
            include_subagents: true,
            include_total: false,
            limit: 5,
          });
          if (!acceptResults) return;
          if (searchHitCount(result) > 0) marker.ftsMs = performance.now() - marker.appendedAtMs;
        }
      } while (rerun);
    } catch (error) {
      console.error(`[bench] freshness check failed: ${error}`);
    } finally {
      checking = false;
    }
  };
  triggerCheck = () => void check();

  const samples: Array<ProcSnapshot & { tSec: number }> = [];
  const start = snapshot(servePid, dbPath);
  const t0 = start.tMs;
  const t0Wall = Date.now() / 1000;
  const t1 = t0 + options.durationSec * 1000;
  samples.push({ ...start, tSec: 0 });
  const sampler = setInterval(() => {
    try {
      const sample = snapshot(servePid, dbPath);
      samples.push({ ...sample, tSec: round((sample.tMs - t0) / 1000) });
    } catch {}
  }, SAMPLE_INTERVAL_MS);
  const poller = setInterval(() => void check(), FRESHNESS_POLL_MS);

  console.error(
    `[bench] replay window ${options.durationSec}s, one append every ${options.cadenceMs} ms (serve pid ${servePid}, port ${port})`,
  );
  let state: LiveAppenderState = {
    sessionId: live.sessionId,
    projectDir: live.projectDir,
    lastUuid: live.lastUuid,
    lastTimestampMs: live.lastTimestampMs,
    turnIndex: live.turnIndex,
  };
  let appendedBytes = 0;
  for (let seq = 0; ; seq += 1) {
    const due = t0 + seq * options.cadenceMs;
    if (due >= t1) break;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const kind = LIVE_CHUNK_PATTERN[seq % LIVE_CHUNK_PATTERN.length] ?? "tool_burst";
    const marker = `${MARKER_PREFIX}${String(seq + 1).padStart(6, "0")}`;
    const chunk = generateLiveAppendChunk(state, { kind, marker });
    const body = `${seq === 0 && needsLeadingNewline ? "\n" : ""}${chunk.lines.join("\n")}\n`;
    appendFileSync(live.filePath, body);
    const appendedAtMs = performance.now();
    const bytes = Buffer.byteLength(body);
    appendedBytes += bytes;
    state = chunk.nextState;
    markers.push({ seq: seq + 1, marker, kind, bytes, appendedAtMs, apiMs: null, ftsMs: null });
  }
  const remaining = t1 - performance.now();
  if (remaining > 0) await Bun.sleep(remaining);
  const end = snapshot(servePid, dbPath);
  const t1Wall = Date.now() / 1000;
  clearInterval(sampler);
  samples.push({ ...end, tSec: round((end.tMs - t0) / 1000) });
  const resolvedInWindow = markers.filter(
    (m) =>
      m.apiMs !== null && m.ftsMs !== null && m.appendedAtMs + Math.max(m.apiMs, m.ftsMs) <= t1,
  ).length;

  const drainDeadline = performance.now() + DRAIN_TIMEOUT_MS;
  while (
    performance.now() < drainDeadline &&
    markers.some((m) => m.apiMs === null || m.ftsMs === null)
  ) {
    await check();
    await Bun.sleep(FRESHNESS_POLL_MS);
  }
  acceptResults = false;
  clearInterval(poller);
  sse.abort();

  if (attachProc !== null) {
    attachProc.kill("SIGINT");
    await attachProc.exited;
  }
  const stopAt = performance.now();
  process.kill(servePid, "SIGTERM");
  const exitCode = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
  const shutdownMs = performance.now() - stopAt;
  if (exitCode === null) cleanup();
  process.off("exit", cleanup);

  const windowFsync =
    options.strace === "off" ? null : countFsyncs(straceFile, servePid, t0Wall, t1Wall);
  const totalFsync = options.strace === "off" ? null : countFsyncs(straceFile, servePid);
  const db = inspectDb(dbPath, { integrity: true });
  const endFiles = fileSizes(dbPath);
  if (!options.keepRunDb) removeDbFiles(dbPath);

  const windowSec = (end.tMs - t0) / 1000;
  const perMinute = (value: number): number => round((value / windowSec) * 60, 0);
  const delta = ioDelta(start.io, end.io);
  const userSec = (end.cpuTicks.utime - start.cpuTicks.utime) / ctx.clkTck;
  const systemSec = (end.cpuTicks.stime - start.cpuTicks.stime) / ctx.clkTck;
  const windowSamples = samples.filter((sample) => sample.tMs <= end.tMs);
  const peak = (pick: (s: ProcSnapshot) => number): number => Math.max(...windowSamples.map(pick));
  const inWindow = (event: SseEvent): boolean => event.atMs >= t0 && event.atMs <= end.tMs;
  const apiLatencies = markers.flatMap((m) => (m.apiMs === null ? [] : [m.apiMs]));
  const ftsLatencies = markers.flatMap((m) => (m.ftsMs === null ? [] : [m.ftsMs]));

  return {
    logDir,
    runDir,
    port,
    servePid,
    straceMode: options.strace,
    serveArgs: options.serveArgs,
    sessionId,
    startup: { healthMs: round(healthMs), startupSyncMs: round(startupSyncMs) },
    window: {
      durationSec: round(windowSec, 2),
      cadenceMs: options.cadenceMs,
      appends: markers.length,
      appendedBytes,
      initialMessageCount,
      finalMessageCount: knownMessageCount,
      syncEvents: events.filter((e) => e.type === "sync" && inWindow(e)).length,
      archiveUpdatedEvents: events.filter((e) => e.type === "archive_updated" && inWindow(e))
        .length,
      freshnessChecks: checksRun,
    },
    io: {
      start: start.io,
      end: end.io,
      delta,
      perMinute: {
        rchar: perMinute(delta.rchar),
        wchar: perMinute(delta.wchar),
        read_bytes: perMinute(delta.read_bytes),
        write_bytes: perMinute(delta.write_bytes),
        cancelled_write_bytes: perMinute(delta.cancelled_write_bytes),
        syscr: perMinute(delta.syscr),
        syscw: perMinute(delta.syscw),
      },
    },
    cpu: {
      clkTck: ctx.clkTck,
      userSec: round(userSec, 2),
      systemSec: round(systemSec, 2),
      totalSec: round(userSec + systemSec, 2),
      percentOfOneCore: round(((userSec + systemSec) / windowSec) * 100, 2),
    },
    memory: {
      rssStartKb: start.status.vmRssKb,
      rssEndKb: end.status.vmRssKb,
      rssPeakSampledKb: peak((s) => s.status.vmRssKb),
      vmHwmKb: end.status.vmHwmKb,
      threadsStart: start.status.threads,
      threadsEnd: end.status.threads,
    },
    files: {
      start: start.files,
      peak: {
        db: peak((s) => s.files.db),
        wal: peak((s) => s.files.wal),
        shm: peak((s) => s.files.shm),
      },
      end: end.files,
      afterShutdown: endFiles,
    },
    handles: { start: start.handles, end: end.handles },
    fsync: { window: windowFsync, wholeRun: totalFsync },
    freshness: {
      api: distribution(apiLatencies),
      fts: distribution(ftsLatencies),
      unresolvedApi: markers.filter((m) => m.apiMs === null).length,
      unresolvedFts: markers.filter((m) => m.ftsMs === null).length,
      resolvedInWindow,
      resolvedInDrain:
        markers.filter((m) => m.apiMs !== null && m.ftsMs !== null).length - resolvedInWindow,
      markers: markers.map((m) => ({
        seq: m.seq,
        marker: m.marker,
        kind: m.kind,
        bytes: m.bytes,
        appendedAtSec: round((m.appendedAtMs - t0) / 1000, 3),
        apiMs: m.apiMs === null ? null : round(m.apiMs),
        ftsMs: m.ftsMs === null ? null : round(m.ftsMs),
      })),
    },
    shutdown: { ms: round(shutdownMs), exitCode },
    db,
    samples: samples.map((sample) => ({
      tSec: sample.tSec,
      io: sample.io,
      cpuTicks: sample.cpuTicks,
      vmRssKb: sample.status.vmRssKb,
      threads: sample.status.threads,
      files: sample.files,
      handles: sample.handles,
    })),
  };
}

async function runScaling(options: Options, corpus: CorpusInfo, tag: string) {
  const results = [];
  const scratchRoot = options.runDir ?? join(options.workDir, "runs");
  for (const file of corpus.manifest.scalingFiles ?? []) {
    const mtime = pinnedMtimeSec(file.lastTimestampMs);
    const restore = (): void =>
      restoreSource(scalingOrigPath(corpus.dir, file.label), file.filePath, mtime);
    const seed = await ensureSeed(
      options,
      `scaling-${file.label}`,
      join(
        options.workDir,
        `seed-${options.profile}-${options.seed}-${tag}-${corpusNamespace(corpus.dir)}-scaling-${file.label}.db`,
      ),
      { claude: file.claudeDir },
      restore,
      scratchRoot,
    );
    const runStamp = stamp();
    const logDir = join(options.workDir, "runs", `${runStamp}-scaling-${file.label}`);
    const runDir = join(scratchRoot, `${runStamp}-scaling-${file.label}`);
    ensurePrivateDir(logDir);
    ensurePrivateDir(runDir);
    const dbPath = join(runDir, "decant.db");
    copyDb(seed.path, dbPath);
    restore();
    const env = isolatedEnv(runDir, dbPath, { claude: file.claudeDir }, options.env);
    const strace = (name: string): string | null =>
      options.strace === "off" ? null : join(logDir, `strace-${name}.txt`);
    console.error(`[bench] scaling ${file.label}: no-op sync + ${SCALING_APPENDS} appends`);
    const appends: Array<SyncMeasurement & { appendBytes: number; fileBytes: number }> = [];
    let noop: SyncMeasurement;
    let files: FileSizes;
    try {
      noop = await measureSync(env, runDir, strace("noop"));
      requireSyncSucceeded(`scaling ${file.label} no-op sync`, noop);
      let state: LiveAppenderState = {
        sessionId: file.sessionId,
        projectDir: basename(dirname(file.filePath)),
        lastUuid: file.lastUuid,
        lastTimestampMs: file.lastTimestampMs,
        turnIndex: 0,
      };
      const needsLeadingNewline = !endsWithNewline(file.filePath);
      for (let i = 0; i < SCALING_APPENDS; i += 1) {
        const chunk = generateLiveAppendChunk(state, {
          kind: "tool_burst",
          marker: `${MARKER_PREFIX}s${String(i + 1).padStart(5, "0")}`,
        });
        const body = `${i === 0 && needsLeadingNewline ? "\n" : ""}${chunk.lines.join("\n")}\n`;
        appendFileSync(file.filePath, body);
        state = chunk.nextState;
        const measured = await measureSync(env, runDir, strace(`append-${i + 1}`));
        requireSyncSucceeded(`scaling ${file.label} append ${i + 1} sync`, measured);
        appends.push({
          appendBytes: Buffer.byteLength(body),
          fileBytes: statSync(file.filePath).size,
          ...measured,
        });
      }
      files = fileSizes(dbPath);
    } finally {
      if (!options.keepRunDb) removeDbFiles(dbPath);
      restore();
    }
    const avg = (pick: (a: (typeof appends)[number]) => number): number =>
      appends.reduce((sum, a) => sum + pick(a), 0) / appends.length;
    results.push({
      label: file.label,
      targetMb: file.targetMb,
      sessionBytes: file.bytes,
      logDir,
      seed: {
        cached: seed.cached,
        durationMs: round(seed.durationMs),
        files: seed.files,
      },
      noop,
      appends,
      mean: {
        wallMs: round(avg((a) => a.wallMs)),
        writeBytes: round(
          avg((a) => a.io.write_bytes),
          0,
        ),
        readBytes: round(
          avg((a) => a.io.read_bytes),
          0,
        ),
        rchar: round(
          avg((a) => a.io.rchar),
          0,
        ),
        wchar: round(
          avg((a) => a.io.wchar),
          0,
        ),
        fsyncs: round(
          avg((a) => (a.fsync?.fsync ?? 0) + (a.fsync?.fdatasync ?? 0)),
          1,
        ),
        peakRssBytes: Math.max(...appends.map((a) => a.peakRssBytes)),
        cpuMs: round(avg((a) => a.cpuUserMs + a.cpuSystemMs)),
      },
      dbFilesAfter: files,
    });
  }
  return results;
}

type Replay = Awaited<ReturnType<typeof runReplay>>;
type Scaling = Awaited<ReturnType<typeof runScaling>>;

function printReplay(replay: Replay, seed: SeedInfo): void {
  const fsync = replay.fsync.window;
  const fsyncText =
    fsync === null
      ? "not traced"
      : `${fsync.fsync + fsync.fdatasync} (fsync ${fsync.fsync}, fdatasync ${fsync.fdatasync}; ${Object.entries(
          fsync.byFile,
        )
          .map(([file, count]) => `${file} ${count}`)
          .join(
            ", ",
          )}; ${fsync.distinctThreads} threads, ${fsync.otherThreads} off the main thread)`;
  const f = replay.files;
  const fresh = replay.freshness;
  console.log("\nSteady-state replay");
  console.log(
    table([
      [
        "seed",
        `${seed.cached ? "cached" : "built"}, ${mb(seed.files.db)}, sync ${ms(seed.durationMs)}`,
      ],
      [
        "startup",
        `health ${ms(replay.startup.healthMs)}, sync idle ${ms(replay.startup.startupSyncMs)}`,
      ],
      [
        "window",
        `${replay.window.durationSec}s, ${replay.window.appends} appends (${mb(replay.window.appendedBytes)}), ${replay.window.syncEvents} syncs`,
      ],
      ["write_bytes/min", mb(replay.io.perMinute.write_bytes)],
      ["read_bytes/min", mb(replay.io.perMinute.read_bytes)],
      ["rchar/min", mb(replay.io.perMinute.rchar)],
      ["wchar/min", mb(replay.io.perMinute.wchar)],
      ["fsync+fdatasync", fsyncText],
      [
        "cpu",
        `${replay.cpu.totalSec}s (user ${replay.cpu.userSec}s, sys ${replay.cpu.systemSec}s) = ${replay.cpu.percentOfOneCore}% of one core`,
      ],
      [
        "rss",
        `start ${mb(replay.memory.rssStartKb * 1024)}, end ${mb(replay.memory.rssEndKb * 1024)}, peak sampled ${mb(replay.memory.rssPeakSampledKb * 1024)}, VmHWM ${mb(replay.memory.vmHwmKb * 1024)}`,
      ],
      ["db", `${mb(f.start.db)} -> peak ${mb(f.peak.db)} -> ${mb(f.end.db)}`],
      ["wal", `${mb(f.start.wal)} -> peak ${mb(f.peak.wal)} -> ${mb(f.end.wal)}`],
      ["shm", `${mb(f.start.shm)} -> peak ${mb(f.peak.shm)} -> ${mb(f.end.shm)}`],
      ["freelist", mb(replay.db.freelistBytes)],
      [
        "append->API",
        `p50 ${ms(fresh.api.p50)}, p95 ${ms(fresh.api.p95)}, max ${ms(fresh.api.max)} (${fresh.unresolvedApi} unresolved)`,
      ],
      [
        "append->FTS",
        `p50 ${ms(fresh.fts.p50)}, p95 ${ms(fresh.fts.p95)}, max ${ms(fresh.fts.max)} (${fresh.unresolvedFts} unresolved)`,
      ],
      ["shutdown", `${ms(replay.shutdown.ms)}, exit ${replay.shutdown.exitCode}`],
      ["integrity_check", replay.db.integrityCheck ?? "n/a"],
      ["fts integrity", replay.db.ftsIntegrityCheck ?? "n/a"],
    ]),
  );
  const top = (replay.db.dbstat ?? []).slice(0, 8);
  if (top.length > 0) {
    console.log("\n  largest tables and indexes");
    console.log(table(top.map((row) => [`  ${row.name}`, mb(row.bytes)])));
  }
  if (replay.straceMode !== "off") {
    console.log(
      `\n  note: strace (${replay.straceMode}) inflates cpu, append latency, and scaling sync time; rerun with --strace off for those`,
    );
  }
}

function printScaling(scaling: Scaling): void {
  console.log("\nPer-sync cost vs session size (mean of 5 appends, one tool_burst each)");
  const header = ["size", "no-op ms", "sync ms", "write", "read", "rchar", "fsyncs", "peak rss"];
  const rows = scaling.map((row) => [
    row.label,
    String(Math.round(row.noop.wallMs)),
    String(Math.round(row.mean.wallMs)),
    mb(row.mean.writeBytes),
    mb(row.mean.readBytes),
    mb(row.mean.rchar),
    String(row.mean.fsyncs),
    mb(row.mean.peakRssBytes),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    `  ${cells.map((cell, i) => cell.padStart(widths[i] ?? 0)).join("  ")}`;
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

async function runNative(options: Options): Promise<number> {
  if (!existsSync("/proc/self/io")) {
    throw new Error("--native needs Linux /proc; use --docker on macOS");
  }
  if (options.strace !== "off" && Bun.spawnSync(["strace", "-V"]).exitCode !== 0) {
    throw new Error("strace is not installed; install it or pass --strace off");
  }
  ensurePrivateDir(options.workDir);
  const scratchRoot = options.runDir ?? join(options.workDir, "runs");
  ensurePrivateDir(scratchRoot);
  const tag = await schemaTag();
  const { corpus, releaseLock } = await prepareLockedCorpus(options);
  const live = corpus.manifest.liveSession;

  let seed: SeedInfo | null = null;
  let replay: Replay | null = null;
  let scaling: Scaling | null = null;
  try {
    const clkTck = clockTicks();
    if (!options.scalingOnly) {
      seed = await ensureSeed(
        options,
        options.profile,
        join(
          options.workDir,
          `seed-${options.profile}-${options.seed}-${tag}-${corpusNamespace(corpus.dir)}.db`,
        ),
        {
          claude: corpus.manifest.claudeDir,
          codex: corpus.manifest.codexDir,
          copilot: corpus.manifest.copilotDir,
        },
        () =>
          restoreSource(
            liveOrigPath(corpus.dir),
            live.filePath,
            pinnedMtimeSec(live.lastTimestampMs),
          ),
        scratchRoot,
      );
      replay = await runReplay({ options, corpus, seed, clkTck });
    }
    scaling = options.scaling ? await runScaling(options, corpus, tag) : null;
  } finally {
    releaseLock();
  }

  const report = {
    tool: "decant-bench-ingest",
    reportVersion: 1,
    finishedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? null,
      memTotalBytes: totalmem(),
      bunVersion: Bun.version,
      inContainer: existsSync("/.dockerenv"),
    },
    options: { ...options, env: Object.keys(options.env).sort() },
    schemaTag: tag,
    corpus: {
      dir: corpus.dir,
      generatedNow: corpus.generatedNow,
      generateMs: corpus.generateMs === null ? null : round(corpus.generateMs),
      stats: corpus.manifest.stats,
      liveSession: live,
    },
    seed,
    replay,
    scaling,
    notes: [
      "I/O, CPU, and memory come from /proc/<pid> of the decant serve process; /proc/<pid>/io and /proc/<pid>/stat cover every thread, including the sync worker.",
      "Steady-state deltas use snapshots taken exactly at the start and end of the replay window, before the drain and shutdown.",
      "strace launch mode runs serve under strace --seccomp-bpf -f so only fsync/fdatasync stop the tracee; worker threads created later are followed. Attach mode (-p) cannot use seccomp-bpf and stops on every syscall.",
      "Any strace mode still raises serve CPU (mostly system time) and append-to-visible latency, while write volume stays comparable. Take CPU and freshness from a --strace off run and fsync counts from a traced run.",
      "Scaling peak RSS is the sync child's VmHWM polled every 5 ms; Bun's resourceUsage().maxRSS is a running maximum across all reaped children, so it is not used.",
      "Freshness latency is measured from the append to the first check that saw the marker; checks run on every archive_updated SSE event and every 500 ms.",
      "Scaling I/O is the harness's /proc/self/io delta across the spawned sync (reaped children are folded into the parent), so it includes strace's own small log writes. The harness's own /proc reads for RSS polling are measured around each poll and subtracted from rchar.",
    ],
  };

  if (seed !== null && replay !== null) printReplay(replay, seed);
  if (scaling !== null) printScaling(scaling);
  if (options.outJson !== null) {
    mkdirSync(dirname(options.outJson), { recursive: true, mode: 0o700 });
    publishText(options.outJson, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[bench] wrote ${options.outJson}`);
  }
  const failed =
    replay !== null &&
    (replay.db.integrityCheck !== "ok" ||
      replay.db.ftsIntegrityCheck !== "ok" ||
      replay.freshness.unresolvedApi > 0 ||
      replay.freshness.unresolvedFts > 0);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) {
      console.log(USAGE);
      process.exit(0);
    }
    const code = options.mode === "docker" ? await runInDocker(options) : await runNative(options);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
