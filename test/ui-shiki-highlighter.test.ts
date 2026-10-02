import { describe, expect, test } from "bun:test";
import {
  highlightTranscriptCode,
  transcriptHighlighterIdentity,
} from "../src/ui/shiki-highlighter.ts";
import { TRANSCRIPT_PLAINTEXT_BYTES } from "../src/ui/transcript-rendering.ts";

// Regexes compile lazily and the first calls can hit tokenizeTimeLimit, which
// truncates tokens; repeat until the grammar is warm before asserting on them.
async function warmHighlight(code: string, language: string) {
  let result = await highlightTranscriptCode(code, language, "dark");
  for (let attempt = 0; attempt < 6; attempt++) {
    result = await highlightTranscriptCode(code, language, "dark");
  }
  return result;
}

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

  test("highlights JavaScript, including JSX, under its own language name", async () => {
    const code = 'const el = <div className="a">{x}</div>;\nif (a < b && c > d) run();';
    const highlighted = await warmHighlight(code, "js");
    expect(highlighted?.language).toBe("javascript");
    const contents = highlighted?.tokens.flat().map((token) => token.content) ?? [];
    expect(highlighted?.tokens.map((line) => line.map((t) => t.content).join("")).join("\n")).toBe(
      code,
    );
    expect(contents).toContain("&&");
    expect(contents).toContain("className");
  });

  test("keeps TypeScript on its own grammar so angle brackets are not read as JSX", async () => {
    const code = "if (a < b && c > d) { call<Foo>(bar); }";
    const highlighted = await warmHighlight(code, "ts");
    const contents = highlighted?.tokens.flat().map((token) => token.content) ?? [];
    expect(contents.join("")).toBe(code);
    expect(contents.some((content) => content.includes("&&"))).toBe(true);
    expect(contents).toContain("call");
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
