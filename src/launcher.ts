import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentKey, IdeKey, TerminalKey, UserSettings } from "./settings.ts";

export const agents: Record<AgentKey, { bin: string; label: string }> = {
  claude: { bin: "claude", label: "Claude" },
  codex: { bin: "codex", label: "Codex" },
};

const ideApps: Record<IdeKey, { app: string; label: string }> = {
  vscode: { app: "Visual Studio Code", label: "VS Code" },
  cursor: { app: "Cursor", label: "Cursor" },
  zed: { app: "Zed", label: "Zed" },
  sublime: { app: "Sublime Text", label: "Sublime Text" },
  intellij: { app: "IntelliJ IDEA", label: "IntelliJ IDEA" },
};

export interface LaunchResult {
  ok: boolean;
  error?: string;
  command?: string;
}

type Run = (bin: string, args: string[]) => LaunchResult | Promise<LaunchResult>;

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  run?: Run;
  tempName?: () => string;
  /** Test seam for Warp's observable config-consumption check. */
  warpConsumed?: (configDir: string) => boolean | Promise<boolean>;
}

const STALE_LAUNCH_AGE_MS = 24 * 60 * 60 * 1000;
const WARP_CONSUME_TIMEOUT_MS = 1_500;

export function canLaunch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function command(agent: string, prompt: string): string | null {
  const got = agents[agent as AgentKey];
  return got == null ? null : `${got.bin} ${shellQuote(prompt)}`;
}

export async function launchAgent(
  agent: string,
  prompt: string,
  key: string | null,
  settings: UserSettings,
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  const got = agents[agent as AgentKey];
  if (got == null) {
    return { ok: false, error: "Unknown agent." };
  }
  const fullPrompt = withMarkInstruction(prompt, key);
  if (!canLaunch(options.platform)) {
    return {
      ok: false,
      error: "Opening a terminal is only supported on macOS right now.",
      command: command(agent, fullPrompt) ?? undefined,
    };
  }
  await sweepStaleLaunchDirs();

  // mkdtemp gives a fresh 0700 directory, so no other local user can
  // pre-plant a symlink at a predictable /tmp name or read the prompt; the
  // file itself is 0600 and the launched shell removes the whole directory
  // after consuming it.
  const promptDir = mkdtempSync(join(tmpdir(), "decant-launch-"));
  const promptFile = join(promptDir, options.tempName?.() ?? "prompt.txt");
  writeFileSync(promptFile, fullPrompt, { mode: 0o600 });
  const dir = options.env?.DECANT_SKILLS_DIR ?? process.env.DECANT_SKILLS_DIR ?? homelikeDir();
  const launchCommand =
    `cd ${shellQuote(dir)} && ${got.bin} "$(cat ${shellQuote(promptFile)}; ` +
    `rm -rf ${shellQuote(promptDir)})"`;
  const result = await launchIn(
    settings.terminal,
    launchCommand,
    options.run ?? runCommand,
    options.env,
    options.warpConsumed,
  );
  if (!result.ok) {
    rmSync(promptDir, { recursive: true, force: true });
    if (result.command != null) {
      return { ...result, command: command(agent, fullPrompt) ?? result.command };
    }
  }
  return result;
}

export async function openIde(
  dir: string,
  settings: Pick<UserSettings, "ide">,
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  if (!canLaunch(options.platform)) {
    return { ok: false, error: "Opening an IDE is only supported on macOS right now." };
  }
  if (!existsSync(dir)) {
    return { ok: false, error: "That project folder no longer exists." };
  }
  return await (options.run ?? runCommand)("open", ["-a", ideApps[settings.ide].app, dir]);
}

async function launchIn(
  terminal: TerminalKey,
  cmd: string,
  run: Run,
  env: Record<string, string | undefined> | undefined,
  warpConsumed: LaunchOptions["warpConsumed"],
): Promise<LaunchResult> {
  switch (terminal) {
    case "iterm":
      return await run("osascript", ["-e", itermScript(cmd)]);
    case "ghostty":
      return await openArgs("Ghostty", ["-e", shell(env), "-lc", cmd], run);
    case "warp": {
      const launch = createWarpLaunch(cmd, env);
      const result = await run("open", [launch.uri]);
      const consumed =
        result.ok &&
        (await (warpConsumed?.(launch.configDir) ?? waitForPathRemoval(launch.configDir)));
      if (!result.ok || !consumed) {
        rmSync(launch.configDir, { recursive: true, force: true });
        const fallback = await run("open", [
          `warp://action/new_tab?path=${encodeURIComponent(launch.cwd)}`,
        ]);
        if (fallback.ok) {
          return {
            ok: false,
            error:
              "Warp opened the project directory but did not confirm that it started the agent.",
            command: cmd,
          };
        }
        return {
          ok: false,
          error:
            [
              result.error ?? (consumed ? null : "Warp did not consume the launch configuration."),
              fallback.error,
            ]
              .filter(Boolean)
              .join(" · ") || "launch failed",
        };
      }
      return result;
    }
    case "alacritty":
      return await openArgs("Alacritty", ["-e", shell(env), "-lc", cmd], run);
    case "kitty":
      return await openArgs("kitty", [shell(env), "-lc", cmd], run);
    case "wezterm":
      return await openArgs("WezTerm", ["start", "--", shell(env), "-lc", cmd], run);
    default:
      return await run("osascript", ["-e", terminalAppScript(cmd)]);
  }
}

export function warpLaunchUri(
  cmd: string,
  env: Record<string, string | undefined> | undefined,
): string {
  return createWarpLaunch(cmd, env).uri;
}

function createWarpLaunch(
  cmd: string,
  env: Record<string, string | undefined> | undefined,
): { configDir: string; cwd: string; uri: string } {
  const configDir = mkdtempSync(join(tmpdir(), "decant-warp-"));
  const configPath = join(configDir, "decant.yaml");
  const cwd = resolve(env?.DECANT_SKILLS_DIR ?? process.env.DECANT_SKILLS_DIR ?? homelikeDir());
  // Warp accepts a percent-encoded absolute launch-config path. Delete the
  // private config before starting the interactive command: disappearance is
  // the acknowledgement launchIn waits for, and it leaves no prompt-bearing
  // config behind for a long-lived agent process.
  const cleanupCommand = `rm -rf ${shellQuote(configDir)}; ${cmd}`;
  const config = `---
name: decant agent
windows:
  - tabs:
      - title: decant
        layout:
          cwd: ${JSON.stringify(cwd)}
          commands:
            - exec: ${JSON.stringify(cleanupCommand)}
`;
  writeFileSync(configPath, config, { mode: 0o600 });
  return { configDir, cwd, uri: `warp://launch/${encodeURIComponent(configPath)}` };
}

async function waitForPathRemoval(path: string): Promise<boolean> {
  const deadline = Date.now() + WARP_CONSUME_TIMEOUT_MS;
  while (existsSync(path) && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  return !existsSync(path);
}

async function sweepStaleLaunchDirs(now = Date.now()): Promise<void> {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("decant-launch-") && !entry.startsWith("decant-warp-")) {
      continue;
    }
    const path = join(root, entry);
    try {
      if (now - (await stat(path)).mtimeMs >= STALE_LAUNCH_AGE_MS) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best-effort; launch must not fail on a raced or inaccessible
      // temp entry.
    }
  }
}

function openArgs(app: string, args: string[], run: Run): LaunchResult | Promise<LaunchResult> {
  return run("open", ["-na", app, "--args", ...args]);
}

async function runCommand(bin: string, args: string[]): Promise<LaunchResult> {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (status === 0) {
      return { ok: true };
    }
    return { ok: false, error: (stderr || stdout || "launch failed").trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function withMarkInstruction(prompt: string, key: string | null): string {
  return key == null || key === ""
    ? prompt
    : `${prompt}\n\nWhen you have completed and verified this, run: decant recommendations mark ${key}`;
}

function terminalAppScript(cmd: string): string {
  return `tell application "Terminal"
  activate
  do script ${applescriptString(cmd)}
end tell`;
}

function itermScript(cmd: string): string {
  return `tell application "iTerm"
  activate
  set w to (create window with default profile)
  tell current session of w to write text ${applescriptString(cmd)}
end tell`;
}

function shell(env: Record<string, string | undefined> | undefined): string {
  return env?.SHELL ?? process.env.SHELL ?? "/bin/zsh";
}

function homelikeDir(): string {
  return process.env.HOME ?? ".";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applescriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
