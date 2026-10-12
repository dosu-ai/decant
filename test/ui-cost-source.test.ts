import { describe, expect, test } from "bun:test";
import { costSourceLabel, costSourceTooltip } from "../src/ui/cost-source.ts";

describe("cost source copy", () => {
  test("labels only costs that came from OpenCode's record", () => {
    expect(costSourceLabel("decant")).toBeNull();
    expect(costSourceLabel("reported")).toBe("reported by OpenCode");
    expect(costSourceLabel("mixed")).toBe("partly reported by OpenCode");
  });

  test("explains each source in the tooltip", () => {
    expect(costSourceTooltip("decant")).toContain("Decant's list rates");
    expect(costSourceTooltip("reported")).toContain("OpenCode recorded");
    expect(costSourceTooltip("reported")).toContain("no rate for this model");
    expect(costSourceTooltip("mixed")).toContain("rest is estimated");
  });
});
