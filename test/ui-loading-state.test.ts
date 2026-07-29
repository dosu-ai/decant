import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planSessionLoad,
  sessionPageExhausted,
  shouldShowSessionSkeleton,
} from "../src/ui/loading-state.ts";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

describe("session loading state", () => {
  test("refreshes the first page without depending on currently rendered rows", () => {
    expect(
      planSessionLoad({
        loadedRequestKey: "all:1",
        loadedRows: 100,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 100,
      }),
    ).toEqual({ limit: 100, offset: 0, replace: true });
  });

  test("preserves expanded refresh depth through successive bounded pages", () => {
    expect(
      planSessionLoad({
        loadedRequestKey: "all:1",
        loadedRows: 300,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 300,
      }),
    ).toEqual({ limit: 100, offset: 0, replace: true });
    expect(
      planSessionLoad({
        loadedRequestKey: "all:2",
        loadedRows: 100,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 300,
      }),
    ).toEqual({ limit: 100, offset: 100, replace: false });
    expect(
      planSessionLoad({
        loadedRequestKey: "all:2",
        loadedRows: 200,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 300,
      }),
    ).toEqual({ limit: 100, offset: 200, replace: false });
    expect(
      planSessionLoad({
        loadedRequestKey: "all:2",
        loadedRows: 300,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 300,
      }),
    ).toBeNull();
  });

  test("loads the next page only after the active request key is current", () => {
    expect(
      planSessionLoad({
        loadedRequestKey: "all:2",
        loadedRows: 100,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 200,
      }),
    ).toEqual({ limit: 100, offset: 100, replace: false });
  });

  test("does not fake a loading skeleton when rows are already visible", () => {
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 100, query: "" })).toBe(false);
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 0, query: "codex" })).toBe(
      false,
    );
    expect(shouldShowSessionSkeleton({ isLoading: true, loadedRows: 0, query: "" })).toBe(true);
  });

  test("marks only short pages as exhausted so exact page multiples get one final probe", () => {
    expect(sessionPageExhausted({ receivedRows: 49, requestedRows: 50 })).toBe(true);
    expect(sessionPageExhausted({ receivedRows: 50, requestedRows: 50 })).toBe(false);
    expect(sessionPageExhausted({ receivedRows: 0, requestedRows: 50 })).toBe(true);
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
