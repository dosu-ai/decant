import { describe, expect, test } from "bun:test";
import type { Issue } from "../src/model.ts";
import {
  block,
  countUnknown,
  parseJsonLine,
  type UnknownTypes,
  unknownTypeIssues,
} from "../src/sources/shared.ts";

describe("block", () => {
  test("defaults every optional field with a stable key order", () => {
    const built = block(2, "text", { text: "hi" });
    expect(Object.keys(built)).toEqual([
      "ordinal",
      "blockType",
      "text",
      "toolName",
      "toolUseId",
      "toolInput",
      "toolResult",
      "isError",
    ]);
    expect(built).toEqual({
      ordinal: 2,
      blockType: "text",
      text: "hi",
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    });
  });

  test("keeps toolInput as an own property when absent and preserves JSON null", () => {
    expect(Object.hasOwn(block(0, "other"), "toolInput")).toBe(true);
    expect(block(0, "tool_use", { toolInput: null }).toolInput).toBeNull();
  });
});

describe("parseJsonLine", () => {
  test("returns undefined for blank lines without recording an issue", () => {
    const issues: Issue[] = [];
    expect(parseJsonLine("   ", 1, issues)).toBeUndefined();
    expect(issues).toEqual([]);
  });

  test("parses valid JSON, including null", () => {
    const issues: Issue[] = [];
    expect(parseJsonLine('{"a":1}', 1, issues)).toEqual({ a: 1 });
    expect(parseJsonLine("null", 2, issues)).toBeNull();
    expect(issues).toEqual([]);
  });

  test("records an unparsed_line issue with the 1-based line and raw text", () => {
    const issues: Issue[] = [];
    expect(parseJsonLine("{oops", 7, issues)).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unparsed_line", lineNo: 7, rawLine: "{oops" });
    expect(issues[0]?.error).not.toBe("");
  });
});

describe("unknown record types", () => {
  test("counts per type, keeps the first line, and emits issues in first-seen order", () => {
    const unknown: UnknownTypes = new Map();
    countUnknown(unknown, "beta", 4);
    countUnknown(unknown, "alpha", 2);
    countUnknown(unknown, "beta", 9);
    expect(unknownTypeIssues(unknown, "ignored")).toEqual([
      {
        code: "unknown_record_type",
        lineNo: 4,
        error: 'unknown record type "beta" on 2 line(s); ignored',
        rawLine: null,
      },
      {
        code: "unknown_record_type",
        lineNo: 2,
        error: 'unknown record type "alpha" on 1 line(s); ignored',
        rawLine: null,
      },
    ]);
  });

  test("emits nothing when no unknown types were seen", () => {
    expect(unknownTypeIssues(new Map(), "ignored")).toEqual([]);
  });
});
