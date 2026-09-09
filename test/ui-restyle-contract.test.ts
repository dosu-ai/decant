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

  test("the analytics stat grid never strands a card on a short row", () => {
    // Six cards, so every column count it declares must divide six exactly.
    // `auto-fit` used to pick whatever fitted -- five columns anywhere between
    // 980px and 1151px -- which left the sixth card alone against an empty row.
    // Guard the marker so a renamed or reordered class names itself rather than
    // reporting a card count of zero. Note the slice assumes the grid stays
    // inline in this component at six-space indent; extracting it would shift
    // the closing tag and inflate the count rather than fail cleanly.
    const marker = main.indexOf('"stat-grid analytics-stat-grid"');
    expect(marker).toBeGreaterThanOrEqual(0);
    const markup = main.slice(marker);
    const grid = markup.slice(0, markup.indexOf("\n      </div>"));
    const cards = grid.match(/<StatCard/g)?.length ?? 0;
    expect(cards).toBe(6);

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
    // `.stat-card + .stat-card { border-left }` follows DOM order, which stops
    // matching visual position the moment a grid wraps — Analytics renders six
    // cards and Tools four. The gap-over-tinted-background approach draws both
    // axes correctly at any column count, so keep the container owning the rules.
    expect(styles).not.toMatch(/\.stat-card \+ \.stat-card/);
    const grid = /\.stat-grid \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(grid).toContain("gap: 1px");
    expect(grid).toContain("background: var(--line)");
    // A ruled band on the page, not a card: the design has a rule above and below
    // the row and hairlines between the cells, with no outer box or fill. Cells
    // therefore carry --canvas, so they read as page rather than as panels.
    expect(grid).toContain("border-top: 1px solid var(--line)");
    expect(grid).toContain("border-bottom: 1px solid var(--line)");
    expect(grid).not.toContain("border-radius");
    expect(/\.stat-card \{([^}]*)\}/.exec(styles)?.[1] ?? "").toContain(
      "background: var(--canvas)",
    );
  });

  test("table headers are sentence case, as the design draws them", () => {
    // The design's table-head component is Inter 12/500 with letterSpacing 0, and
    // both designed screens render "Cost Share" / "Peak CTX" / "Agent Runs". The
    // uppercase treatment predated this branch; the design asks for it gone.
    const th = /^th \{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(th).toContain("text-transform: none");
    expect(th).toContain("letter-spacing: 0");
    expect(th).not.toContain("var(--font-mono)");
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
    // Every backdrop-filter is its own compositor render surface, resampled on each
    // frame it intersects. Fifty rows of blurred badges made fast flings checkerboard.
    const badge = /^\s*\.badge\s*\{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(badge).toContain("background: var(--bg-components-badge-default)");
    expect(badge).not.toContain("backdrop-filter");

    const overlays = new Set([
      ".command-palette-backdrop",
      ".command-palette",
      ".share-review-backdrop",
      ".overflow-menu-popover",
      ".sidebar-backdrop.is-open",
    ]);
    const blurred = [...styles.matchAll(/([^{}]+)\{([^{}]*backdrop-filter[^{}]*)\}/g)].map(
      (match) => match[1]?.trim().split("\n").at(-1)?.trim() ?? "",
    );
    expect(blurred.length).toBeGreaterThan(0);
    expect(blurred.filter((selector) => !overlays.has(selector))).toEqual([]);
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
    // The serif text token carries the weight for callers using the shorthand,
    // which the sweep above cannot see because it names no font-family.
    expect(styles).toMatch(/--text-serif-xl-regular:\s*400 /);
  });

  test("badges truncate with an ellipsis instead of clipping raw text", () => {
    // Fixed-percentage table columns can squeeze badge content. Model ids like
    // claude-opus-4-7 used to render past the badge boundary with no overflow
    // guard, so the text vanished mid-character with no way to see the rest.
    const badge = /^\s*\.badge\s*\{([^}]*)\}/m.exec(styles)?.[1] ?? "";
    expect(badge).toContain("overflow: hidden");
    expect(badge).toContain("text-overflow: ellipsis");
    expect(badge).toContain("white-space: nowrap");

    // The model column used to carry a fixed percentage that squeezed badges.
    // Fixed pixel widths stop the badge and title columns from compressing
    // into mid-character cut-offs, and the tooltip carries the full name.
    const modelCol = /\.col-session-model\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(modelCol).toMatch(/width:\s*1\d\dpx/);
    expect(modelCol).not.toMatch(/width:\s*\d+%/);
  });
});
