import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AgentKey = "claude" | "codex";
export type TerminalKey =
  | "terminal"
  | "iterm"
  | "ghostty"
  | "warp"
  | "wezterm"
  | "kitty"
  | "alacritty";
export type IdeKey = "vscode" | "cursor" | "zed" | "sublime" | "intellij";
export type DosuSuggestionsKey = "show" | "hide";

export interface UserSettings {
  agent: AgentKey;
  terminal: TerminalKey;
  ide: IdeKey;
  dosuSuggestions: DosuSuggestionsKey;
}

export interface SettingsOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  appExists?: (name: string) => boolean;
}

const validAgents = new Set<AgentKey>(["claude", "codex"]);
const validTerminals = new Set<TerminalKey>([
  "terminal",
  "iterm",
  "ghostty",
  "warp",
  "wezterm",
  "kitty",
  "alacritty",
]);
const validIdes = new Set<IdeKey>(["vscode", "cursor", "zed", "sublime", "intellij"]);
const validDosuSuggestions = new Set<DosuSuggestionsKey>(["show", "hide"]);

export const agentOptions: [AgentKey, string][] = [
  ["claude", "Claude"],
  ["codex", "Codex"],
];

export const terminalOptions: [TerminalKey, string][] = [
  ["terminal", "Terminal"],
  ["iterm", "iTerm"],
  ["ghostty", "Ghostty"],
  ["warp", "Warp"],
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

export const dosuSuggestionOptions: [DosuSuggestionsKey, string][] = [
  ["show", "Show"],
  ["hide", "Hide"],
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
    dosuSuggestions: "show",
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
  return { ...detectedSettings(options), ...loadSettings(options) };
}

export function saveSettings(
  attrs: Record<string, unknown>,
  options: SettingsOptions = {},
): UserSettings {
  const merged = { ...loadSettings(options), ...sanitize(attrs) };
  const path = settingsPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX mode bits.
  }
  return { ...detectedSettings(options), ...merged };
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
  if (
    typeof raw.dosuSuggestions === "string" &&
    validDosuSuggestions.has(raw.dosuSuggestions as DosuSuggestionsKey)
  ) {
    out.dosuSuggestions = raw.dosuSuggestions as DosuSuggestionsKey;
  }
  return out;
}

function detectTerminal(env: Record<string, string | undefined>): TerminalKey {
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      return "iterm";
    case "ghostty":
      return "ghostty";
    case "WarpTerminal":
      return "warp";
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
