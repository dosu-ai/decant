import { describe, expect, test } from "bun:test";
import { shouldShowDosuCta } from "../src/ui/dosu-cta.ts";

describe("Dosu CTA visibility", () => {
  test("the kill switch hides every contextual surface", () => {
    expect(shouldShowDosuCta({ route: "analytics", suggestions: "hide" })).toBe(false);
    expect(shouldShowDosuCta({ route: "insights", suggestions: "hide" })).toBe(false);
  });

  test("analytics dismissal persists independently of Insights", () => {
    expect(shouldShowDosuCta({ route: "analytics", suggestions: "show", dismissed: true })).toBe(
      false,
    );
    expect(shouldShowDosuCta({ route: "insights", suggestions: "show", dismissed: true })).toBe(
      true,
    );
  });
});
