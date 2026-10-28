import type { UpdateStatus } from "../update.ts";
import { label } from "./commands/update.ts";

/** How long a finished command waits on an unfinished check before exiting. */
export const UPDATE_NOTICE_WAIT_MS = 1_500;

export interface UpdateNoticeInput {
  /** The subcommand that ran, such as "sync", "serve", or "update". */
  command: string;
  json: boolean;
  quiet: boolean;
  /** Whether stderr is an interactive terminal. */
  stderrIsTTY: boolean;
  env: Record<string, string | undefined>;
}

/**
 * Decides whether this invocation may print an "update available" line.
 * The opt-in setting is checked separately; this only guards the moments
 * when a notice would be noise or would corrupt output someone parses.
 */
export function shouldShowUpdateNotice(input: UpdateNoticeInput): boolean {
  if (input.json || input.quiet || !input.stderrIsTTY) {
    return false;
  }
  // Nobody reading a CI log can act on the notice.
  if ((input.env.CI ?? "").trim() !== "") {
    return false;
  }
  return !SILENT_COMMANDS.has(input.command);
}

// `update` reports its own status and shells source `completion` output.
// `watch` runs until interrupted, so a notice queued for its exit would
// reach nobody.
const SILENT_COMMANDS = new Set(["update", "completion", "watch"]);

export function renderUpdateNotice(status: UpdateStatus): string | null {
  if (!status.updateAvailable || status.latest == null) {
    return null;
  }
  return `\nDecant ${label(status.latest)} is available (you have ${label(status.current)}). Run: ${status.command}\n`;
}
