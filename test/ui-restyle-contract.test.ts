import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

/** The classes the Venice restyle hangs its layout on. Each is written in JSX and
 * styled in CSS, and a rename on either side silently drops the design rather
 * than failing — there is no build step that pairs the two files. */
const RESTYLED_CLASSES = [
  "stat-grid",
  "stat-card",
  "stat-icon",
  "page-heading",
  "inline-heading",
  "nav-group-label",
  "date-range-buttons",
  "primary-button",
  "secondary-button",
  "topbar-search",
  "theme-toggle",
  "badge",
  "brand",
] as const;

describe("restyle contract", () => {
  test.each([...RESTYLED_CLASSES])("%s is both rendered and styled", (className) => {
    expect(main).toMatch(new RegExp(`className=[{"\`][^"\`]*\\b${className}\\b`));
    expect(styles).toMatch(new RegExp(`^\\.${className}[\\s,{:]`, "m"));
  });

  test("stat cells are ruled by the grid gap, not by adjacency", () => {
    // `.stat-card + .stat-card { border-left }` follows DOM order, which stops
    // matching visual position the moment a grid wraps — Analytics renders six
    // cards and Tools four. The gap-over-tinted-background approach draws both
    // axes correctly at any column count, so keep the container owning the rules.
    expect(styles).not.toMatch(/\.stat-card \+ \.stat-card/);
    const grid = /\.stat-grid \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(grid).toContain("gap: 1px");
    expect(grid).toContain("background: var(--line)");
    expect(grid).toContain("overflow: hidden");
  });

  test("the display serif is only asked for a weight that ships", () => {
    // Only SourceSerif4-Semibold is vendored. Requesting 400 or 700 makes the
    // browser synthesize a face instead of reporting a missing one.
    const serifWeights = [...styles.matchAll(/font-family: var\(--font-serif\)[^}]*?}/gs)]
      .flatMap((match) => [...match[0].matchAll(/font-weight: (\d+)/g)])
      .flatMap((match) => match[1] ?? []);
    expect(serifWeights.length).toBeGreaterThan(0);
    for (const weight of serifWeights) {
      expect(weight).toBe("600");
    }
  });
});
