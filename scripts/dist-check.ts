#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTarget,
  nativeTarget,
  packageDirName,
  readTargets,
  stageNpmPackages,
} from "./distribution.ts";

const version = process.env.DECANT_DISTCHECK_VERSION ?? "0.0.0-check";
const isTemporaryRoot = process.env.DECANT_DISTCHECK_DIR == null;
const outRoot = process.env.DECANT_DISTCHECK_DIR ?? mkdtempSync(join(tmpdir(), "decant-check-"));
if (isTemporaryRoot) {
  process.on("exit", () => {
    try {
      rmSync(outRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not mask the distribution check result.
    }
  });
}
const binaryDir = join(outRoot, "bin");
const npmDir = join(outRoot, "npm");
const packDir = join(outRoot, "packs");
const installDir = join(outRoot, "install");
const npmEnv = { npm_config_cache: join(outRoot, "npm-cache") };
const target = nativeTarget(readTargets());

if (target == null) {
  throw new Error(`unsupported native target ${process.platform}/${process.arch}`);
}

const binary = buildTarget(target, { outDir: binaryDir, version });
assertVersion(binary, ["--version"], {}, version);
await assertCompiledServe(binary, version);

stageNpmPackages({
  outDir: npmDir,
  binaryDir,
  targets: [target],
  buildMissing: false,
  clean: true,
  version,
});

assertVersion(
  "node",
  [join(npmDir, "decant", "bin", "decant.cjs"), "--version"],
  { DECANT_BINARY_PATH: binary },
  version,
);

mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
const launcherPack = npmPack(join(npmDir, "decant"), packDir);
const platformPack = npmPack(join(npmDir, packageDirName(target)), packDir);
runCommand(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", launcherPack, platformPack],
  {
    cwd: installDir,
    env: npmEnv,
  },
);
assertVersion(
  "node",
  [join(installDir, "node_modules", "@dosu", "decant", "bin", "decant.cjs"), "--version"],
  { DECANT_BINARY_PATH: undefined },
  version,
);

process.stdout.write(`dist check ok for ${target.key} (${version})\n`);

function npmPack(packageDir: string, packDestination: string): string {
  const result = runCommand("npm", ["pack", packageDir, "--pack-destination", packDestination], {
    env: npmEnv,
  });
  const file = result.stdout.trim().split("\n").at(-1);
  if (file == null || file === "") {
    throw new Error(`npm pack ${packageDir} did not report a tarball`);
  }
  return join(packDestination, file);
}

function assertVersion(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  expected: string,
): void {
  const result = runCommand(command, args, { env });
  if (!result.stdout.includes(expected)) {
    throw new Error(`expected ${expected} in version output, got: ${result.stdout.trim()}`);
  }
}

async function assertCompiledServe(binary: string, expectedVersion: string): Promise<void> {
  const serveDir = mkdtempSync(join(outRoot, "serve-"));
  const claudeDir = join(serveDir, "claude");
  const codexDir = join(serveDir, "codex");
  const codexSessionsDir = join(codexDir, "sessions");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
  copyFileSync(
    join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl"),
    join(codexSessionsDir, "rollout-sample.jsonl"),
  );
  const proc = Bun.spawn(
    [
      binary,
      "--db",
      join(serveDir, "decant.db"),
      "--no-sync",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--claude-dir",
      claudeDir,
      "--codex-dir",
      codexDir,
    ],
    {
      env: {
        ...process.env,
        DECANT_CONFIG_DIR: join(serveDir, "config"),
        DECANT_LOG_LEVEL: "info",
      },
      stderr: "pipe",
      stdout: "ignore",
    },
  );
  let startupTimeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const port = await Promise.race([
      readServePort(proc),
      new Promise<never>(
        (_resolve, reject) =>
          (startupTimeout = setTimeout(
            () => reject(new Error("compiled binary did not start within 10s")),
            10_000,
          )),
      ),
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
    if (!response.ok) {
      throw new Error(`compiled binary returned ${response.status} for /api/openapi.json`);
    }
    const document = (await response.json()) as {
      info?: { version?: unknown };
      paths?: Record<string, unknown>;
    };
    if (document.info?.version !== expectedVersion) {
      throw new Error(
        `compiled OpenAPI version was ${String(document.info?.version)}, expected ${expectedVersion}`,
      );
    }
    if (document.paths?.["/api/health"] == null) {
      throw new Error("compiled OpenAPI document is missing /api/health");
    }

    await assertCompiledUiBundle(port);

    const syncResponse = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!syncResponse.ok) {
      throw new Error(
        `compiled binary returned ${syncResponse.status} for /api/sync: ${await syncResponse.text()}`,
      );
    }
    const report = (await syncResponse.json()) as {
      scanned?: unknown;
      ingested?: unknown;
      failed?: unknown;
    };
    if (report.scanned !== 1 || report.ingested !== 1 || report.failed !== 0) {
      throw new Error(`compiled sync returned an unexpected report: ${JSON.stringify(report)}`);
    }

    await assertCompiledEconomics(port);
  } finally {
    if (startupTimeout != null) {
      clearTimeout(startupTimeout);
    }
    proc.kill();
    await proc.exited;
  }
}

// --minify rewrites the UI bundle and leaves the server untouched, so every
// other check in this file could pass against a bundle that fails to parse.
// This is the one check that fetches the bundle's actual bytes from the
// running binary rather than an API route.
//
// It proves the bytes are intact and syntactically valid JavaScript, not that
// the app renders: `new Function(code)` compiles the source without invoking
// it, so it catches truncation or minifier corruption but not a runtime throw
// from `createRoot(root).render(...)`, which needs a real DOM (canvas, for
// echarts) that nothing in this repo currently emulates. Closing that gap
// means either a real browser or a DOM/canvas shim, and that's a dependency
// decision for whoever picks it up, not something to fake here.
async function assertCompiledUiBundle(port: number): Promise<void> {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  if (!page.ok) {
    throw new Error(`compiled binary returned ${page.status} for /`);
  }
  const html = await page.text();
  const scriptSrc = /<script[^>]*\ssrc="([^"]+\.js)"/.exec(html)?.[1];
  if (scriptSrc == null) {
    throw new Error(`compiled binary's / did not link a bundled script:\n${html}`);
  }
  const bundleUrl = new URL(scriptSrc, `http://127.0.0.1:${port}`);
  const bundle = await fetch(bundleUrl);
  if (!bundle.ok) {
    throw new Error(`compiled binary returned ${bundle.status} for ${scriptSrc}`);
  }
  const code = await bundle.text();
  // Comfortably under the measured minified size (3,211,476 B) and comfortably
  // over an empty or stub response, so this only trips on real truncation.
  if (code.length < 500_000) {
    throw new Error(`compiled UI bundle at ${scriptSrc} looks truncated: ${code.length} bytes`);
  }
  try {
    new Function(code);
  } catch (error) {
    throw new Error(
      `compiled UI bundle at ${scriptSrc} does not parse: ${(error as Error).message}`,
    );
  }
}

async function assertCompiledEconomics(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/analytics/token-economics`);
    if (!response.ok) {
      throw new Error(
        `compiled binary returned ${response.status} for token economics: ${await response.text()}`,
      );
    }
    latest = await response.json();
    const totals = (latest as { totals?: Record<string, unknown> } | null)?.totals;
    if (
      typeof totals?.generation_tokens === "number" &&
      totals.generation_tokens > 0 &&
      typeof totals.estimated_cost_usd === "number" &&
      totals.estimated_cost_usd > 0
    ) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`compiled token economics stayed empty: ${JSON.stringify(latest)}`);
}

async function readServePort(proc: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<number> {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let log = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`compiled binary stopped before reporting a port: ${log.slice(0, 500)}`);
    }
    log += decoder.decode(value, { stream: true });
    const match = log.match(/"server\.port":\s*(\d+)/);
    if (match?.[1] != null) {
      return Number(match[1]);
    }
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string } {
  const env = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      delete env[key];
    }
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env,
    stdio: "pipe",
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? 1}: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
