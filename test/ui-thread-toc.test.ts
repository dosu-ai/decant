import { describe, expect, test } from "bun:test";
import { threadTocFromOutline } from "../src/ui/thread-toc.tsx";

describe("threadTocFromOutline", () => {
  test("keeps keys unique when one block carries several Dosu calls", () => {
    const items = threadTocFromOutline([
      { seq: 1, ordinal: -1, kind: "prompt", text: "Look it up." },
      { seq: 2, ordinal: 0, kind: "dosu", text: "read_knowledge" },
      { seq: 2, ordinal: 0, kind: "dosu", text: "write_knowledge" },
      { seq: 2, ordinal: 1, kind: "dosu", text: "read_knowledge" },
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "prompt:1",
      "dosu:2:0",
      "dosu:2:0:1",
      "dosu:2:1",
    ]);
    expect(items.map((item) => item.seq)).toEqual([1, 2, 2, 2]);
  });
});
