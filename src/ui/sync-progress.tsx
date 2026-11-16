import { syncCompleteLabel, syncFraction, syncProgressLabel } from "./sync-events.ts";
import type { SyncProgress } from "./types.ts";

function percentText(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

function SyncFill({ fraction }: { fraction: number | null }) {
  return (
    <span
      className="sync-fill"
      data-indeterminate={fraction == null ? "true" : undefined}
      style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
    />
  );
}

export function SyncProgressLine({
  complete,
  progress,
}: {
  complete: boolean;
  progress: SyncProgress | null;
}) {
  const fraction = complete ? 1 : syncFraction(progress);
  return (
    <div
      aria-label="Sync progress"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={fraction == null ? undefined : Math.floor(fraction * 100)}
      aria-valuetext={complete ? syncCompleteLabel(progress) : syncProgressLabel(progress)}
      className="sync-line"
      data-complete={complete ? "true" : undefined}
      role="progressbar"
    >
      <SyncFill fraction={fraction} />
    </div>
  );
}

export function SyncProgressNotice({
  complete,
  firstSync,
  progress,
}: {
  complete: boolean;
  firstSync: boolean;
  progress: SyncProgress | null;
}) {
  const fraction = complete ? 1 : syncFraction(progress);
  return (
    <div className="sync-notice" data-complete={complete ? "true" : undefined}>
      <div className="sync-notice-row">
        <strong className="sync-notice-label">
          {complete ? syncCompleteLabel(progress) : syncProgressLabel(progress)}
        </strong>
        {firstSync && !complete ? (
          <span className="sync-notice-hint">
            First sync. Totals and insights appear when it finishes.
          </span>
        ) : null}
        {fraction != null && !complete ? (
          <span className="sync-notice-percent">{percentText(fraction)}</span>
        ) : null}
      </div>
      <div aria-hidden="true" className="sync-notice-bar">
        <SyncFill fraction={fraction} />
      </div>
    </div>
  );
}
