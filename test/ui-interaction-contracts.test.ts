import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = main.indexOf(start);
  const endIndex = main.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return main.slice(startIndex, endIndex);
}

describe("UI interaction contracts", () => {
  test("aborts and ignores stale load-more search responses", () => {
    const search = sourceBetween("function SearchView(", "function groupSearchHits(");

    expect(search).toContain("loadMoreControllerRef.current?.abort()");
    expect(search).toContain("signal: controller.signal");
    expect(search).toContain("searchEpochRef.current !== epoch");
    expect(search).toContain("loadMoreControllerRef.current === controller");
  });

  test("does not activate stale search results and exposes arrow selection to assistive tech", () => {
    const search = sourceBetween("function SearchView(", "function groupSearchHits(");

    expect(search).toContain("resultsQueryRef.current = null");
    expect(search).toContain("setHits([])");
    expect(search).toContain("resultsQueryRef.current === query.trim()");
    expect(search).toContain('role="combobox"');
    expect(search).toContain('role="listbox"');
    expect(search).toContain('role="option"');
    expect(search).toContain("aria-activedescendant={activeHitId}");
    expect(search).toContain("aria-selected={index === activeIndex}");
  });

  test("exposes tool-call details as a focus-managed modal with a keyboard entry point", () => {
    const detail = sourceBetween("function ToolCallDetail(", "function ToolsView(");
    const tools = sourceBetween("function ToolsView(", "function FilesView(");

    expect(detail).toContain("useDialogFocusTrap(true, dialogRef, onClose)");
    expect(detail).toContain('aria-modal="true"');
    expect(detail).toContain('role="dialog"');
    expect(detail).toContain("aria-labelledby={titleId}");
    expect(tools).toContain('className="tool-call-detail-button"');
    expect(tools).toContain("Inspect ${call.tool_name");
  });

  test("closes report and share reviews only from direct backdrop presses", () => {
    const reportReview = sourceBetween(
      "function ExportReviewSheet(",
      "function ReportExportButton(",
    );
    const shareReview = sourceBetween(
      "function ShareChartButton(",
      "async function renderShareCardPng(",
    );

    expect(reportReview).toContain('className="report-review-backdrop"');
    expect(reportReview).toMatch(
      /onMouseDown=\{\(event\) => \{\s*if \(event\.target === event\.currentTarget\) \{\s*onClose\(\);/,
    );
    expect(shareReview).toContain('className="share-review-backdrop"');
    expect(shareReview).toMatch(
      /onMouseDown=\{\(event\) => \{\s*if \(event\.target === event\.currentTarget\) \{\s*closeShareReview\(\);/,
    );
  });

  test("keeps compaction anchors exposed in the accessibility tree", () => {
    const chart = sourceBetween("function ContextWindowStrip(", "function compactionTokenRange(");

    expect(chart).not.toContain('role="img"');
    expect(chart).toContain("Compactions ");
    expect(chart).toContain(" through ");
    expect(chart).toContain("href={`#message-");
  });

  test("keeps archive visibility in session pagination and navigation state", () => {
    const app = sourceBetween("function App()", "function renderView(");
    const render = sourceBetween("function renderView(", "function NotFoundView(");
    const sessions = sourceBetween("function SessionsView(", "function SessionTableSkeletonRows(");
    const row = sourceBetween("function SessionTableRow(", "function DosuProvenanceBadge(");

    expect(app).toContain("sessionLoadKey");
    expect(app).toContain("includeArchivedSessions");
    expect(app).toContain("reloadKey");
    expect(app).toContain("reloadKey,");
    expect(render).toContain("reloadKey={actions.reloadKey}");
    expect(app).toContain('"&include_archived=true"');
    expect(app).toContain("sessionPageExhausted({");
    expect(sessions).toContain("scopedSessionSummaryKey(scopedSummaryRequest, reloadKey)");
    expect(sessions).toContain("<span>Show archived</span>");
    expect(sessions).toContain("sessionsArchivedHref(path, event.target.checked)");
    expect(row).toContain('session.is_user_archived ? <Badge tone="neutral">Archived</Badge>');
  });

  test("keeps the shell summary archive-wide while scoped session cards reload independently", () => {
    const loaders = sourceBetween("const SLICE_LOADERS:", "const SHELL_SLICES:");
    const summaryStart = loaders.indexOf("  summary: {");
    const summaryEnd = loaders.indexOf("  byModel: {", summaryStart);
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    expect(summaryEnd).toBeGreaterThan(summaryStart);
    const summaryLoader = loaders.slice(summaryStart, summaryEnd);

    expect(summaryLoader).toContain('withDateQuery("/api/stats/summary", q)');
    expect(summaryLoader).not.toContain("project");
    expect(summaryLoader).not.toContain("include_archived");
    expect(summaryLoader).not.toContain("sessionSummaryPath");
  });

  test("exposes session state actions through the shared accessible overflow menu", () => {
    const overflow = sourceBetween("function OverflowMenu(", "function PromotionPanel(");
    const session = sourceBetween("function SessionDetailView(", "function SessionDetailSkeleton(");

    expect(overflow).toContain("event.currentTarget.open = false");
    expect(overflow).toContain('event.key !== "Escape"');
    expect(overflow).toContain("aria-label={label}");
    expect(overflow).toContain('querySelector("summary")?.focus()');
    expect(session).toContain("archiveActionFor(detail.summary)");
    expect(session).toContain("Archive session");
    expect(session).toContain("Unarchive session");
    expect(session).toContain("Delete session…");
    expect(session).toContain("sessionStateRequest(id, state)");
    expect(session).toContain("sessionStateMutationGenerationRef.current !== mutationGeneration");
  });

  test("requires a focus-managed explicit confirmation before permanent deletion", () => {
    const dialog = sourceBetween("function DeleteSessionDialog(", "function SessionDetailView(");

    expect(dialog).toContain("useDialogFocusTrap(open, dialogRef, requestClose)");
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('role="alertdialog"');
    expect(dialog).toContain("aria-labelledby={titleId}");
    expect(dialog).toContain("aria-describedby={descriptionId}");
    expect(dialog).toContain("event.target === event.currentTarget && !pending");
    expect(dialog).toContain("DELETE_SESSION_EXPLANATION");
    expect(dialog).toContain("Delete from Decant");
    expect(main).toContain("dialog.focus()");
  });
});
