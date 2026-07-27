import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  run?: (bin: string, args: string[]) => LaunchResult;
  tempName?: () => string;
}

export function canLaunch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function ideLabel(key: IdeKey): string {
  return ideApps[key]?.label ?? "IDE";
}

export function command(agent: string, prompt: string): string | null {
  const got = agents[agent as AgentKey];
  return got == null ? null : `${got.bin} ${shellQuote(prompt)}`;
}

export function launchAgent(
  agent: string,
  prompt: string,
  key: string | null,
  settings: UserSettings,
  options: LaunchOptions = {},
): LaunchResult {
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
  return launchIn(settings.terminal, launchCommand, options.run ?? runCommand, options.env);
}

export function openIde(
  dir: string,
  settings: Pick<UserSettings, "ide">,
  options: LaunchOptions = {},
): LaunchResult {
  if (!canLaunch(options.platform)) {
    return { ok: false, error: "Opening an IDE is only supported on macOS right now." };
  }
  if (!existsSync(dir)) {
    return { ok: false, error: "That project folder no longer exists." };
  }
  return (options.run ?? runCommand)("open", ["-a", ideApps[settings.ide].app, dir]);
}

function launchIn(
  terminal: TerminalKey,
  cmd: string,
  run: (bin: string, args: string[]) => LaunchResult,
  env: Record<string, string | undefined> | undefined,
): LaunchResult {
  switch (terminal) {
    case "iterm":
      return run("osascript", ["-e", itermScript(cmd)]);
    case "ghostty":
      return openArgs("Ghostty", ["-e", shell(env), "-lc", cmd], run);
    case "alacritty":
      return openArgs("Alacritty", ["-e", shell(env), "-lc", cmd], run);
    case "kitty":
      return openArgs("kitty", [shell(env), "-lc", cmd], run);
    case "wezterm":
      return openArgs("WezTerm", ["start", "--", shell(env), "-lc", cmd], run);
    default:
      return run("osascript", ["-e", terminalAppScript(cmd)]);
  }
}

function openArgs(
  app: string,
  args: string[],
  run: (bin: string, args: string[]) => LaunchResult,
): LaunchResult {
  return run("open", ["-na", app, "--args", ...args]);
}

function runCommand(bin: string, args: string[]): LaunchResult {
  try {
    const result = spawnSync(bin, args, { encoding: "utf8" });
    if (result.status === 0) {
      return { ok: true };
    }
    return { ok: false, error: (result.stderr || result.stdout || "launch failed").trim() };
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
