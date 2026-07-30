import { describe, expect, test } from "bun:test";
import { exactSearchRemaining, searchPageMayHaveMore } from "../src/ui/search-pagination.ts";

describe("search pagination availability", () => {
  test("uses a known total when the supplementary count succeeds", () => {
    expect(searchPageMayHaveMore({ lastPageSize: 25, loaded: 25, pageSize: 25, total: 26 })).toBe(
      true,
    );
    expect(searchPageMayHaveMore({ lastPageSize: 25, loaded: 25, pageSize: 25, total: 25 })).toBe(
      false,
    );
  });

  test("keeps pagination available from a full page when the count is unavailable", () => {
    expect(searchPageMayHaveMore({ lastPageSize: 25, loaded: 25, pageSize: 25, total: null })).toBe(
      true,
    );
    expect(searchPageMayHaveMore({ lastPageSize: 7, loaded: 32, pageSize: 25, total: null })).toBe(
      false,
    );
  });

  test("continues past a capped total until a short page proves the end", () => {
    expect(
      searchPageMayHaveMore({
        lastPageSize: 25,
        loaded: 1_000,
        pageSize: 25,
        total: 1_000,
        totalIsCapped: true,
      }),
    ).toBe(true);
    expect(
      searchPageMayHaveMore({
        lastPageSize: 7,
        loaded: 1_007,
        pageSize: 25,
        total: 1_000,
        totalIsCapped: true,
      }),
    ).toBe(false);
  });

  test("never presents a capped count as an exact remaining count", () => {
    expect(exactSearchRemaining(1_000, 1_000, true)).toBeNull();
    expect(exactSearchRemaining(1_000, 1_025, true)).toBeNull();
    expect(exactSearchRemaining(30, 25, false)).toBe(5);
  });
});
