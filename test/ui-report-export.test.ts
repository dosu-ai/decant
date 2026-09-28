import { describe, expect, test } from "bun:test";
import { readUiFile, readUiSource, sourceBetween } from "./ui-source.ts";

const main = readUiSource();

describe("report export privacy review", () => {
  test("discloses full project paths and exported insight details", () => {
    const fields = sourceBetween(
      main,
      "const ANALYTICS_REPORT_INCLUDES",
      "const SESSION_REPORT_INCLUDES",
    );

    expect(fields).toContain("full project paths");
    expect(fields).toContain("insight titles, details, impact labels, and suggestions");
  });

  test("uses one accessible review shell with trapped and restored focus", () => {
    const focusTrap = sourceBetween(
      readUiFile("focus.ts"),
      "function useDialogFocusTrap(",
      "function useDisabledFocusRescue(",
    );
    const reviewSheet = sourceBetween(
      main,
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
      main,
      "function ReportRouteExportActions(",
      "function ReportRouteView(",
    );
    const routeView = sourceBetween(
      main,
      "function ReportRouteView(",
      "async function fetchReportHtml(",
    );

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
    const share = sourceBetween(
      main,
      "function ShareChartButton(",
      "async function renderShareCardPng(",
    );

    expect(share).toContain("useDialogFocusTrap(open, dialogRef, closeShareReview)");
    expect(share).toContain("<PrivacyReviewLists");
    expect(share).toContain("SHARE_INCLUDED_FIELDS");
    expect(share).toContain("SHARE_EXCLUDED_FIELDS");
    expect(share).toContain("share-preview");
  });
});
