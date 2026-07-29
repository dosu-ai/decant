import { describe, expect, test } from "bun:test";
import {
  collapseTranscriptText,
  createToolDiff,
  embeddedAttachmentSummary,
  languageForPath,
  languageForTool,
  markdownLinkBehavior,
  measureTranscriptContent,
  normalizeTranscriptLanguage,
  pathForTool,
  presentationForTool,
  safeMarkdownUrl,
  summarizeToolResult,
  TRANSCRIPT_COLLAPSE_BYTES,
  TRANSCRIPT_COLLAPSE_LINES,
  TRANSCRIPT_PLAINTEXT_BYTES,
  transcriptCollapseLabel,
} from "../src/ui/transcript-rendering.ts";

describe("embedded transcript attachments", () => {
  test("summarizes Claude image payloads without returning their base64 data", () => {
    const payload = "aGVsbG8=";
    const summary = embeddedAttachmentSummary(
      "other",
      JSON.stringify({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: payload },
      }),
    );
    expect(summary).toEqual({
      byteLength: 5,
      kind: "image",
      mediaType: "image/png",
    });
    expect(JSON.stringify(summary)).not.toContain(payload);
  });

  test("leaves ordinary, malformed, remote, and non-image blocks untouched", () => {
    expect(embeddedAttachmentSummary("text", '{"type":"image"}')).toBeNull();
    expect(embeddedAttachmentSummary("other", "not json")).toBeNull();
    expect(
      embeddedAttachmentSummary(
        "other",
        JSON.stringify({
          type: "image",
          source: { type: "url", media_type: "image/png", data: "aGVsbG8=" },
        }),
      ),
    ).toBeNull();
    expect(
      embeddedAttachmentSummary(
        "other",
        JSON.stringify({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "aGVsbG8=" },
        }),
      ),
    ).toBeNull();
  });
});

describe("transcript code language", () => {
  test("normalizes fence aliases and maps supported file extensions", () => {
    expect(normalizeTranscriptLanguage("ts")).toBe("typescript");
    expect(normalizeTranscriptLanguage("YML")).toBe("yaml");
    expect(normalizeTranscriptLanguage("html")).toBeNull();
    expect(languageForPath("/repo/src/view.tsx")).toBe("tsx");
    expect(languageForPath("C:\\repo\\script.py?raw=1")).toBe("python");
    expect(languageForPath("/repo/README.md#intro")).toBe("markdown");
    expect(languageForPath("/repo/Dockerfile")).toBeNull();
  });

  test("uses tool context before falling back to JSON arguments", () => {
    expect(languageForTool("Bash", '{"command":"bun test"}')).toBe("bash");
    expect(languageForTool("Read", '{"file_path":"/repo/main.rs"}')).toBe("rust");
    expect(languageForTool("mcp__github__get_file", '{"path":"src/main.go"}')).toBe("json");
    expect(languageForTool("Agent", '{"prompt":"inspect"}')).toBe("json");
    expect(pathForTool("NotebookEdit", '{"notebook_path":"/repo/demo.ipynb"}')).toBe(
      "/repo/demo.ipynb",
    );
  });
});

describe("transcript collapse policy", () => {
  test("collapses after 15 lines or 2 KiB and keeps smaller results open", () => {
    const short = "one\ntwo\nthree";
    expect(measureTranscriptContent(short)).toMatchObject({
      lineCount: 3,
      shouldCollapse: false,
      shouldHighlight: true,
    });

    const lines = Array.from(
      { length: TRANSCRIPT_COLLAPSE_LINES + 3 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const collapsed = collapseTranscriptText(lines);
    expect(collapsed.preview.split("\n")).toHaveLength(TRANSCRIPT_COLLAPSE_LINES);
    expect(collapsed.hiddenLineCount).toBe(3);
    expect(transcriptCollapseLabel(collapsed)).toBe("Show 3 more lines");

    const bytes = "é".repeat(TRANSCRIPT_COLLAPSE_BYTES / 2 + 1);
    const byteCollapsed = collapseTranscriptText(bytes);
    expect(byteCollapsed.shouldCollapse).toBe(true);
    expect(byteCollapsed.hiddenLineCount).toBe(0);
    expect(new TextEncoder().encode(byteCollapsed.preview).byteLength).toBeLessThanOrEqual(
      TRANSCRIPT_COLLAPSE_BYTES,
    );
    expect(byteCollapsed.omittedBytes).toBeGreaterThan(0);
    expect(transcriptCollapseLabel(byteCollapsed)).toBe("Show full result");
  });

  test("renders blocks over 50 KiB as plaintext", () => {
    expect(measureTranscriptContent("x".repeat(TRANSCRIPT_PLAINTEXT_BYTES)).shouldHighlight).toBe(
      true,
    );
    expect(
      measureTranscriptContent("x".repeat(TRANSCRIPT_PLAINTEXT_BYTES + 1)).shouldHighlight,
    ).toBe(false);
  });
});

describe("safe transcript markdown links", () => {
  test("allows inert destinations and rejects active or local-file schemes", () => {
    expect(safeMarkdownUrl("#message-2")).toBe("#message-2");
    expect(safeMarkdownUrl("/sessions/2")).toBe("/sessions/2");
    expect(safeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeMarkdownUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeMarkdownUrl("data:text/html,unsafe")).toBeUndefined();
    expect(safeMarkdownUrl("file:///Users/dev/secret")).toBeUndefined();
  });

  test("opens external links without an opener but keeps local links in-app", () => {
    expect(markdownLinkBehavior("https://example.com")).toEqual({
      external: true,
      href: "https://example.com",
      rel: "noopener noreferrer",
      target: "_blank",
    });
    expect(markdownLinkBehavior("/sessions/2")).toEqual({
      external: false,
      href: "/sessions/2",
    });
  });
});

describe("tool-aware transcript presentation", () => {
  test("extracts shell, file, search, MCP, and fallback presentations", () => {
    expect(
      presentationForTool("Bash", '{"command":"bun test","description":"Run focused tests"}'),
    ).toMatchObject({
      kind: "shell",
      caption: "Run focused tests",
      command: "bun test",
      language: "bash",
    });
    expect(
      presentationForTool("Write", '{"file_path":"/repo/src/app.ts","content":"export {}"}'),
    ).toMatchObject({
      kind: "file",
      content: "export {}",
      language: "typescript",
      operation: "write",
      path: "/repo/src/app.ts",
    });
    expect(presentationForTool("Grep", '{"pattern":"needle","path":"/repo"}')).toMatchObject({
      kind: "search",
      pattern: "needle",
      searchKind: "grep",
    });
    expect(presentationForTool("mcp__dosu__search", '{"query":"release"}')).toMatchObject({
      kind: "json",
      language: "json",
      source: "mcp",
    });
    expect(presentationForTool("mcp__filesystem__read", '{"path":"/repo/app.ts"}')).toMatchObject({
      kind: "json",
      language: "json",
      source: "mcp",
    });
  });

  test("builds line and word-aware edit data", () => {
    const diff = createToolDiff("const count = 1;\nkeep();\n", "const count = 2;\nkeep();\n");
    expect(diff.map((line) => line.kind)).toEqual(["removed", "added", "unchanged"]);
    expect(diff[0]?.parts).toContainEqual({ kind: "removed", value: "1" });
    expect(diff[1]?.parts).toContainEqual({ kind: "added", value: "2" });

    expect(
      presentationForTool(
        "Edit",
        '{"file_path":"/repo/src/app.ts","old_string":"const count = 1;","new_string":"const count = 2;"}',
      ),
    ).toMatchObject({
      kind: "edit",
      language: "typescript",
      path: "/repo/src/app.ts",
    });
  });

  test("falls back to the structured arguments instead of diffing oversized edits", () => {
    const oversized = "x".repeat(60 * 1024);
    expect(createToolDiff(oversized, `${oversized}y`)).toEqual([]);
  });

  test("summarizes search result counts without inventing other tool metrics", () => {
    expect(summarizeToolResult("Grep", "one\ntwo\n\nthree")).toBe("3 matches");
    expect(summarizeToolResult("Glob", "a.ts\nb.ts")).toBe("2 paths");
    expect(summarizeToolResult("Bash", "ok")).toBeNull();
  });
});
