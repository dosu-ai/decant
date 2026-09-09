import { describe, expect, test } from "bun:test";
import {
  dosuBadgeAriaLabel,
  dosuBadgeVisualLabel,
  dosuEvidenceSummary,
  dosuNestedCalls,
} from "../src/ui/dosu-badge.ts";

describe("Dosu provenance badge copy", () => {
  test("keeps direct, nested, and tree scopes explicit", () => {
    const evidence = { directCalls: 2, treeCalls: 5 };
    expect(dosuNestedCalls(evidence)).toBe(3);
    expect(dosuEvidenceSummary(evidence)).toBe(
      "5 verified tool calls across this session tree · 2 direct · 3 nested · aggregate only",
    );
  });

  test("uses accessible singular and responsive visual labels", () => {
    expect(dosuBadgeAriaLabel({ directCalls: 1, treeCalls: 1 })).toBe(
      "Optimized with Dosu; Dosu MCP used 1 time",
    );
    expect(dosuBadgeVisualLabel(false)).toBe("Optimized");
    expect(dosuBadgeVisualLabel(true)).toBe("Optimized");
  });
});
