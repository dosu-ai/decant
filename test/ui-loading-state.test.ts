import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planSessionPageLoad,
  sessionPageExhausted,
  shouldShowSessionSkeleton,
} from "../src/ui/loading-state.ts";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

describe("session loading state", () => {
  test("loads one explicit page plus a bounded next-page probe", () => {
    expect(
      planSessionPageLoad({
        loadedRequestKey: "all:1",
        page: 1,
        pageSize: 50,
        requestKey: "all:2",
      }),
    ).toEqual({ limit: 51, offset: 0, page: 1 });
    expect(
      planSessionPageLoad({
        loadedRequestKey: "all:2:2",
        page: 3,
        pageSize: 50,
        requestKey: "all:2:3",
      }),
    ).toEqual({ limit: 51, offset: 100, page: 3 });
  });

  test("does not refetch the page represented by the active request key", () => {
    expect(
      planSessionPageLoad({
        loadedRequestKey: "all:2",
        page: 2,
        pageSize: 50,
        requestKey: "all:2",
      }),
    ).toBeNull();
  });

  test("normalizes invalid page offsets without issuing an unsafe request", () => {
    expect(
      planSessionPageLoad({
        loadedRequestKey: null,
        page: Number.MAX_SAFE_INTEGER,
        pageSize: 50,
        requestKey: "all:huge",
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
    const sessionsViewStart = main.indexOf("function SessionsView(");
    const sessionsViewEnd = main.indexOf("function SessionTableSkeletonRows()", sessionsViewStart);
    expect(sessionsViewStart).toBeGreaterThanOrEqual(0);
    expect(sessionsViewEnd).toBeGreaterThan(sessionsViewStart);
    const sessionsView = main.slice(sessionsViewStart, sessionsViewEnd);
    expect(sessionsView).toContain("const toggleSession = useCallback(");
    expect(sessionsView).toContain('aria-label="Sessions pagination"');
    expect(sessionsView).toContain("sessionsPageHref(path, displayedPage + 1)");
    expect(sessionsView).not.toContain("IntersectionObserver");
    expect(sessionsView).not.toContain("infinite-sentinel");
    expect(main).toContain("const SessionTableRow = memo(function SessionTableRow(");
  });
});

describe("session table skeleton", () => {
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
