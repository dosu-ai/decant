import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyData } from "../src/ui/data-slices.ts";
import { ALL_DATE_RANGE } from "../src/ui/date-range.ts";
import { SyncProgressLine, SyncProgressNotice } from "../src/ui/sync-progress.tsx";
import type { SyncProgress } from "../src/ui/types.ts";
import { AnalyticsView, FirstRunPanel } from "../src/ui/views/analytics.tsx";
import { InsightsView } from "../src/ui/views/insights.tsx";

const progress: SyncProgress = { scanned: 312, ingested: 312, skipped: 0, failed: 0, total: 1248 };

describe("sync progress in the shell", () => {
  test("the topbar line is a determinate progress bar", () => {
    const html = renderToStaticMarkup(<SyncProgressLine complete={false} progress={progress} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('aria-valuetext="Syncing 312 of 1,248 files"');
    expect(html).toContain("width:25%");
    expect(html).not.toContain("data-indeterminate");
  });

  test("the line is indeterminate until the sync has counted its sources", () => {
    const html = renderToStaticMarkup(<SyncProgressLine complete={false} progress={null} />);
    expect(html).toContain('data-indeterminate="true"');
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain('aria-valuetext="Syncing session logs"');
  });

  test("a finished sync fills the line", () => {
    const html = renderToStaticMarkup(<SyncProgressLine complete progress={progress} />);
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("width:100%");
  });

  test("the notice shows counts and a percentage, and explains a first sync", () => {
    const html = renderToStaticMarkup(
      <SyncProgressNotice complete={false} firstSync progress={progress} />,
    );
    expect(html).toContain("Syncing 312 of 1,248 files");
    expect(html).toContain("25%");
    expect(html).toContain("First sync. Totals and insights appear when it finishes.");
    const later = renderToStaticMarkup(
      <SyncProgressNotice complete={false} firstSync={false} progress={progress} />,
    );
    expect(later).not.toContain("First sync");
  });

  test("the notice reports completion in place of the counts", () => {
    const html = renderToStaticMarkup(
      <SyncProgressNotice complete firstSync={false} progress={progress} />,
    );
    expect(html).toContain("Sync complete, 312 files ingested");
    expect(html).not.toContain("Syncing");
    expect(html).not.toContain("25%");
  });

  test("neither indicator is a live region, so the status announcement is not repeated", () => {
    const html =
      renderToStaticMarkup(<SyncProgressLine complete={false} progress={progress} />) +
      renderToStaticMarkup(<SyncProgressNotice complete={false} firstSync progress={progress} />);
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    // The notice's own bar is decorative: the topbar line is the one progress bar.
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    expect(html).toContain('aria-hidden="true" class="sync-notice-bar"');
  });
});

describe("first-sync states", () => {
  const insights = (firstSync: boolean) =>
    renderToStaticMarkup(
      <InsightsView
        firstSync={firstSync}
        loadFailed={false}
        loading={false}
        onMarked={() => {}}
        rows={[]}
        settingsInfo={null}
      />,
    );

  test("Insights says signals are coming, not that there are none", () => {
    const html = insights(true);
    expect(html).toContain("Signals appear when the first sync finishes");
    expect(html).not.toContain("No signals yet");
    expect(insights(false)).toContain("No signals yet");
  });

  test("an empty archive that is being filled is not presented as having no sessions", () => {
    const html = renderToStaticMarkup(<FirstRunPanel firstSync onSync={() => {}} syncing />);
    expect(html).toContain("First sync in progress");
    expect(html).not.toContain("No sessions yet");
    expect(html).not.toContain("<button");
    const idle = renderToStaticMarkup(<FirstRunPanel onSync={() => {}} syncing={false} />);
    expect(idle).toContain("No sessions yet");
    expect(idle).toContain("Sync now");
  });

  const analytics = (firstSync: boolean) =>
    renderToStaticMarkup(
      <AnalyticsView
        data={{
          ...emptyData,
          dateBounds: {
            min: "2026-10-01",
            max: "2026-10-02",
            latest_started_at: "2026-10-02T12:00:00Z",
          },
        }}
        dateRange={ALL_DATE_RANGE}
        firstSync={firstSync}
        onDateRangeChange={() => {}}
        onSourceChange={() => {}}
        onSync={() => {}}
        source=""
        syncing={firstSync}
      />,
    );

  test("Analytics marks partial numbers as still loading in", () => {
    const html = analytics(true);
    expect(html).toContain("These numbers are still loading in.");
    // Panels read as loading, not as an archive with nothing in range.
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No sessions in range");
    const settled = analytics(false);
    expect(settled).not.toContain("still loading in");
    expect(settled).toContain("No sessions in range");
  });
});
