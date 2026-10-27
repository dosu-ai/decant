import { describe, expect, test } from "bun:test";
import {
  collectSliceResults,
  dateScopedSliceStatus,
  loadSlicesIndependently,
} from "../src/ui/slice-loading.ts";

type TestData = {
  recommendations: string[];
  settings: string;
};

describe("dashboard slice loading", () => {
  test("retains same-date data during refresh but never labels another date scope ready", () => {
    expect(dateScopedSliceStatus("|3", false, "")).toBe("ready");
    expect(dateScopedSliceStatus("|3", true, "")).toBe("ready");
    expect(dateScopedSliceStatus("|3", false, "from=2026-05-01")).toBe("loading");
    expect(dateScopedSliceStatus("|3", true, "from=2026-05-01")).toBe("failed");
    expect(dateScopedSliceStatus("from=2026-05-01|4", false, "from=2026-05-01")).toBe("ready");
    expect(dateScopedSliceStatus("from=2026-05-01|4", false, "")).toBe("loading");
    expect(dateScopedSliceStatus(undefined, false, "")).toBe("loading");
  });
  test("publishes available data while a sibling request is still pending", async () => {
    let finishSettings: ((value: Partial<TestData>) => void) | undefined;
    const settings = new Promise<Partial<TestData>>((resolve) => {
      finishSettings = resolve;
    });
    const settled: string[] = [];
    const firstResult = Promise.withResolvers<void>();
    const loading = loadSlicesIndependently<keyof TestData, TestData>(
      ["recommendations", "settings"],
      (slice) =>
        slice === "settings" ? settings : Promise.resolve({ recommendations: ["signal"] }),
      (slice, result) => {
        settled.push(slice);
        expect(result.status).toBe("fulfilled");
        firstResult.resolve();
      },
    );

    await firstResult.promise;
    expect(settled).toEqual(["recommendations"]);
    finishSettings?.({ settings: "ready" });
    await loading;
    expect(settled).toEqual(["recommendations", "settings"]);
  });

  test("reports failed slices independently without dropping a successful sibling", async () => {
    const results: PromiseSettledResult<Partial<TestData>>[] = [];
    await loadSlicesIndependently<keyof TestData, TestData>(
      ["recommendations", "settings"],
      (slice) => {
        if (slice === "settings") {
          throw new Error("settings unavailable");
        }
        return Promise.resolve({ recommendations: ["signal"] });
      },
      (_slice, result) => results.push(result),
    );
    expect(results).toContainEqual({ status: "fulfilled", value: { recommendations: ["signal"] } });
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: new Error("settings unavailable"),
    });
  });

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
