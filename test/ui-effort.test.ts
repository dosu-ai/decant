import { describe, expect, test } from "bun:test";
import { effortTooltip } from "../src/ui/effort.ts";

describe("effort tooltip", () => {
  test("explains the unique normalized levels behind a mixed session", () => {
    expect(effortTooltip(" Mixed ", ["high", " ULTRA ", "high", "mixed", ""])).toBe(
      "Effort levels used: high, ultra",
    );
  });

  test("stays absent when there is nothing useful to explain", () => {
    expect(effortTooltip("mixed", [])).toBeUndefined();
    expect(effortTooltip("mixed", null)).toBeUndefined();
    expect(effortTooltip("mixed", undefined)).toBeUndefined();
    expect(effortTooltip("ultra", ["ultra"])).toBeUndefined();
    expect(effortTooltip(null, ["high", "ultra"])).toBeUndefined();
  });
});
