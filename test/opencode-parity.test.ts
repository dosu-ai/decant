import { describe, expect, test } from "bun:test";
import {
  compareModelTotals,
  compareRecordedCost,
  compareSessionTotals,
  type ModelTotals,
  parseStatsJson,
  type SessionTotals,
} from "../scripts/opencode-parity.ts";

function model(overrides: Partial<ModelTotals>): ModelTotals {
  return {
    provider: "opencode-go",
    model: "glm-5.3-flash",
    steps: 2,
    input: 320,
    output: 42,
    reasoning: 10,
    cacheRead: 100,
    cacheWrite: 16,
    cost: 0.0000794,
    ...overrides,
  };
}

describe("opencode parity comparisons", () => {
  test("matches a model whose Decant output equals the reference output plus reasoning", () => {
    const decant = [model({ output: 52, reasoning: 10, cost: 0.0000794 })];
    const reference = [model({ output: 42, reasoning: 10 })];
    const lines = compareModelTotals(decant, reference, "opencode.db");
    expect(lines.map((line) => line.level)).toEqual(["ok"]);
    expect(lines[0]?.text).toContain("opencode-go/glm-5.3-flash");
  });

  test("flags every field that differs, and models missing on either side", () => {
    const decant = [model({ output: 52, cacheWrite: 0 })];
    const reference = [
      model({}),
      model({ provider: "openrouter", model: "meta/muse-wonder", steps: 1 }),
    ];
    const lines = compareModelTotals(decant, reference, "stats.json");
    expect(lines.map((line) => line.level)).toEqual(["mismatch", "mismatch"]);
    expect(lines[0]?.text).toContain("cacheWrite 0 vs 16");
    expect(lines[0]?.text).not.toContain("output");
    expect(lines[1]?.text).toContain("missing in Decant");
  });

  test("compares list-price cost with the recorded cost within half a percent", () => {
    const reference = [model({ cost: 0.0000794 }), model({ provider: "zai-coding-plan", cost: 0 })];
    const decant = [
      model({ output: 52, cost: 0.0000795 }),
      model({ provider: "zai-coding-plan", output: 52, cost: 0.0000794 }),
    ];
    const lines = compareRecordedCost(decant, reference);
    expect(lines).toEqual([
      { level: "ok", text: expect.stringContaining("opencode-go/glm-5.3-flash") },
      { level: "info", text: expect.stringContaining("zai-coding-plan/glm-5.3-flash") },
    ]);
    expect(compareRecordedCost([model({ output: 52, cost: 0.0001 })], [model({})])[0]?.level).toBe(
      "mismatch",
    );
  });

  test("allows Decant session totals at or below the recorded ones, never above", () => {
    const base: SessionTotals = {
      sessionId: "ses_a",
      input: 320,
      output: 52,
      reasoning: 10,
      cacheRead: 100,
      cacheWrite: 16,
      cost: 0.0000794,
    };
    const reference: SessionTotals[] = [base, { ...base, sessionId: "ses_b", input: 400 }];
    const decant: SessionTotals[] = [base, { ...base, sessionId: "ses_b", input: 410 }];
    const lines = compareSessionTotals(decant, reference);
    expect(lines.map((line) => line.level)).toEqual(["ok", "mismatch"]);
    expect(lines[1]?.text).toContain("input 410 > 400");
    expect(compareSessionTotals([{ ...base, input: 300 }], [base])[0]?.level).toBe("ok");
  });

  test("reads the models list from opencode stats --json output", () => {
    const text = JSON.stringify({
      models: [
        {
          model: { providerID: "opencode-go", id: "glm-5.3-flash", variant: "max" },
          steps: 2,
          tokens: { input: 320, output: 42, reasoning: 10, cache: { read: 100, write: 16 } },
          cost: 0.0000794,
        },
        {
          model: { providerID: "opencode-go", id: "glm-5.3-flash" },
          steps: 1,
          tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.000002,
        },
      ],
    });
    // Variants collapse into one provider/model line.
    const parsed = parseStatsJson(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      provider: "opencode-go",
      model: "glm-5.3-flash",
      steps: 3,
      input: 330,
      output: 43,
      reasoning: 10,
      cacheRead: 100,
      cacheWrite: 16,
    });
    expect(parsed[0]?.cost).toBeCloseTo(0.0000814, 12);
    expect(() => parseStatsJson("{}")).toThrow("models");
  });
});
