import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readUiFile, readUiSource } from "./ui-source.ts";

const root = join(import.meta.dir, "..");
const main = readUiSource();
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

function jsxElementWithClassName(source: string, className: string): string {
  const opening = new RegExp(`<(\\w+)\\s+className="${className}"`).exec(source);
  if (opening == null) {
    throw new Error(`no element with className="${className}"`);
  }
  const tag = opening[1];
  const tags = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, "g");
  tags.lastIndex = opening.index;
  let depth = 0;
  for (let match = tags.exec(source); match != null; match = tags.exec(source)) {
    const closing = match[0].startsWith("</");
    const selfClosing = match[1] === "/";
    if (!closing && !selfClosing) {
      depth += 1;
    } else if (closing) {
      depth -= 1;
    }
    if (depth === 0) {
      return source.slice(opening.index, match.index + match[0].length);
    }
  }
  throw new Error(`className="${className}" opens a <${tag}> that never closes`);
}

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

  test("the analytics stat grid never strands a card on a short row", () => {
    const grid = jsxElementWithClassName(
      readUiFile("views/analytics.tsx"),
      "stat-grid analytics-stat-grid",
    );
    const cards = grid.match(/<StatCard/g)?.length ?? 0;
    expect(cards).toBe(8);

    expect(styles).not.toMatch(/\.analytics-stat-grid \{[^}]*auto-(?:fit|fill)/);

    const declared = [...styles.matchAll(/\.analytics-stat-grid \{([^}]*)\}/g)];
    expect(declared.length).toBeGreaterThan(1);
    for (const declaration of declared) {
      const repeat = /repeat\(\s*(\d+)\s*,/.exec(declaration[1] ?? "");
      const columns = repeat == null ? 1 : Number(repeat[1]);
      expect(cards % columns).toBe(0);
    }
  });

  test("stat cells are ruled by the grid gap, not by adjacency", () => {
    expect(styles).not.toMatch(/\.stat-card \+ \.stat-card/);
    const grid = /\.stat-grid \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(grid).toContain("gap: 1px");
    expect(grid).toContain("background: var(--line)");
    expect(grid).toContain("border-top: 1px solid var(--line)");
    expect(grid).toContain("border-bottom: 1px solid var(--line)");
    expect(grid).not.toContain("border-radius");
    expect(/\.stat-card \{([^}]*)\}/.exec(styles)?.[1] ?? "").toContain(
      "background: var(--canvas)",
    );
  });

  test("table headers are sentence case, as the design draws them", () => {
    const th = /^th \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(th).toContain("text-transform: none");
    expect(th).toContain("letter-spacing: 0");
    expect(th).not.toContain("var(--font-mono)");
  });

  test("the Analytics source select uses the toolbar's 13px strong type", () => {
    const source =
      /^\.source-filter-control \.select-shell select \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(source).toContain("font-size: 13px");
    expect(source).toContain("font-weight: var(--font-weight-strong)");
  });

  test("persistent sticky headers stay opaque during scrolling", () => {
    for (const selector of ["topbar", "thread-header"]) {
      const block = new RegExp(`^\\s*\\.${selector}\\s*\\{([^}]*)\\}`, "m").exec(styles)?.[1] ?? "";
      expect(block).toContain("position: sticky");
      expect(block).toContain("background: var(--canvas)");
      expect(block).not.toContain("backdrop-filter");
    }

    for (const selector of ["header", "footer"]) {
      const blocks = [
        ...styles.matchAll(
          new RegExp(`^\\s*\\.share-review-sheet\\s*>\\s*${selector}\\s*\\{([^}]*)\\}`, "gm"),
        ),
      ];
      const block = blocks.find((match) => match[1]?.includes("position: sticky"))?.[1] ?? "";
      expect(block).toContain("position: sticky");
      expect(block).toContain("background: var(--surface)");
      expect(block).not.toContain("backdrop-filter");
    }
  });

  test("backdrop blur stays on transient overlays, never on per-row chrome", () => {
    const badge = /^\s*\.badge\s*\{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(badge).toContain("background: var(--bg-components-badge-default)");
    expect(badge).not.toContain("backdrop-filter");

    const overlays = new Set([
      ".command-palette-backdrop",
      ".command-palette",
      ".share-review-backdrop",
      ".overflow-menu-popover",
      ".date-range-popover",
      ".sidebar-backdrop.is-open",
    ]);
    const blurred = [...styles.matchAll(/([^{}]+)\{([^{}]*backdrop-filter[^{}]*)\}/g)].map(
      (match) => match[1]?.trim().split("\n").at(-1)?.trim() ?? "",
    );
    expect(blurred.length).toBeGreaterThan(0);
    expect(blurred.filter((selector) => !overlays.has(selector))).toEqual([]);
  });

  test("the date-range popover stays inside the page gutter", () => {
    const blocks = [
      ...styles.matchAll(
        /^\s*(?:\.date-range-menu\S*\s*>\s*)?\.date-range-popover\s*\{([^}]*)\}/gm,
      ),
    ].map((match) => match[1] ?? "");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      expect(block).not.toMatch(/(^|\s)(left|right):\s*-/m);
    }
    const start =
      /^\.date-range-menu\[data-align="start"\]\s*>\s*\.date-range-popover\s*\{([^}]*)\}/m.exec(
        styles,
      )?.[1] ?? "";
    expect(start).toContain("left: 0");
    expect(start).toContain("right: auto");
  });

  test("the display serif is only asked for a weight that ships", () => {
    const weightTokens = new Map(
      [...styles.matchAll(/--font-weight-(\w+):\s*(\d+);/g)].map((match) => [
        match[1] as string,
        match[2] as string,
      ]),
    );
    expect(weightTokens.size).toBe(3);
    const serifWeights = [...styles.matchAll(/font-family: var\(--font-serif\)[^}]*?}/gs)]
      .flatMap((match) => [...match[0].matchAll(/font-weight: var\(--font-weight-(\w+)\)/g)])
      .map((match) => weightTokens.get(match[1] as string));
    expect(serifWeights.length).toBeGreaterThan(0);
    for (const weight of serifWeights) {
      expect(weight).toBe("400");
    }
    expect(styles).toMatch(/--text-serif-xl-regular:\s*400 /);
  });

  test("badges truncate with an ellipsis instead of clipping raw text", () => {
    const badge = /^\s*\.badge\s*\{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(badge).toContain("overflow: hidden");
    expect(badge).toContain("text-overflow: ellipsis");
    expect(badge).toContain("white-space: nowrap");

    const modelCol = /\.col-session-model\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(modelCol).toMatch(/width:\s*1\d\dpx/);
    expect(modelCol).not.toMatch(/width:\s*\d+%/);
  });
});
