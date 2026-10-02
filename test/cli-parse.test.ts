import { describe, expect, test } from "bun:test";
import { parseInteger } from "../src/cli/parse.ts";

describe("parseInteger", () => {
  test("accepts whole integers", () => {
    expect(parseInteger("42")).toBe(42);
    expect(parseInteger("-3")).toBe(-3);
    expect(parseInteger(" 7 ")).toBe(7);
  });

  test("rejects values with a trailing non-digit part", () => {
    // A source session id must not resolve to whatever archive id its digit prefix names.
    expect(() => parseInteger("0123abcd-0000-4000-8000-000000000000")).toThrow(
      "expected an integer",
    );
    expect(() => parseInteger("42fe0000")).toThrow("expected an integer");
    expect(() => parseInteger("10abc")).toThrow("expected an integer");
    expect(() => parseInteger("1.5")).toThrow("expected an integer");
    expect(() => parseInteger("")).toThrow("expected an integer");
  });
});
