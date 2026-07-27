import { describe, expect, test } from "bun:test";
import { classifyTool, preview, previewHeadTail } from "../src/tools.ts";

// Ports tools.rs tests verbatim.
describe("classifyTool", () => {
  test("builtin tool", () => {
    expect(classifyTool("Bash")).toEqual({ kind: "builtin", mcpServer: null, baseName: "Bash" });
  });

  test("simple mcp tool", () => {
    expect(classifyTool("mcp__claude_ai_Linear__create_issue")).toEqual({
      kind: "mcp",
      mcpServer: "claude_ai_Linear",
      baseName: "create_issue",
    });
  });

  test("nested gateway mcp tool keeps __ in the base name", () => {
    expect(classifyTool("mcp__codex_apps__hubspot__create_deal")).toEqual({
      kind: "mcp",
      mcpServer: "codex_apps",
      baseName: "hubspot__create_deal",
    });
  });

  test("mcp prefix without server separator", () => {
    expect(classifyTool("mcp__lonely")).toEqual({
      kind: "mcp",
      mcpServer: null,
      baseName: "lonely",
    });
  });
});

describe("preview", () => {
  test("truncates by characters with an ellipsis", () => {
    expect(preview("abcdef", 3)).toBe("abc…");
    expect(preview("ab", 3)).toBe("ab");
  });

  test("counts Unicode scalars, not UTF-16 code units", () => {
    // "🎉🎉🎉" is 6 UTF-16 code units but 3 scalars — must NOT truncate at max 3,
    // and truncation at 2 must not split a surrogate pair.
    expect(preview("🎉🎉🎉", 3)).toBe("🎉🎉🎉");
    expect(preview("🎉🎉🎉", 2)).toBe("🎉🎉…");
  });
});

describe("previewHeadTail", () => {
  test("returns short strings unchanged", () => {
    expect(previewHeadTail("all good", 500)).toBe("all good");
  });

  test("keeps head and tail with an elision marker", () => {
    const s = `HEAD${"x".repeat(2000)}Error: assertion failed at foo.ts:42`;
    const out = previewHeadTail(s, 100);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("Error: assertion failed at foo.ts:42".slice(-40))).toBe(true);
    expect(out).toContain("chars omitted");
  });

  test("counts Unicode scalars without splitting surrogate pairs", () => {
    const s = "🎉".repeat(300);
    const out = previewHeadTail(s, 100);
    expect(out).not.toContain("�");
    for (const part of out.split(/\n\[… \d+ chars omitted …\]\n/)) {
      expect([...part].every((c) => c === "🎉")).toBe(true);
    }
  });
  test("keeps no tail when max is too small for one, without leaking the whole string", () => {
    expect(previewHeadTail("abcdef", 2)).toBe("ab\n[… 4 chars omitted …]\n");
  });
});
