import { describe, expect, test } from "bun:test";
import {
  highlightTranscriptCode,
  transcriptHighlighterIdentity,
} from "../src/ui/shiki-highlighter.ts";
import { TRANSCRIPT_PLAINTEXT_BYTES } from "../src/ui/transcript-rendering.ts";

describe("fine-grained transcript highlighter", () => {
  test("uses a singleton JavaScript-engine highlighter with explicit grammars and themes", async () => {
    const [first, second, highlighted] = await Promise.all([
      transcriptHighlighterIdentity(),
      transcriptHighlighterIdentity(),
      highlightTranscriptCode("const answer: number = 42", "ts", "dark"),
    ]);

    expect(first).toBe(second);
    expect(highlighted).toMatchObject({
      language: "typescript",
      theme: "dark",
    });
    expect(
      highlighted?.tokens
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe("const answer: number = 42");
    expect(highlighted?.tokens.flat().some((token) => token.color != null)).toBe(true);
  });

  test("falls back to plaintext for unknown languages and oversized blocks", async () => {
    expect(await highlightTranscriptCode("<p>text</p>", "html", "light")).toBeNull();
    expect(
      await highlightTranscriptCode(
        "x".repeat(TRANSCRIPT_PLAINTEXT_BYTES + 1),
        "typescript",
        "light",
      ),
    ).toBeNull();
  });
});
