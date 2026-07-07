import { describe, expect, test } from "bun:test";
import {
  planSessionLoad,
  sessionTableBodyState,
  shouldShowSessionSkeleton,
} from "../src/ui/loading-state.ts";

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

  test("preserves expanded load depth when refreshing in the background", () => {
    expect(
      planSessionLoad({
        loadedRequestKey: "all:1",
        loadedRows: 300,
        pageSize: 100,
        requestKey: "all:2",
        sessionLimit: 300,
      }),
    ).toEqual({ limit: 300, offset: 0, replace: true });
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
});

describe("session table body state", () => {
  test("a failed first load shows the inline error, not a skeleton or empty state", () => {
    expect(
      sessionTableBodyState({
        errored: true,
        filteredRows: 0,
        isLoading: false,
        loadedRows: 0,
        query: "",
      }),
    ).toBe("error");
  });

  test("a failed background refresh keeps the loaded rows on screen", () => {
    expect(
      sessionTableBodyState({
        errored: true,
        filteredRows: 80,
        isLoading: false,
        loadedRows: 100,
        query: "",
      }),
    ).toBe("rows");
  });

  test("first load without rows shows the skeleton", () => {
    expect(
      sessionTableBodyState({
        errored: false,
        filteredRows: 0,
        isLoading: true,
        loadedRows: 0,
        query: "",
      }),
    ).toBe("skeleton");
  });

  test("a filter that matches nothing shows the empty message, never a skeleton", () => {
    expect(
      sessionTableBodyState({
        errored: false,
        filteredRows: 0,
        isLoading: false,
        loadedRows: 100,
        query: "zzz",
      }),
    ).toBe("empty");
    expect(
      sessionTableBodyState({
        errored: false,
        filteredRows: 0,
        isLoading: true,
        loadedRows: 0,
        query: "zzz",
      }),
    ).toBe("empty");
  });

  test("an empty archive shows the empty message once loading settles", () => {
    expect(
      sessionTableBodyState({
        errored: false,
        filteredRows: 0,
        isLoading: false,
        loadedRows: 0,
        query: "",
      }),
    ).toBe("empty");
  });

  test("loaded rows render", () => {
    expect(
      sessionTableBodyState({
        errored: false,
        filteredRows: 100,
        isLoading: false,
        loadedRows: 100,
        query: "",
      }),
    ).toBe("rows");
  });
});
