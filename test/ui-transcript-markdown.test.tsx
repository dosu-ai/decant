import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMarkdown } from "../src/ui/transcript-markdown.tsx";

describe("transcript markdown rendering", () => {
  test("renders GFM through React elements and never renders active HTML or images", () => {
    const html = renderToStaticMarkup(
      <TranscriptMarkdown>{`~~done~~

- [x] checked

| A | B |
| - | - |
| 1 | 2 |

[unsafe](javascript:alert(1))

![remote](https://example.com/tracker.png)

<script>alert("no")</script>`}</TranscriptMarkdown>,
    );

    expect(html).toContain("<del>done</del>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("tracker.png");
  });

  test("marks external links and renders fenced code as plaintext before lazy highlighting", () => {
    const html = renderToStaticMarkup(
      <TranscriptMarkdown>{`[docs](https://example.com/docs)

\`\`\`ts
const value: number = 1
\`\`\``}</TranscriptMarkdown>,
    );

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-language="typescript"');
    expect(html).toContain("const value: number = 1");
  });
});
