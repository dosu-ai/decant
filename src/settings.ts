import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AgentKey = "claude" | "codex" | "cursor";
export type TerminalKey =
  | "terminal"
  | "iterm"
  | "warp"
  | "ghostty"
  | "wezterm"
  | "kitty"
  | "alacritty";
export type IdeKey = "vscode" | "cursor" | "zed" | "sublime" | "intellij";

export interface ExperimentalSettings {
  cursorChats: boolean;
}

export interface UserSettings {
  agent: AgentKey;
  terminal: TerminalKey;
  ide: IdeKey;
  experimental: ExperimentalSettings;
}

export interface SettingsOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  appExists?: (name: string) => boolean;
}

const validAgents = new Set<AgentKey>(["claude", "codex", "cursor"]);
const validTerminals = new Set<TerminalKey>([
  "terminal",
  "iterm",
  "warp",
  "ghostty",
  "wezterm",
  "kitty",
  "alacritty",
]);
const validIdes = new Set<IdeKey>(["vscode", "cursor", "zed", "sublime", "intellij"]);

export const agentOptions: [AgentKey, string][] = [
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
];

export const terminalOptions: [TerminalKey, string][] = [
  ["terminal", "Terminal"],
  ["iterm", "iTerm"],
  ["warp", "Warp"],
  ["ghostty", "Ghostty"],
  ["wezterm", "WezTerm"],
  ["kitty", "kitty"],
  ["alacritty", "Alacritty"],
];

export const ideOptions: [IdeKey, string][] = [
  ["vscode", "VS Code"],
  ["cursor", "Cursor"],
  ["zed", "Zed"],
  ["sublime", "Sublime Text"],
  ["intellij", "IntelliJ IDEA"],
];

export function settingsPath(options: SettingsOptions = {}): string {
  const env = options.env ?? process.env;
  const home = (options.homeDir ?? homedir()) || ".";
  const dir = env.DECANT_CONFIG_DIR ?? join(home, ".config", "decant");
  return resolve(join(dir, "settings.json"));
}

export function detectedSettings(options: SettingsOptions = {}): UserSettings {
  return {
    agent: "claude",
    terminal: detectTerminal(options.env ?? process.env),
    ide: detectIde(options.appExists ?? ((name) => existsSync(`/Applications/${name}.app`))),
    experimental: defaultExperimental(),
  };
}

export function loadSettings(options: SettingsOptions = {}): Partial<UserSettings> {
  try {
    const body = readFileSync(settingsPath(options), "utf8");
    return sanitize(JSON.parse(body));
  } catch {
    return {};
  }
}

export function getSettings(options: SettingsOptions = {}): UserSettings {
  return mergeSettings(detectedSettings(options), loadSettings(options));
}

export function saveSettings(
  attrs: Record<string, unknown>,
  options: SettingsOptions = {},
): UserSettings {
  const merged = mergeSettings(loadSettings(options), sanitize(attrs));
  const path = settingsPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX mode bits.
  }
  return mergeSettings(detectedSettings(options), merged);
}

function sanitize(attrs: unknown): Partial<UserSettings> {
  if (attrs == null || typeof attrs !== "object") {
    return {};
  }
  const raw = attrs as Record<string, unknown>;
  const out: Partial<UserSettings> = {};
  if (typeof raw.agent === "string" && validAgents.has(raw.agent as AgentKey)) {
    out.agent = raw.agent as AgentKey;
  }
  if (typeof raw.terminal === "string" && validTerminals.has(raw.terminal as TerminalKey)) {
    out.terminal = raw.terminal as TerminalKey;
  }
  if (typeof raw.ide === "string" && validIdes.has(raw.ide as IdeKey)) {
    out.ide = raw.ide as IdeKey;
  }
  if (raw.experimental != null && typeof raw.experimental === "object") {
    const experimental = raw.experimental as Record<string, unknown>;
    if (typeof experimental.cursorChats === "boolean") {
      out.experimental = { cursorChats: experimental.cursorChats };
    }
  }
  return out;
}

function defaultExperimental(): ExperimentalSettings {
  return { cursorChats: false };
}

function mergeSettings<A extends Partial<UserSettings>, B extends Partial<UserSettings>>(
  base: A,
  patch: B,
): A & B {
  const merged = {
    ...base,
    ...patch,
  } as A & B;
  const experimental = {
    ...(base.experimental ?? {}),
    ...(patch.experimental ?? {}),
  };
  if (Object.keys(experimental).length > 0) {
    merged.experimental = experimental as (A & B)["experimental"];
  }
  return merged;
}

function detectTerminal(env: Record<string, string | undefined>): TerminalKey {
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      return "iterm";
    case "WarpTerminal":
      return "warp";
    case "ghostty":
      return "ghostty";
    case "WezTerm":
      return "wezterm";
    case "Apple_Terminal":
      return "terminal";
    default:
      return env.TERM === "xterm-kitty" ? "kitty" : "terminal";
  }
}

function detectIde(appExists: (name: string) => boolean): IdeKey {
  for (const [app, key] of [
    ["Cursor", "cursor"],
    ["Visual Studio Code", "vscode"],
    ["Zed", "zed"],
    ["Sublime Text", "sublime"],
    ["IntelliJ IDEA", "intellij"],
  ] as const) {
    if (appExists(app)) {
      return key;
    }
  }
  return "vscode";
}
