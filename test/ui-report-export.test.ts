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

describe("report export privacy review", () => {
  test("discloses full project paths and exported insight details", () => {
    const fields = sourceBetween(
      "const ANALYTICS_REPORT_INCLUDES",
      "const SESSION_REPORT_INCLUDES",
    );

    expect(fields).toContain("full project paths");
    expect(fields).toContain("insight titles, details, impact labels, and suggestions");
  });

  test("uses one accessible review shell with trapped and restored focus", () => {
    const focusTrap = sourceBetween("function useDialogFocusTrap(", "function PrivacyReviewLists(");
    const reviewSheet = sourceBetween(
      "function ExportReviewSheet(",
      "function ReportExportButton(",
    );

    expect(focusTrap).toContain('event.key === "Escape"');
    expect(focusTrap).toContain('event.key !== "Tab"');
    expect(focusTrap).toContain("returnFocus.focus()");
    expect(focusTrap).toContain("dialogFocusTargets");
    expect(reviewSheet).toContain('aria-modal="true"');
    expect(reviewSheet).toContain('role="dialog"');
    expect(reviewSheet).toContain("tabIndex={-1}");
    expect(reviewSheet).toContain("<PrivacyReviewLists");
  });

  test("routes both toolbar exports through the same review before acting", () => {
    const routeActions = sourceBetween(
      "function ReportRouteExportActions(",
      "function ReportRouteView(",
    );
    const routeView = sourceBetween("function ReportRouteView(", "async function fetchReportHtml(");

    expect(routeActions.match(/onClick=\{\(\) => setReviewOpen\(true\)\}/g)).toHaveLength(2);
    expect(routeActions).toContain("<ExportReviewSheet");
    expect(routeActions).toContain('<Icon name="fileCode" />');
    expect(routeActions).toContain("Download HTML");
    expect(routeActions).toContain('<Icon name="filePdf" />');
    expect(routeActions).toContain("Save as PDF");
    expect(routeView).toContain("<ReportRouteExportActions");
    expect(routeView).not.toContain("onClick={() => frameRef.current?.contentWindow?.print()}");
    expect(routeView).not.toContain('<a className="secondary-button" download');
  });

  test("shares privacy and focus primitives with the richer chart review", () => {
    const share = sourceBetween("function ShareChartButton(", "async function renderShareCardPng(");

    expect(share).toContain("useDialogFocusTrap(open, dialogRef, closeShareReview)");
    expect(share).toContain("<PrivacyReviewLists");
    expect(share).toContain("SHARE_INCLUDED_FIELDS");
    expect(share).toContain("SHARE_EXCLUDED_FIELDS");
    expect(share).toContain("share-preview");
  });
});
