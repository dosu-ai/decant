import type { UpdateStatus } from "../update.ts";
import { label } from "./commands/update.ts";

export const UPDATE_NOTICE_WAIT_MS = 1_500;

export interface UpdateNoticeInput {
  command: string;
  json: boolean;
  quiet: boolean;
  stderrIsTTY: boolean;
  env: Record<string, string | undefined>;
}

export function shouldShowUpdateNotice(input: UpdateNoticeInput): boolean {
  if (input.json || input.quiet || !input.stderrIsTTY) {
    return false;
  }
  if ((input.env.CI ?? "").trim() !== "") {
    return false;
  }
  return !SILENT_COMMANDS.has(input.command);
}

const SILENT_COMMANDS = new Set(["update", "completion", "watch"]);

export function renderUpdateNotice(status: UpdateStatus): string | null {
  if (!status.updateAvailable || status.latest == null) {
    return null;
  }
  return `\nDecant ${label(status.latest)} is available (you have ${label(status.current)}). Run: ${status.command}\n`;
}
