import { describe, expect, test } from "bun:test";
import { collectSliceResults } from "../src/ui/slice-loading.ts";

type TestData = {
  recommendations: string[];
  settings: string;
};

describe("dashboard slice loading", () => {
  test("keeps fulfilled slice data when a sibling request fails", () => {
    const failure = new Error("settings unavailable");
    const settled = collectSliceResults<keyof TestData, TestData>(
      ["recommendations", "settings"],
      [
        { status: "fulfilled", value: { recommendations: ["signal"] } },
        { status: "rejected", reason: failure },
      ],
    );

    expect(settled.data).toEqual({ recommendations: ["signal"] });
    expect(settled.loaded).toEqual(["recommendations"]);
    expect(settled.failures).toEqual([{ slice: "settings", reason: failure }]);
  });

  test("records each failed slice without inventing successful data", () => {
    const settled = collectSliceResults<keyof TestData, TestData>(
      ["recommendations", "settings"],
      [
        { status: "rejected", reason: "recommendations failed" },
        { status: "rejected", reason: "settings failed" },
      ],
    );

    expect(settled.data).toEqual({});
    expect(settled.loaded).toEqual([]);
    expect(settled.failures.map((failure) => failure.slice)).toEqual([
      "recommendations",
      "settings",
    ]);
  });
});
