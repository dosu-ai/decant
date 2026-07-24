import { describe, expect, test } from "bun:test";
import {
  nextTranscriptSeq,
  transcriptNavigationDirection,
  transcriptSeqFromHash,
} from "../src/ui/transcript-navigation.ts";

describe("transcript keyboard navigation", () => {
  test("maps unmodified arrow keys and leaves modified shortcuts alone", () => {
    expect(transcriptNavigationDirection({ key: "ArrowDown" })).toBe(1);
    expect(transcriptNavigationDirection({ key: "ArrowUp" })).toBe(-1);
    expect(transcriptNavigationDirection({ key: "ArrowDown", metaKey: true })).toBeNull();
    expect(transcriptNavigationDirection({ key: "ArrowUp", shiftKey: true })).toBeNull();
    expect(transcriptNavigationDirection({ key: "Enter" })).toBeNull();
  });

  test("moves through sparse message sequences in either direction", () => {
    const sequences = [4, 7, 43, 56];
    expect(nextTranscriptSeq(sequences, null, 1)).toBe(4);
    expect(nextTranscriptSeq(sequences, 7, 1)).toBe(43);
    expect(nextTranscriptSeq(sequences, 43, -1)).toBe(7);
    expect(nextTranscriptSeq(sequences, 56, 1)).toBeNull();
  });

  test("recognizes stable message anchors without accepting malformed hashes", () => {
    expect(transcriptSeqFromHash("#message-1574")).toBe(1574);
    expect(transcriptSeqFromHash("#message-nope")).toBeNull();
    expect(transcriptSeqFromHash("#turn-4")).toBeNull();
  });
});
