import { syncCompleteLabel, syncFraction, syncProgressLabel } from "./sync-events.ts";
import type { SyncProgress } from "./types.ts";

function percentText(fraction: number): string {
  return `${Math.floor(fraction * 100)}%`;
}

/** The filled part of a bar. Indeterminate until the sync has counted its sources. */
function SyncFill({ fraction }: { fraction: number | null }) {
  return (
    <span
      className="sync-fill"
      data-indeterminate={fraction == null ? "true" : undefined}
      style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
    />
  );
}

/**
 * Progress along the topbar's bottom edge, in view on every page. It is the
 * one progress bar exposed to assistive tech, and it is not a live region.
 */
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

/** The counts behind the topbar line, shown at the top of every page. */
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
      {/* The topbar line is the one progress bar exposed to assistive tech. */}
      <div aria-hidden="true" className="sync-notice-bar">
        <SyncFill fraction={fraction} />
      </div>
    </div>
  );
}
