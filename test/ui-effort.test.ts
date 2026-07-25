import { describe, expect, test } from "bun:test";
import { effortDisplayLabel, effortTooltip } from "../src/ui/effort.ts";

describe("effort tooltip", () => {
  test("labels every current provider effort plus numeric budgets", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(effortDisplayLabel(effort, true)).toBe(`effort ${effort}`);
      expect(effortDisplayLabel(effort)).toBe(effort);
    }
    expect(effortDisplayLabel("Future-Level", true)).toBe("effort Future-Level");
    expect(effortDisplayLabel("Future-Level")).toBe("Future-Level");
    expect(effortDisplayLabel("16384", true)).toBe("effort 16384 tokens");
    expect(effortDisplayLabel("16384")).toBe("16384 tokens");
    expect(effortDisplayLabel(" Effort XHIGH ", true)).toBe("effort xhigh");
    expect(effortDisplayLabel("")).toBeNull();
    expect(effortDisplayLabel(null)).toBeNull();
  });

  test("explains the unique normalized levels behind a mixed session", () => {
    expect(effortTooltip(" Mixed ", ["high", " ULTRA ", "Future-Level", "high", "mixed", ""])).toBe(
      "Effort levels used: high, ultra, Future-Level",
    );
  });

  test("labels numeric budgets in mixed-session explanations", () => {
    expect(effortTooltip("mixed", ["high", "16384"])).toBe(
      "Effort levels used: high, 16384 tokens",
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
