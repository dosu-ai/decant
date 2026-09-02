import { describe, expect, test } from "bun:test";
import { defaultPricing, estimateCost, isPriceable, type Price } from "../src/cost.ts";
import { emptyUsage, type TokenUsage } from "../src/model.ts";

// Ports cost.rs tests verbatim — these are the spec for model normalization
// (Bedrock ARNs, date/[1m] suffixes, aliases) and estimate-at-ingest.
function usage1m(): TokenUsage {
  return {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation1h: 0,
    reasoning: 0,
  };
}

describe("estimateCost", () => {
  test("opus input+output costs add up", () => {
    const cost = estimateCost("claude-opus-4-7", usage1m(), defaultPricing());
    expect(cost).toBeCloseTo(30.0, 6); // 1M @ $5 + 1M @ $25
  });

  test("cache writes bill 1.25x input at 5m TTL and 2x at 1h TTL", () => {
    const pricing = defaultPricing();
    const base = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    // Opus input is $5/Mtok, so 5m writes are $6.25/Mtok and 1h writes $10/Mtok.
    expect(
      estimateCost(
        "claude-opus-5",
        { ...base, cacheCreation: 1_000_000, cacheCreation1h: 0 },
        pricing,
      ),
    ).toBeCloseTo(6.25, 6);
    expect(
      estimateCost(
        "claude-opus-5",
        { ...base, cacheCreation: 1_000_000, cacheCreation1h: 1_000_000 },
        pricing,
      ),
    ).toBeCloseTo(10.0, 6);
  });

  test("invalid one-hour cache splits are clamped to the reported total", () => {
    const base = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    expect(
      estimateCost(
        "claude-opus-5",
        { ...base, cacheCreation: 1_000_000, cacheCreation1h: 2_000_000 },
        defaultPricing(),
      ),
    ).toBeCloseTo(10.0, 6);
    expect(
      estimateCost(
        "claude-opus-5",
        { ...base, cacheCreation: 1_000_000, cacheCreation1h: -1 },
        defaultPricing(),
      ),
    ).toBeCloseTo(6.25, 6);
  });

  test("reasoning tokens do not change cost", () => {
    const pricing = defaultPricing();
    const without = usage1m();
    const withReasoning = { ...usage1m(), reasoning: 750_000 };
    expect(estimateCost("claude-opus-4-8", withReasoning, pricing)).toBe(
      estimateCost("claude-opus-4-8", without, pricing),
    );
  });

  test("cache tokens are priced", () => {
    const usage: TokenUsage = { ...emptyUsage(), cacheRead: 1_000_000, cacheCreation: 1_000_000 };
    // opus: cache read $0.50 + cache write $6.25.
    expect(estimateCost("claude-opus-4-8", usage, defaultPricing())).toBeCloseTo(6.75, 6);
  });

  test("claude variants normalize to their tier", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    const opus = estimateCost("claude-opus-4-8", u, pricing);
    expect(opus).toBeCloseTo(30.0, 6);
    for (const m of [
      "claude-opus-4-6",
      "claude-opus-4-8[1m]",
      "opus",
      "us.anthropic.claude-opus-4-6-v1",
    ]) {
      expect(estimateCost(m, u, pricing)).toBeCloseTo(opus, 6);
    }
    const haiku = estimateCost("claude-haiku-4-5", u, pricing);
    expect(estimateCost("us.anthropic.claude-haiku-4-5-20251001-v1:0", u, pricing)).toBeCloseTo(
      haiku,
      6,
    );
    const sonnet = estimateCost("claude-sonnet-4-6", u, pricing);
    expect(estimateCost("us.anthropic.claude-sonnet-4-5-20250929-v1:0", u, pricing)).toBeCloseTo(
      sonnet,
      6,
    );
  });

  test("current claude version-specific prices are represented", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    expect(estimateCost("claude-opus-4-1", u, pricing)).toBeCloseTo(90.0, 6);
    expect(estimateCost("claude-opus-4", u, pricing)).toBeCloseTo(90.0, 6);
    expect(estimateCost("claude-sonnet-5", u, pricing)).toBeCloseTo(12.0, 6);
    expect(estimateCost("claude-sonnet-4-6", u, pricing)).toBeCloseTo(18.0, 6);
    expect(estimateCost("claude-haiku-3-5", u, pricing)).toBeCloseTo(4.8, 6);
    expect(estimateCost("claude-haiku-4-5", u, pricing)).toBeCloseTo(6.0, 6);
  });

  test("gpt family is priced", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    expect(estimateCost("gpt-5.6-sol", u, pricing)).toBeCloseTo(24.0, 6);
    expect(estimateCost("gpt-5.6", u, pricing)).toBeCloseTo(24.0, 6);
    expect(estimateCost("openai/gpt-5.6", u, pricing)).toBeCloseTo(24.0, 6);
    expect(estimateCost("gpt-daybreak-blue-latest", u, pricing)).toBeCloseTo(24.0, 6);
    expect(estimateCost("gpt-5.6-terra", u, pricing)).toBeCloseTo(14.0, 6);
    expect(estimateCost("gpt-5.6-luna", u, pricing)).toBeCloseTo(1.4, 6);
    expect(estimateCost("gpt-5.6-cyber", u, pricing)).toBeCloseTo(87.5, 6);
    expect(estimateCost("gpt-daybreak-red-latest", u, pricing)).toBeCloseTo(87.5, 6);
    expect(estimateCost("gpt-5", u, pricing)).toBeCloseTo(11.25, 6);
    expect(estimateCost("gpt-5.1", u, pricing)).toBeCloseTo(11.25, 6);
    expect(estimateCost("gpt-5-mini", u, pricing)).toBeCloseTo(2.25, 6);
    expect(estimateCost("gpt-5-nano", u, pricing)).toBeCloseTo(0.45, 6);
    expect(estimateCost("gpt-5-pro", u, pricing)).toBeCloseTo(135.0, 6);
    expect(estimateCost("gpt-5.4", u, pricing)).toBeCloseTo(17.5, 6);
    expect(estimateCost("gpt-5.4-mini", u, pricing)).toBeCloseTo(5.25, 6);
    expect(estimateCost("gpt-5.4-nano", u, pricing)).toBeCloseTo(1.45, 6);
    expect(estimateCost("gpt-5.4-pro", u, pricing)).toBeCloseTo(210.0, 6);
    expect(estimateCost("gpt-5.5", u, pricing)).toBeCloseTo(35.0, 6);
    expect(estimateCost("gpt-5.5-pro", u, pricing)).toBeCloseTo(210.0, 6);
  });

  test("gpt-5.6 uses the published input, cache, and output rates", () => {
    const pricing = defaultPricing();
    expect(pricing.get("gpt-5.6-sol")).toEqual({
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheReadPerMtok: 0.4,
      cacheWritePerMtok: 5,
      cacheWrite1hPerMtok: 5,
    });
    expect(pricing.get("gpt-5.6-terra")).toEqual({
      inputPerMtok: 2,
      outputPerMtok: 12,
      cacheReadPerMtok: 0.2,
      cacheWritePerMtok: 2.5,
      cacheWrite1hPerMtok: 2.5,
    });
    expect(pricing.get("gpt-5.6-luna")).toEqual({
      inputPerMtok: 0.2,
      outputPerMtok: 1.2,
      cacheReadPerMtok: 0.02,
      cacheWritePerMtok: 0.25,
      cacheWrite1hPerMtok: 0.25,
    });
    expect(pricing.get("gpt-5.6-cyber")).toEqual({
      inputPerMtok: 12.5,
      outputPerMtok: 75,
      cacheReadPerMtok: 1.25,
      cacheWritePerMtok: 15.625,
      cacheWrite1hPerMtok: 15.625,
    });
  });

  test("published openai legacy and reasoning models are priced", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    expect(estimateCost("gpt-4.1", u, pricing)).toBeCloseTo(10.0, 6);
    expect(estimateCost("gpt-4.1-mini", u, pricing)).toBeCloseTo(2.0, 6);
    expect(estimateCost("gpt-4.1-nano", u, pricing)).toBeCloseTo(0.5, 6);
    expect(estimateCost("gpt-4o", u, pricing)).toBeCloseTo(12.5, 6);
    expect(estimateCost("gpt-4o-2024-05-13", u, pricing)).toBeCloseTo(20.0, 6);
    expect(estimateCost("gpt-4o-mini", u, pricing)).toBeCloseTo(0.75, 6);
    expect(estimateCost("o1", u, pricing)).toBeCloseTo(75.0, 6);
    expect(estimateCost("o1-pro", u, pricing)).toBeCloseTo(750.0, 6);
    expect(estimateCost("o3", u, pricing)).toBeCloseTo(10.0, 6);
    expect(estimateCost("o3-pro", u, pricing)).toBeCloseTo(100.0, 6);
    expect(estimateCost("o4-mini", u, pricing)).toBeCloseTo(5.5, 6);
    expect(estimateCost("o3-mini", u, pricing)).toBeCloseTo(5.5, 6);
    expect(estimateCost("o1-mini", u, pricing)).toBeCloseTo(5.5, 6);
    expect(estimateCost("gpt-4-turbo-2024-04-09", u, pricing)).toBeCloseTo(40.0, 6);
    expect(estimateCost("gpt-4-0125-preview", u, pricing)).toBeCloseTo(40.0, 6);
    expect(estimateCost("gpt-4-1106-preview", u, pricing)).toBeCloseTo(40.0, 6);
    expect(estimateCost("gpt-4-0613", u, pricing)).toBeCloseTo(90.0, 6);
    expect(estimateCost("gpt-4-32k", u, pricing)).toBeCloseTo(180.0, 6);
    expect(estimateCost("gpt-3.5-turbo", u, pricing)).toBeCloseTo(2.0, 6);
    expect(estimateCost("gpt-3.5-turbo-1106", u, pricing)).toBeCloseTo(3.0, 6);
    expect(estimateCost("gpt-3.5-turbo-16k-0613", u, pricing)).toBeCloseTo(7.0, 6);
    expect(estimateCost("gpt-3.5-turbo-0301", u, pricing)).toBeCloseTo(3.5, 6);
    expect(estimateCost("davinci-002", u, pricing)).toBeCloseTo(4.0, 6);
    expect(estimateCost("babbage-002", u, pricing)).toBeCloseTo(0.8, 6);
  });

  test("codex models are priced", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    const cached = { ...emptyUsage(), cacheRead: 1_000_000 };
    expect(estimateCost("gpt-5.3-codex", u, pricing)).toBeCloseTo(15.75, 6);
    expect(estimateCost("gpt-5.3-codex", cached, pricing)).toBeCloseTo(0.175, 6);
    expect(estimateCost("gpt-5.2-codex", u, pricing)).toBeCloseTo(15.75, 6);
    expect(estimateCost("gpt-5.2", u, pricing)).toBeCloseTo(15.75, 6);
    expect(estimateCost("gpt-5.1-codex", u, pricing)).toBeCloseTo(11.25, 6);
    expect(estimateCost("gpt-5.1-codex-max", u, pricing)).toBeCloseTo(11.25, 6);
    expect(estimateCost("gpt-5.1-codex-mini", u, pricing)).toBeCloseTo(2.25, 6);
    expect(estimateCost("gpt-5.1-codex-mini", cached, pricing)).toBeCloseTo(0.025, 6);
    expect(estimateCost("gpt-5-codex", u, pricing)).toBeCloseTo(11.25, 6);
    expect(estimateCost("codex-mini-latest", u, pricing)).toBeCloseTo(7.5, 6);
    expect(estimateCost("codex-mini-latest", cached, pricing)).toBeCloseTo(0.375, 6);
  });

  test("unpublished Codex aliases are not assigned guessed API prices", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    for (const model of [
      "codex-auto-review",
      "gpt-5.3-codex-spark",
      "gpt-5-codex-mini",
      "gpt-5.4-cyber",
    ]) {
      expect(estimateCost(model, u, pricing)).toBe(0);
      expect(isPriceable(model)).toBe(false);
    }
  });

  test("openai models without a cached-input discount do not make cache reads free", () => {
    const usage: TokenUsage = { ...emptyUsage(), cacheRead: 1_000_000, cacheCreation: 1_000_000 };
    expect(estimateCost("gpt-5-pro", usage, defaultPricing())).toBeCloseTo(30.0, 6);
  });

  test("fable canonical model forms", () => {
    const pricing = defaultPricing();
    const u = usage1m();
    const fable = estimateCost("claude-fable-5", u, pricing);
    for (const m of ["claude-fable-5[1m]", "fable"]) {
      expect(estimateCost(m, u, pricing)).toBeCloseTo(fable, 6);
    }
    expect(estimateCost("claude-mythos-5", u, pricing)).toBeCloseTo(fable, 6);
  });

  test("fable 5.1 and mythos 5.1 use their reduced cache-read rate", () => {
    const pricing = defaultPricing();
    expect(pricing.get("claude-fable-5-1")).toEqual({
      inputPerMtok: 10,
      outputPerMtok: 50,
      cacheReadPerMtok: 0.25,
      cacheWritePerMtok: 12.5,
      cacheWrite1hPerMtok: 20,
    });
    const cacheRead = { ...emptyUsage(), cacheRead: 1_000_000 };
    for (const model of [
      "claude-fable-5-1",
      "claude-fable-5.1",
      "anthropic.claude-fable-5-1-v1:0",
      "claude-mythos-5-1",
      "claude-mythos-5.1",
    ]) {
      expect(estimateCost(model, cacheRead, pricing)).toBeCloseTo(0.25, 6);
    }
    expect(estimateCost("claude-fable-5", cacheRead, pricing)).toBeCloseTo(1.0, 6);
    expect(estimateCost("claude-mythos-5", cacheRead, pricing)).toBeCloseTo(1.0, 6);
    expect(estimateCost("claude-fable-5-10", cacheRead, pricing)).toBeCloseTo(1.0, 6);
  });

  test("fable input+output costs add up", () => {
    expect(estimateCost("claude-fable-5", usage1m(), defaultPricing())).toBeCloseTo(60.0, 6);
  });

  test("unknown models are zero", () => {
    const pricing = defaultPricing();
    const usage: TokenUsage = { ...emptyUsage(), input: 5_000, output: 5_000 };
    expect(estimateCost("<synthetic>", usage, pricing)).toBe(0.0);
    expect(estimateCost("exa-research-pro", usage, pricing)).toBe(0.0);
    expect(estimateCost("some-future-llm", usage, pricing)).toBe(0.0);
    expect(estimateCost(null, usage, pricing)).toBe(0.0);
  });

  test("unrecognized claude tier is unpriceable", () => {
    expect(estimateCost("claude-quill-9", usage1m(), defaultPricing())).toBe(0.0);
    expect(isPriceable("claude-quill-9")).toBe(false);
  });

  test("known canonical key missing from pricing table is zero", () => {
    const pricing = new Map<string, Price>([
      [
        "claude-opus",
        {
          inputPerMtok: 5.0,
          outputPerMtok: 25.0,
          cacheReadPerMtok: 0.5,
          cacheWritePerMtok: 6.25,
          cacheWrite1hPerMtok: 10.0,
        },
      ],
    ]);
    expect(estimateCost("claude-haiku-4-5", usage1m(), pricing)).toBe(0.0);
  });
});

describe("isPriceable", () => {
  test("distinguishes known from unknown", () => {
    expect(isPriceable("claude-haiku-4-5")).toBe(true);
    expect(isPriceable("gpt-5.4-mini")).toBe(true);
    expect(isPriceable("gpt-4o-mini")).toBe(true);
    expect(isPriceable("o3-pro")).toBe(true);
    expect(isPriceable("opus")).toBe(true);
    expect(isPriceable("<synthetic>")).toBe(false);
    expect(isPriceable("exa-research-pro")).toBe(false);
  });
});
