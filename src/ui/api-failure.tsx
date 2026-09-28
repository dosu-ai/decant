import { useState } from "react";
import { ApiError } from "./api.ts";
import { copyTextToClipboard } from "./clipboard.ts";
import { ErrorState } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { Link } from "./link.tsx";
import type { IconName } from "./types.ts";

export type RecoveryPresentation = {
  actionHref?: string;
  actionLabel?: string;
  command?: string;
  detail: string;
  icon: IconName;
  retry: boolean;
  title: string;
  useSync?: boolean;
};

export function recoveryPresentation(error: unknown): RecoveryPresentation {
  if (!(error instanceof ApiError)) {
    return {
      detail:
        "Decant could not reach the local server. Restart `decant serve` if needed, then retry.",
      icon: "info",
      retry: true,
      title: "Request failed",
    };
  }
  switch (error.code) {
    case "session_not_found":
      return error.extras.archive_empty === true
        ? {
            actionHref: "/sessions",
            actionLabel: "Back to sessions",
            detail: "There are no session logs on this device yet. Sync to import them.",
            icon: "sessions",
            retry: false,
            title: "No session logs yet",
            useSync: true,
          }
        : {
            actionHref: "/sessions",
            actionLabel: "Back to sessions",
            detail: "This session log is no longer available. It may have moved after a rebuild.",
            icon: "inbox",
            retry: false,
            title: "Session not found",
            useSync: true,
          };
    case "schema_too_new":
      return {
        actionHref: "https://github.com/dosu-ai/decant/releases",
        actionLabel: "Update Decant",
        detail:
          "These session logs were indexed by a newer Decant build. Update Decant, then retry.",
        icon: "info",
        retry: true,
        title: "Decant is out of date",
      };
    case "schema_too_old":
      return {
        actionHref: "https://github.com/dosu-ai/decant#configuration",
        actionLabel: "View rebuild guide",
        detail:
          "The session log index predates the supported schema baseline. Back it up, rebuild it, and sync the source logs again.",
        icon: "info",
        retry: false,
        title: "Session log index rebuild required",
      };
    case "launch_unsupported_platform":
      return {
        command: typeof error.extras.command === "string" ? error.extras.command : undefined,
        detail:
          "Native agent and editor launching is available on macOS. Copy the prompt or command and run it manually here.",
        icon: "info",
        retry: false,
        title: "Native launch is unavailable",
      };
    case "launch_failed":
      return {
        command: typeof error.extras.command === "string" ? error.extras.command : undefined,
        actionHref: "/settings",
        actionLabel: "Check launcher settings",
        detail:
          "Decant could not open the selected app. Check the launcher setting, then try again.",
        icon: "info",
        retry: true,
        title: "Launch failed",
      };
    case "archive_locked":
      return {
        detail:
          "Another Decant operation is using the session log index. Wait a moment, then retry.",
        icon: "clock",
        retry: true,
        title: "Session logs are busy",
      };
    case "service_starting":
      return {
        detail: "Decant is finishing local startup. Try again in a moment.",
        icon: "clock",
        retry: true,
        title: "Decant is starting",
      };
    case "internal_error":
      return {
        detail:
          "Decant hit an unexpected local error. Restart `decant serve`, then retry. If it continues, check the server log for the private diagnostic.",
        icon: "info",
        retry: true,
        title: "Decant could not complete the request",
      };
    default:
      if (error.status >= 500) {
        return {
          detail:
            "Decant hit an unexpected local error. Restart `decant serve`, then retry. If it continues, check the server log.",
          icon: "info",
          retry: true,
          title: "Decant could not complete the request",
        };
      }
      return {
        detail: "Decant could not complete this request. Check the input and try again.",
        icon: "info",
        retry: true,
        title: "Request failed",
      };
  }
}

export function ApiFailureState({
  error,
  onRetry,
  onSync,
}: {
  error: unknown;
  onRetry?: () => void;
  onSync?: () => void;
}) {
  const [commandCopied, setCommandCopied] = useState(false);
  const recovery = recoveryPresentation(error);
  const retryIsPrimary =
    !recovery.useSync && recovery.actionHref == null && recovery.retry && onRetry != null;
  const action =
    recovery.actionHref != null && recovery.actionLabel != null ? (
      <Link
        className="primary-button"
        href={recovery.actionHref}
        rel={recovery.actionHref.startsWith("http") ? "noopener" : undefined}
        target={recovery.actionHref.startsWith("http") ? "_blank" : undefined}
      >
        {recovery.actionLabel}
      </Link>
    ) : recovery.useSync && onSync != null ? (
      <button className="primary-button" onClick={onSync} type="button">
        Sync now
      </button>
    ) : retryIsPrimary ? (
      <button className="primary-button" onClick={onRetry} type="button">
        Retry
      </button>
    ) : null;
  const secondaryAction =
    recovery.useSync && onSync != null && action != null ? (
      <button className="secondary-button" onClick={onSync} type="button">
        Sync now
      </button>
    ) : recovery.retry && onRetry != null && action != null && !retryIsPrimary ? (
      <button className="secondary-button" onClick={onRetry} type="button">
        Retry
      </button>
    ) : null;
  return (
    <div className="api-failure">
      <ErrorState
        action={action}
        detail={recovery.detail}
        icon={recovery.icon}
        secondaryAction={secondaryAction}
        title={recovery.title}
      />
      {recovery.command != null ? (
        <div className="recovery-command">
          <code>{recovery.command}</code>
          <button
            className="secondary-button"
            onClick={() => {
              void copyTextToClipboard(recovery.command ?? "")
                .then(() => setCommandCopied(true))
                .catch(() => setCommandCopied(false));
            }}
            type="button"
          >
            <Icon name={commandCopied ? "check" : "copy"} />
            {commandCopied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
