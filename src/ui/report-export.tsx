import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "./api.ts";
import { ApiFailureState } from "./api-failure.tsx";
import { EmptyState, PrivacyReviewLists } from "./common.tsx";
import { useDialogFocusTrap } from "./focus.ts";
import { errorMessage } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Link } from "./link.tsx";

export const ANALYTICS_REPORT_INCLUDES = [
  "Selected date range, local timezone, session totals, tokens, and estimated costs",
  "Model names and full project paths, activity charts, and token economics",
  "For all-time reports, up to five open insight titles, details, impact labels, and suggestions",
] as const;

export const SESSION_REPORT_INCLUDES = [
  "Session title and first user-prompt preview (up to 180 characters)",
  "Full project path, model, effort, dates, and estimated cost",
  "Context-window and token-economics summaries",
  "Tool-call aggregates and up to 25 referenced file paths",
] as const;

export const ANALYTICS_REPORT_NEVER_INCLUDES = [
  "Transcript messages, tool inputs, or tool-result bodies",
  "Credentials, source-file contents, or the session-log database",
  "Remote scripts, fonts, or tracking pixels",
] as const;

export const SESSION_REPORT_NEVER_INCLUDES = [
  "Transcript messages beyond the disclosed prompt preview, tool inputs, or tool-result bodies",
  "Credentials, source-file contents, or the session-log database",
  "Remote scripts, fonts, or tracking pixels",
] as const;

export function ExportReviewSheet({
  actions,
  excluded,
  includes,
  notice,
  onClose,
  open,
  title,
}: {
  actions: ReactNode;
  excluded: readonly string[];
  includes: readonly string[];
  notice?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useDialogFocusTrap(open, dialogRef, onClose);
  if (!open) {
    return null;
  }
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
    <div
      className="report-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="report-review-sheet"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="section-eyebrow">Privacy review</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            aria-label="Close report review"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="report-review-body">
          <PrivacyReviewLists
            className="report-privacy-review"
            excluded={excluded}
            excludedLabel="It never includes"
            included={includes}
            includedLabel="This report includes"
          />
          {notice}
        </div>
        <footer>{actions}</footer>
      </section>
    </div>,
    document.body,
  );
}

export function ReportExportButton({
  excluded,
  href,
  includes,
  previewHref,
  title,
}: {
  excluded: readonly string[];
  href: string;
  includes: readonly string[];
  previewHref: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeReview = useCallback(() => setOpen(false), []);

  const printReport = () => {
    const preview = window.open("", "_blank", "noopener=false");
    if (preview == null) {
      setError("Allow pop-ups for this local page, then try again.");
      return;
    }
    preview.document.write("<p style='font-family:system-ui;padding:2rem'>Preparing report…</p>");
    setPrinting(true);
    setError(null);
    void fetch(href)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Report request failed (${response.status})`);
        }
        const documentHtml = await response.text();
        preview.document.open();
        preview.document.write(documentHtml);
        preview.document.close();
        await waitForReportFonts(preview.document);
        preview.focus();
        preview.print();
        closeReview();
      })
      .catch((reason: unknown) => {
        preview.close();
        setError(errorMessage(reason));
      })
      .finally(() => setPrinting(false));
  };

  return (
    <>
      <button
        className="primary-button report-action-button"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Icon name="eye" />
        View report
      </button>
      <ExportReviewSheet
        actions={
          <>
            <button
              className="secondary-button"
              disabled={printing}
              onClick={printReport}
              type="button"
            >
              <Icon name="filePdf" />
              Save as PDF
            </button>
            <a className="secondary-button" download href={href} onClick={closeReview}>
              <Icon name="fileCode" />
              Download HTML
            </a>
            <Link className="primary-button" href={previewHref} onClick={closeReview}>
              <Icon name="eye" />
              View report
            </Link>
          </>
        }
        excluded={excluded}
        includes={includes}
        notice={error != null ? <div className="notice danger">{error}</div> : null}
        onClose={closeReview}
        open={open}
        title={title}
      />
    </>
  );
}

export function ReportRouteExportActions({
  downloadHref,
  excluded,
  includes,
  onPrint,
  printDisabled,
  title,
}: {
  downloadHref: string;
  excluded: readonly string[];
  includes: readonly string[];
  onPrint: () => void;
  printDisabled: boolean;
  title: string;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  return (
    <>
      <button className="secondary-button" onClick={() => setReviewOpen(true)} type="button">
        <Icon name="fileCode" />
        Download HTML
      </button>
      <button
        className="primary-button"
        disabled={printDisabled}
        onClick={() => setReviewOpen(true)}
        type="button"
      >
        <Icon name="filePdf" />
        Save as PDF
      </button>
      <ExportReviewSheet
        actions={
          <>
            <button
              className="secondary-button"
              disabled={printDisabled}
              onClick={() => {
                closeReview();
                onPrint();
              }}
              type="button"
            >
              <Icon name="filePdf" />
              Save as PDF
            </button>
            <a className="secondary-button" download href={downloadHref} onClick={closeReview}>
              <Icon name="fileCode" />
              Download HTML
            </a>
          </>
        }
        excluded={excluded}
        includes={includes}
        onClose={closeReview}
        open={reviewOpen}
        title={`Review ${title.toLowerCase()}`}
      />
    </>
  );
}

export function ReportRouteView({
  backHref,
  downloadHref,
  excluded,
  includes,
  onSync,
  sourceHref,
  title,
}: {
  backHref: string;
  downloadHref: string;
  excluded: readonly string[];
  includes: readonly string[];
  onSync: () => void;
  sourceHref: string;
  title: string;
}) {
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    void retryKey;
    const controller = new AbortController();
    setDocumentHtml(null);
    setError(null);
    void fetchReportHtml(sourceHref, controller.signal)
      .then(setDocumentHtml)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason);
        }
      });
    return () => controller.abort();
  }, [retryKey, sourceHref]);

  return (
    <div
      className="report-route-theme"
      style={{
        background: "#eef0ec",
        color: "#24302a",
        minHeight: "100vh",
      }}
    >
      <style>{`
        @media print {
          .report-route-toolbar { display: none !important; }
          .report-route-frame { height: 100vh !important; }
        }
      `}</style>
      <header
        className="report-route-toolbar"
        style={{
          alignItems: "center",
          background: "#fff",
          borderBottom: "1px solid #dce1da",
          display: "flex",
          gap: "10px",
          minHeight: "58px",
          padding: "10px 18px",
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <Link className="secondary-button" href={backHref}>
          <Icon name="arrowLeft" />
          Back
        </Link>
        <strong style={{ marginRight: "auto" }}>{title}</strong>
        <ReportRouteExportActions
          downloadHref={downloadHref}
          excluded={excluded}
          includes={includes}
          onPrint={() => {
            const frameWindow = frameRef.current?.contentWindow;
            if (frameWindow != null) {
              void waitForReportFonts(frameWindow.document).then(() => frameWindow.print());
            }
          }}
          printDisabled={documentHtml == null}
          title={title}
        />
      </header>
      {error != null ? (
        <div style={{ margin: "32px auto", maxWidth: "760px", padding: "0 20px" }}>
          <ApiFailureState
            error={error}
            onRetry={() => setRetryKey((key) => key + 1)}
            onSync={onSync}
          />
        </div>
      ) : documentHtml == null ? (
        <div style={{ margin: "32px auto", maxWidth: "760px", padding: "0 20px" }}>
          <EmptyState
            icon="file"
            message="Preparing the local report preview."
            title="Loading report"
          />
        </div>
      ) : (
        <iframe
          className="report-route-frame"
          ref={frameRef}
          sandbox="allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox"
          srcDoc={documentHtml}
          style={{
            background: "#fff",
            border: 0,
            display: "block",
            height: "calc(100vh - 58px)",
            width: "100%",
          }}
          title={`${title} preview`}
        />
      )}
    </div>
  );
}

export async function waitForReportFonts(document: Document): Promise<void> {
  if (document.fonts == null) {
    return;
  }
  await document.fonts.ready;
}

export async function fetchReportHtml(path: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(path, {
    headers: { accept: "text/html, application/json" },
    signal,
  });
  if (response.ok) {
    return response.text();
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // The recovery component has a status-based fallback for non-JSON errors.
  }
  const code =
    typeof payload.code === "string" && payload.code !== "" ? payload.code : "request_failed";
  const message =
    typeof payload.error === "string" && payload.error !== ""
      ? payload.error
      : `Report request failed (${response.status})`;
  const { code: _code, error: _error, ...extras } = payload;
  throw new ApiError(response.status, code, message, extras);
}
