import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

describe("responsive session detail styles", () => {
  test("allows the page, panels, and nested transcript tracks to shrink", () => {
    expect(rule(".session-detail")).toContain("max-width: 100%");
    expect(rule(".session-detail > *")).toContain("min-width: 0");
    expect(rule(".panel")).toContain("min-width: 0");
    expect(rule(".transcript-layout > *")).toContain("min-width: 0");
    expect(rule(".turn-body > *")).toContain("min-width: 0");
  });

  test("wraps unbroken transcript content instead of widening the page", () => {
    expect(rule(".text-block,\n.thinking-block p")).toContain("overflow-wrap: anywhere");
    expect(rule(".special-block p")).toContain("overflow-wrap: anywhere");
    expect(rule(".special-block .realtime-line p")).toContain("overflow-wrap: anywhere");
    expect(rule(".tool-shell .transcript-code-pre")).toContain("white-space: pre-wrap");
    expect(rule(".tool-shell .transcript-code-pre")).toContain("overflow-wrap: anywhere");
    expect(rule(".tool-arguments .transcript-code-pre")).toContain("white-space: pre-wrap");
    expect(rule(".tool-arguments .transcript-code-pre")).toContain("overflow-wrap: anywhere");
    expect(rule(".tool-presentation > p")).toContain("overflow-wrap: anywhere");
  });

  test("keeps wide data surfaces inside their panels", () => {
    expect(rule(".activity-table-wrap")).toContain("overflow-x: auto");
    expect(rule(".ctx-strip-frame")).toContain("overflow: hidden");
    expect(rule(".ctx-strip")).toContain("max-width: 100%");
    expect(rule(".ctx-tooltip")).toContain("max-width: calc(100% - 4px)");
    expect(rule(".ctx-strip-compaction-marker rect")).toContain("stroke: var(--accent)");
  });

  test("collapses the transcript navigation at laptop widths", () => {
    const start = styles.indexOf("@media (max-width: 1200px)");
    const end = styles.indexOf("@media (max-width: 980px)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const laptopRules = styles.slice(start, end);
    expect(laptopRules).toContain(".transcript-layout");
    expect(laptopRules).toContain("grid-template-columns: 1fr");
    expect(laptopRules).toContain(".toc");
    expect(laptopRules).toContain("display: none");
  });
});

describe("responsive command palette", () => {
  test("keeps one desktop trigger and exposes the mobile trigger below the breakpoint", () => {
    expect(rule(".icon-button.topbar-search-mobile")).toContain("display: none");
    const mobileStart = styles.indexOf("@media (max-width: 767px)");
    const mobileEnd = styles.indexOf("@media (max-width: 640px)", mobileStart);
    const mobileRules = styles.slice(mobileStart, mobileEnd);
    expect(mobileRules).toContain(".topbar-search");
    expect(mobileRules).toContain("display: none");
    expect(mobileRules).toContain(".icon-button.topbar-search-mobile");
    expect(mobileRules).toContain("display: inline-grid");
  });

  test("bounds the modal to the dynamic viewport and scrolls its results independently", () => {
    expect(rule(".command-palette")).toContain("100dvh");
    expect(rule(".command-palette")).toContain("overflow: hidden");
    expect(rule(".command-palette-results")).toContain("overflow-y: auto");
  });
});

describe("responsive Dosu surfaces", () => {
  test("aligns sidebar metadata and attribution to the same icon column", () => {
    expect(rule(".sidebar-stat")).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(rule(".dosu-attribution")).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(styles).not.toContain(".live-dot");
  });

  test("keeps ambient attribution quiet until interaction", () => {
    expect(rule(".dosu-attribution")).toContain("font-size: 12px");
    expect(rule(".dosu-attribution")).toContain("color: var(--faint)");
    expect(rule(".dosu-attribution:hover")).toContain("color: var(--fg)");
  });

  test("gives the badge a compact mobile label without removing its full accessible name", () => {
    expect(rule(".dosu-label-compact")).toContain("display: none");
    const mobileStart = styles.indexOf("@media (max-width: 640px)");
    const reducedMotionStart = styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      mobileStart,
    );
    const mobileRules = styles.slice(mobileStart, reducedMotionStart);
    expect(mobileRules).toContain(".dosu-label-full");
    expect(mobileRules).toContain("display: none");
    expect(mobileRules).toContain(".dosu-label-compact");
    expect(mobileRules).toContain("display: inline");
  });

  test("contains the share review sheet and stacks its privacy contract on mobile", () => {
    expect(rule(".share-review-sheet")).toContain("max-height: calc(100vh - 48px)");
    expect(rule(".share-review-sheet")).toContain("overflow-y: auto");
    expect(rule(".share-copy-review p")).toContain("overflow-wrap: anywhere");
    const mobileStart = styles.indexOf("@media (max-width: 640px)");
    const reducedMotionStart = styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      mobileStart,
    );
    const mobileRules = styles.slice(mobileStart, reducedMotionStart);
    expect(mobileRules).toContain(".share-privacy-review");
    expect(mobileRules).toContain("grid-template-columns: 1fr");
  });

  test("elevates verified Dosu calls and gives their thread markers a distinct surface", () => {
    expect(rule(".tool-call.is-dosu")).toContain("box-shadow:");
    expect(rule(".tool-call.is-dosu")).toContain("background:");
    expect(rule(".toc-icon.is-dosu")).toContain("background:");
  });
});
