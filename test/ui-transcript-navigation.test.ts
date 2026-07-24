import { describe, expect, test } from "bun:test";
import {
  isInteractiveTarget,
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

describe("interactive target guard", () => {
  /** A node that reports itself as sitting inside an anchor. */
  const insideAnchor = (extra: Record<string, unknown> = {}) => ({
    matches: () => false,
    closest: (selectors: string) => (selectors.includes("a,") ? {} : null),
    ...extra,
  });

  test("guards focusable elements that are not HTMLElement", () => {
    // The compaction markers in the context-window strip render as <a> inside
    // the <svg>, so they are SVGAElement: focusable and tabbable, but carrying
    // no isContentEditable. Narrowing on HTMLElement let arrow keys fall
    // through and teleport the transcript while preventDefault() suppressed
    // the scroll the user actually asked for.
    expect(isInteractiveTarget(insideAnchor())).toBe(true);
  });

  test("guards form fields and contenteditable regions", () => {
    expect(isInteractiveTarget({ matches: () => true, closest: () => null })).toBe(true);
    expect(
      isInteractiveTarget({ matches: () => false, closest: () => null, isContentEditable: true }),
    ).toBe(true);
  });

  test("lets plain transcript content through", () => {
    expect(isInteractiveTarget({ matches: () => false, closest: () => null })).toBe(false);
  });

  test("rejects anything that is not element-shaped", () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(undefined)).toBe(false);
    expect(isInteractiveTarget("article")).toBe(false);
    expect(isInteractiveTarget({})).toBe(false);
    expect(isInteractiveTarget({ matches: () => false })).toBe(false);
  });
});
