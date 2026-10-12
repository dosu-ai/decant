import { describe, expect, test } from "bun:test";
import type { Json } from "../src/model.ts";
import {
  legacyAssistantUsage,
  openCodeUsage,
  parseOpenCodeVersion,
  reasoningOverlap,
} from "../src/sources/opencode-usage.ts";

const t = (o: object) => ({
  input: 100,
  output: 50,
  reasoning: 20,
  cache: { read: 0, write: 0 },
  ...o,
});

describe("reasoningOverlap", () => {
  test("classifies by total, then by version", () => {
    expect(reasoningOverlap(t({ total: 150 }), "2.0.27")).toBe("included");
    expect(reasoningOverlap(t({ total: 170 }), "1.0.0")).toBe("disjoint");
    expect(reasoningOverlap(t({}), "1.3.15")).toBe("included");
    expect(reasoningOverlap(t({}), "1.3.16")).toBe("disjoint");
    expect(reasoningOverlap(t({}), "0.15.31")).toBe("included");
    expect(reasoningOverlap(t({}), "local")).toBe("disjoint");
    expect(reasoningOverlap(t({}), null)).toBe("disjoint");
    expect(reasoningOverlap(t({ total: 999 }), "1.2.0")).toBe("included");
  });
  test("zero reasoning is always disjoint", () => {
    expect(reasoningOverlap(t({ reasoning: 0 }), "1.2.0")).toBe("disjoint");
  });
});

describe("openCodeUsage", () => {
  test("adds reasoning to output only when disjoint", () => {
    expect(openCodeUsage(t({}), "disjoint")).toMatchObject({ output: 70, reasoning: 20 });
    expect(openCodeUsage(t({}), "included")).toMatchObject({ output: 50, reasoning: 20 });
    expect(openCodeUsage(t({ reasoning: 80 }), "included")).toMatchObject({
      output: 50,
      reasoning: 50,
    });
  });
  test("maps cache read and write and drops negative or fractional counts", () => {
    expect(
      openCodeUsage(
        { input: -1, output: 2.5, reasoning: 0, cache: { read: 7, write: 3 } },
        "disjoint",
      ),
    ).toEqual({
      input: 0,
      output: 0,
      cacheRead: 7,
      cacheCreation: 3,
      cacheCreation1h: 0,
      reasoning: 0,
    });
    expect(openCodeUsage(undefined, "disjoint")).toBeNull();
  });
});

describe("legacyAssistantUsage", () => {
  test("sums every step-finish part, not info.tokens", () => {
    const info = {
      cost: 0.0000478,
      tokens: { input: 200, output: 12, reasoning: 0, cache: { read: 60, write: 0 } },
    };
    const parts: Json[] = [
      {
        type: "step-finish",
        tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { type: "text", text: "x" },
      {
        type: "step-finish",
        tokens: { input: 200, output: 12, reasoning: 0, cache: { read: 60, write: 0 } },
      },
    ];
    expect(legacyAssistantUsage(info, parts, "1.18.35")).toMatchObject({
      input: 250,
      output: 17,
      cacheRead: 60,
    });
  });
  test("classifies each step on its own", () => {
    // A step whose total says reasoning is inside output, next to one whose
    // total says it is not; both written by the same session.
    const parts: Json[] = [
      { type: "step-finish", tokens: t({ total: 150 }) },
      { type: "step-finish", tokens: t({ total: 170 }) },
    ];
    expect(legacyAssistantUsage({ cost: 0.00009 }, parts, "1.3.10")).toMatchObject({
      output: 120,
      reasoning: 40,
    });
  });
  test("falls back to info.tokens, and is null for an unfinished request", () => {
    expect(legacyAssistantUsage({ cost: 0.00005, tokens: t({}) }, [], "1.2.0")).toMatchObject({
      output: 50,
    });
    expect(
      legacyAssistantUsage(
        { cost: 0, tokens: t({ input: 0, output: 0, reasoning: 0 }) },
        [],
        "1.18.35",
      ),
    ).toBeNull();
    expect(legacyAssistantUsage({ cost: 0 }, [], "1.18.35")).toBeNull();
  });
  test("keeps zero recorded tokens when the request was billed", () => {
    expect(
      legacyAssistantUsage(
        { cost: 0.001, tokens: t({ input: 0, output: 0, reasoning: 0 }) },
        [],
        "1.18.35",
      ),
    ).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 0,
    });
  });
  test("parses versions", () => {
    expect(parseOpenCodeVersion("1.3.16")).toEqual([1, 3, 16]);
    expect(parseOpenCodeVersion("v1.18.35-beta.2")).toEqual([1, 18, 35]);
    expect(parseOpenCodeVersion("dev")).toBeNull();
    expect(parseOpenCodeVersion(null)).toBeNull();
  });
});
