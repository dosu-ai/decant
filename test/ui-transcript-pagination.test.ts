import { describe, expect, test } from "bun:test";
import { appendTranscriptPage, transcriptWindowOffset } from "../src/ui/transcript-pagination.ts";

describe("transcript pagination", () => {
  test("appends a page in order and removes retry overlap by sequence", () => {
    const current = [
      { seq: 0, text: "first" },
      { seq: 1, text: "second" },
    ];
    const incoming = [
      { seq: 1, text: "duplicate retry" },
      { seq: 2, text: "third" },
    ];

    expect(appendTranscriptPage(current, incoming)).toEqual([
      { seq: 0, text: "first" },
      { seq: 1, text: "second" },
      { seq: 2, text: "third" },
    ]);
  });

  test("does not mutate the existing message array", () => {
    const current = [{ seq: 0 }];
    expect(appendTranscriptPage(current, [])).not.toBe(current);
    expect(current).toEqual([{ seq: 0 }]);
  });

  test("opens unloaded outline targets with bounded preceding context", () => {
    expect(transcriptWindowOffset(1_574)).toBe(1_554);
    expect(transcriptWindowOffset(8)).toBe(0);
  });
});
