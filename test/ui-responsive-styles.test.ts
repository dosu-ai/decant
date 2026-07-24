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
  });

  test("keeps wide data surfaces inside their panels", () => {
    expect(rule(".activity-table-wrap")).toContain("overflow-x: auto");
    expect(rule(".ctx-strip-frame")).toContain("overflow: hidden");
    expect(rule(".ctx-strip")).toContain("max-width: 100%");
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
