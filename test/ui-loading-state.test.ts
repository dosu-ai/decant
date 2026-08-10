import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planSessionPageLoad,
  sessionPageExhausted,
  shouldShowSessionSkeleton,
} from "../src/ui/loading-state.ts";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8");

function sessionsViewSource(): string {
  const start = main.indexOf("function SessionsView(");
  const end = main.indexOf("function SessionTableSkeletonRows()", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return main.slice(start, end);
}

describe("session loading state", () => {
  test("loads one explicit page plus a bounded next-page probe", () => {
    expect(
      planSessionPageLoad({
        page: 1,
        pageSize: 50,
      }),
    ).toEqual({ limit: 51, offset: 0, page: 1 });
    expect(
      planSessionPageLoad({
        page: 3,
        pageSize: 50,
      }),
    ).toEqual({ limit: 51, offset: 100, page: 3 });
  });

  test("returns the same plan independently of request lifecycle state", () => {
    expect(
      planSessionPageLoad({
        page: 2,
        pageSize: 50,
      }),
    ).toEqual({ limit: 51, offset: 50, page: 2 });
  });

  test("normalizes invalid page offsets without issuing an unsafe request", () => {
    expect(
      planSessionPageLoad({
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 50,
      }),
    ).toEqual({ limit: 51, offset: 0, page: 1 });
  });

  test("does not fake a loading skeleton when rows are already visible", () => {
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 100, query: "" })).toBe(false);
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 0, query: "codex" })).toBe(
      false,
    );
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 0, query: "" })).toBe(true);
  });

  test("uses the extra row probe to stop at an exact page boundary", () => {
    expect(sessionPageExhausted({ receivedRows: 50, requestedRows: 51 })).toBe(true);
    expect(sessionPageExhausted({ receivedRows: 51, requestedRows: 51 })).toBe(false);
    expect(sessionPageExhausted({ receivedRows: 0, requestedRows: 51 })).toBe(true);
  });

  test("uses explicit pagination without observing scroll position", () => {
    const sessionsView = sessionsViewSource();
    expect(sessionsView).toContain("const toggleSession = useCallback(");
    expect(sessionsView).toContain('aria-label="Sessions pagination"');
    expect(sessionsView).toContain("sessionsPageHref(path, displayedPage + 1)");
    expect(sessionsView).not.toContain("IntersectionObserver");
    expect(sessionsView).not.toContain("infinite-sentinel");
    expect(sessionsView).not.toContain("scrollIntoView");
    expect(sessionsView).not.toContain("setExpandedSessions");
    expect(main).toContain("const SessionTableRow = memo(function SessionTableRow(");
  });

  test("derives the next page from the row probe rather than a pending total", () => {
    const sessionsView = sessionsViewSource();
    expect(sessionsView).toContain("const hasNextPage = !exhausted;");
    expect(sessionsView).not.toContain("SESSION_PAGE_SIZE < listTotal");
    expect(sessionsView).not.toContain("?? sessions.length");
    expect(sessionsView).toContain('"No sessions on this page."');
  });

  test("reports archive-wide latest activity from page one only", () => {
    expect(main).toMatch(/loadedPage === 1\s*\?\s*latestSessionDay\(/);
  });

  test("isolates page swaps from document paint and scroll anchoring", () => {
    expect(styles).toContain(".sessions-panel {");
    expect(styles).toContain("contain: layout paint;");
    expect(styles).toContain("overflow-anchor: none;");
    expect(styles).toContain(".sessions-table tbody tr {\n  transition: none;");
  });
});

describe("session table skeleton", () => {
  test("reserves all fifty row slots before the first page settles", () => {
    expect(main).toContain("{ length: SESSION_PAGE_SIZE }");
    expect(main).toContain("const loading = enabled && cached == null && currentError == null");
    expect(main).not.toContain("setSessionsLoading");
    expect(main).not.toContain("loadedSessionKey");
  });

  test("keeps one placeholder aligned with each of the eleven session columns", () => {
    const start = main.indexOf("function SessionTableSkeletonRows()");
    const end = main.indexOf("function ProjectsView(", start);
    const skeleton = main.slice(start, end);
    expect(skeleton.match(/<td(?:\s|>)/g)).toHaveLength(11);
    expect([...skeleton.matchAll(/table-skeleton-line ([^"]+)/g)].map((match) => match[1])).toEqual(
      [
        "tool",
        "title",
        "project",
        "model",
        "effort",
        "number",
        "number",
        "number",
        "number",
        "cost",
        "started",
      ],
    );
  });

  test("keeps the Started cell as a precise semantic time element", () => {
    const start = main.indexOf("function SessionStartedAt(");
    const end = main.indexOf("function SessionContextPeak(", start);
    const startedCell = main.slice(start, end);
    expect(startedCell).toContain("const display = sessionListDate(value)");
    expect(startedCell).toContain("<time dateTime={value} title={fullDateTime(value) ?? display}>");
  });
});
