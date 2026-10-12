import { describe, expect, test } from "bun:test";
import type { Json } from "../src/model.ts";
import {
  legacyAssistantUsage,
  migratedUsage,
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
  test("dates a preview build by the timestamp in its version", () => {
    // Preview builds record 0.0.0-<channel>-<YYYYMMDDHHmm> (UTC); 1.3.16 was
    // tagged 2026-04-06T03:44Z.
    expect(reasoningOverlap(t({}), "0.0.0-dev-202604060343")).toBe("included");
    expect(reasoningOverlap(t({}), "0.0.0-dev-202604060344")).toBe("disjoint");
    expect(reasoningOverlap(t({}), "0.0.0-beta-202609110000")).toBe("disjoint");
    expect(reasoningOverlap(t({}), "0.0.0-feat-some-branch-202603010000")).toBe("included");
    // The recorded total still decides first.
    expect(reasoningOverlap(t({ total: 170 }), "0.0.0-dev-202603010000")).toBe("disjoint");
    expect(reasoningOverlap(t({ total: 150 }), "0.0.0-dev-202609010000")).toBe("included");
    // A real 0.x release (JSON-storage era, imported by 1.2) stays included.
    expect(reasoningOverlap(t({}), "0.0.0")).toBe("included");
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

describe("migratedUsage", () => {
  const message = (id: string, info: object) => ({ id, data: JSON.stringify(info) });
  const step = (messageId: string, tokens: object) => ({
    message_id: messageId,
    data: JSON.stringify({ type: "step-finish", tokens }),
  });

  test("keys assistants by id and compaction requests by their first summary", () => {
    const usage = migratedUsage(
      "1.18.35",
      [
        message("msg_u", { role: "user" }),
        message("msg_a", { role: "assistant", modelID: "m", cost: 0.25 }),
        message("msg_s1", { role: "assistant", summary: true, parentID: "msg_c", modelID: "s" }),
        message("msg_s2", { role: "assistant", summary: true, parentID: "msg_c", modelID: "x" }),
        { id: "msg_bad", data: "{not json" },
      ],
      [
        step("msg_a", t({ reasoning: 0 })),
        step("msg_a", t({ reasoning: 0 })),
        { message_id: "msg_a", data: "{not json" },
        step("msg_s1", t({ input: 7, reasoning: 0 })),
      ],
    );
    expect([...usage.assistants.keys()]).toEqual(["msg_a", "msg_s1", "msg_s2"]);
    expect(usage.assistants.get("msg_a")).toMatchObject({
      modelId: "m",
      cost: 0.25,
      usage: { input: 200, output: 100 },
    });
    expect([...usage.compactions.keys()]).toEqual(["msg_c"]);
    expect(usage.compactions.get("msg_c")).toMatchObject({
      modelId: "s",
      cost: null,
      usage: { input: 7 },
    });
    // No step-finish parts and nothing recorded: an unfinished request.
    expect(usage.assistants.get("msg_s2")?.usage).toBeNull();
  });
});
