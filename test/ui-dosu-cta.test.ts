import { describe, expect, test } from "bun:test";
import { shouldShowDosuCta } from "../src/ui/dosu-cta.ts";

describe("Dosu CTA visibility", () => {
  test("analytics dismissal persists independently of Insights", () => {
    expect(shouldShowDosuCta({ route: "analytics", dismissed: true })).toBe(false);
    expect(shouldShowDosuCta({ route: "insights", dismissed: true })).toBe(true);
  });
});
