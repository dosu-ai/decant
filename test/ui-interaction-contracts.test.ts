import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = main.indexOf(start);
  const endIndex = main.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return main.slice(startIndex, endIndex);
}

describe("UI interaction contracts", () => {
  test("aborts and ignores stale load-more search responses", () => {
    const search = sourceBetween("function SearchView(", "function groupSearchHits(");

    expect(search).toContain("loadMoreControllerRef.current?.abort()");
    expect(search).toContain("signal: controller.signal");
    expect(search).toContain("searchEpochRef.current !== epoch");
    expect(search).toContain("loadMoreControllerRef.current === controller");
  });

  test("does not activate stale search results and exposes arrow selection to assistive tech", () => {
    const search = sourceBetween("function SearchView(", "function groupSearchHits(");

    expect(search).toContain("resultsQueryRef.current = null");
    expect(search).toContain("setHits([])");
    expect(search).toContain("resultsQueryRef.current === query.trim()");
    expect(search).toContain('role="combobox"');
    expect(search).toContain('role="listbox"');
    expect(search).toContain('role="option"');
    expect(search).toContain("aria-activedescendant={activeHitId}");
    expect(search).toContain("aria-selected={index === activeIndex}");
  });

  test("exposes tool-call details as a focus-managed modal with a keyboard entry point", () => {
    const detail = sourceBetween("function ToolCallDetail(", "function ToolsView(");
    const tools = sourceBetween("function ToolsView(", "function FilesView(");

    expect(detail).toContain("useDialogFocusTrap(true, dialogRef, onClose)");
    expect(detail).toContain('aria-modal="true"');
    expect(detail).toContain('role="dialog"');
    expect(detail).toContain("aria-labelledby={titleId}");
    expect(tools).toContain('className="tool-call-detail-button"');
    expect(tools).toContain("Inspect ${call.tool_name");
  });

  test("keeps compaction anchors exposed in the accessibility tree", () => {
    const chart = sourceBetween("function ContextWindowStrip(", "function compactionTokenRange(");

    expect(chart).not.toContain('role="img"');
    expect(chart).toContain("Compactions ");
    expect(chart).toContain(" through ");
    expect(chart).toContain("href={`#message-");
  });
});
