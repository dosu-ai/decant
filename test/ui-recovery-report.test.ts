import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
const server = readFileSync(join(import.meta.dir, "..", "src", "server.ts"), "utf8");

describe("coded UI recovery", () => {
  test("maps server codes to actions without rendering raw exception messages", () => {
    for (const code of [
      "session_not_found",
      "schema_too_new",
      "schema_too_old",
      "launch_unsupported_platform",
      "launch_failed",
      "archive_locked",
      "internal_error",
    ]) {
      expect(main).toContain(`case "${code}":`);
    }
    expect(main).toMatch(/onClick=\{onRetry\}[\s\S]*?Retry/);
    expect(main).toContain("private diagnostic");
    expect(main).toContain("Restart `decant serve`");
  });

  test("offers direct recovery for missing sessions, stale schemas, and launch failures", () => {
    expect(main).toContain('actionLabel: "Back to sessions"');
    expect(main).toMatch(/case "session_not_found":[\s\S]*?useSync: true/);
    expect(main).toContain('actionLabel: "View rebuild guide"');
    const schemaTooOld = main.slice(
      main.indexOf('case "schema_too_old":'),
      main.indexOf('case "launch_unsupported_platform":'),
    );
    expect(schemaTooOld).not.toContain('actionHref: "/settings"');
    expect(main).toContain('typeof error.extras.command === "string"');
    expect(main).toContain('copyTextToClipboard(recovery.command ?? "")');
    expect(main).toContain('{commandCopied ? "Copied" : "Copy"}');
  });

  test("keeps sync failures inline and retries the sync operation", () => {
    expect(main).toContain("const [syncError, setSyncError]");
    expect(main).toContain("setSyncError(err)");
    expect(main).toContain("<ApiFailureState error={syncError} onRetry={runSync} />");
    expect(main).toContain("setLiveConnectionKey((key) => key + 1)");
    expect(main).toContain("Reconnect");
  });

  test("keeps successful dashboard slices visible when a sibling request fails", () => {
    expect(main).toContain("Promise.allSettled");
    expect(main).not.toContain("Promise.all(missing.map");
    expect(main).toContain("collectSliceResults");
    expect(main).toContain("const [failedSlices, setFailedSlices]");
    expect(main).toContain(
      "Some dashboard data could not be loaded. Available data is still shown.",
    );
    expect(main).toContain("activeFailedSlices.join");
    expect(main).toContain("slicesForView(activeView).includes(slice)");
    expect(main).toContain(
      "setFailedSlices((current) => current.filter((slice) => needed.includes(slice)))",
    );
    expect(main).toContain("const [sessionsError, setSessionsError]");
    expect(main).toContain('active === "Sessions" && sessionsError != null');
  });

  test("refreshes dashboard slices after a dropped live connection recovers", () => {
    expect(main).toContain("const liveDroppedRef = useRef(false)");
    expect(main).toMatch(
      /if \(liveDroppedRef\.current\) \{\s*liveDroppedRef\.current = false;\s*requestRefresh\(\);/,
    );
    expect(main).toContain("liveDroppedRef.current = true");
  });

  test("adds recovery actions to empty Projects and Analytics states", () => {
    expect(main).toMatch(/function ProjectsView[\s\S]*?Sync now/);
    expect(main).toMatch(/function DailyPanel[\s\S]*?All time[\s\S]*?title="No data in range"/);
  });

  test("file filters catch rejected requests and offer a retry", () => {
    const start = main.indexOf("function FilesView(");
    const end = main.indexOf("function SettingsView(", start);
    const filesView = main.slice(start, end);
    expect(filesView).toContain(".catch((reason: unknown)");
    expect(filesView).toContain("<ApiFailureState");
    expect(filesView).toContain("setFilesRetryKey");
  });
});

describe("ingest diagnostics", () => {
  test("only actionable dropped lines produce a session-header badge", () => {
    expect(main).toContain("{detail.summary.ingest_issue_count > 0 ? (");
    expect(main).not.toContain(
      "detail.summary.ingest_issue_count > 0 ||\n            detail.summary.informational_ingest_issue_count > 0",
    );
    expect(main).toContain('{syncing ? null : "Re-sync"}');
    expect(main).toContain("Check for a Decant update");
    expect(main).toContain("onRetry={() => setIssuesError(null)}");
  });
});

describe("report preview routes", () => {
  test("provide the requested local preview toolbar", () => {
    expect(main).toContain('pathOnly(path) === "/reports/analytics"');
    expect(main).toContain("/reports/session/");
    expect(main).toContain("Download HTML");
    expect(main).toContain("Save as PDF");
    expect(main).not.toContain("Save as PDF…");
    expect(main).toContain('<Icon name="filePdf" />');
    expect(main).toContain('<Icon name="fileCode" />');
    expect(main).toContain('<Icon name="eye" />');
    expect(main).toContain("View report");
    expect(main).not.toMatch(/>\s*Export\s*</);
    expect(main).toContain('className="primary-button report-action-button"');
    expect(main).toContain("report-route-toolbar");
    expect(main).toContain("srcDoc={documentHtml}");
    expect(main).toContain(
      'sandbox="allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox"',
    );
    expect(main).toContain("first user-prompt preview (up to 180 characters)");
    expect(main).toContain("Transcript messages beyond the disclosed prompt preview");
    expect(server).toContain('"/reports/analytics": uiBundle');
    expect(server).toContain('"/reports/session/:id": uiBundle');
  });
});

describe("transcript presentation", () => {
  test("keeps Dosu calls open and replaces embedded image payloads with local summaries", () => {
    expect(main).toContain("<ToolCallPresentation forceOpen={isDosu}");
    expect(main).toContain("embeddedAttachmentSummary(block.block_type, block.text)");
    expect(main).toContain("Payload preserved in the local session log");
  });

  test("uses the same compaction numbering in the chart and thread", () => {
    expect(main).toContain("compactionNumberBySeq");
    expect(main).toMatch(/Compaction \$\{compactionNumber\}/);
    expect(main).toContain('className="ctx-strip-compaction-marker"');
    expect(main).toContain("groupContextMarkers");
  });
});
