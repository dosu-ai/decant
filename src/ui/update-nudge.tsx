import { useEffect, useState } from "react";
import { copyTextToClipboard } from "./clipboard.ts";
import { versionLabel } from "./format.ts";
import { Icon } from "./icons.tsx";
import type { UpdateStatus } from "./types.ts";

const COPIED_RESET_MS = 1_800;

export function UpdateNudge({ status }: { status: UpdateStatus | null }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copied = copyState === "copied";

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timer = window.setTimeout(() => setCopyState("idle"), COPIED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  if (status?.updateAvailable !== true || status.latest == null) {
    return null;
  }

  return (
    <div className="update-nudge">
      <a
        className="update-nudge-title"
        href={`https://github.com/dosu-ai/decant/releases/tag/${versionLabel(status.latest)}`}
        rel="noopener"
        target="_blank"
      >
        Decant {versionLabel(status.latest)} is available
      </a>
      <button
        aria-label={`Copy the update command: ${status.command}`}
        className="update-nudge-command"
        onClick={() => {
          copyTextToClipboard(status.command).then(
            () => setCopyState("copied"),
            () => setCopyState("failed"),
          );
        }}
        title="Copy, then run it in a terminal"
        type="button"
      >
        <code>{status.command}</code>
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <span
        aria-live="polite"
        className={copyState === "failed" ? "update-nudge-error" : "sr-only"}
      >
        {copyState === "copied" ? "Copied" : ""}
        {copyState === "failed"
          ? "This page cannot use the clipboard. Type the command in a terminal."
          : ""}
      </span>
    </div>
  );
}
