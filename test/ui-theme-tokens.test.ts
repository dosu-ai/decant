import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");

/** Token names `chartColors()` hands to ECharts. Kept in sync with main.tsx by
 * the first test below rather than by hope. */
const CHART_TOKENS = [
  "--fg",
  "--muted",
  "--faint",
  "--line",
  "--surface",
  "--accent",
  "--info",
  "--success",
  "--warning",
] as const;

/** Every `--name: value` pair inside a block, indentation normalized away. */
function declarations(block: string): string[] {
  return [...block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)].map(
    (match) => `${match[1]}: ${match[2]?.replace(/\s+/g, " ").trim()}`,
  );
}

function tokenValue(name: string, block: string): string | undefined {
  return new RegExp(`^\\s*${name}:\\s*([^;]+);`, "im").exec(block)?.[1]?.trim();
}

function blockAfter(marker: string, closer: string): string {
  const start = styles.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf(closer, start + marker.length);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

const rootBlock = blockAfter(":root {\n  color-scheme: light;", "\n}");
const darkMediaBlock = blockAfter(":root:not([data-theme]) {\n    color-scheme: dark;", "\n  }");
const darkAttrBlock = blockAfter('[data-theme="dark"] {\n  color-scheme: dark;', "\n}");

describe("theme tokens", () => {
  test("the two dark blocks stay identical", () => {
    // CSS cannot share declarations between a media query and an attribute
    // selector, so dark is deliberately written twice. Drift between the copies
    // shows up only as "dark mode looks subtly wrong on one machine", which is
    // exactly the bug nobody files.
    const fromMedia = declarations(darkMediaBlock);
    const fromAttribute = declarations(darkAttrBlock);
    expect(fromMedia.length).toBeGreaterThan(10);
    expect(fromAttribute).toEqual(fromMedia);
  });

  test("dark overrides every themed token light defines", () => {
    // A token defined in light but forgotten in dark inherits the light value and
    // renders cream-on-cream. Font/radius tokens are theme-independent by design.
    const themeIndependent = /^--(font|radius)-/;
    // Fully derived: each is color-mix() of two other tokens with no literal of
    // its own, so it rethemes through --fg and needs no dark counterpart.
    //
    // Listed by name rather than sniffed for "var(", because a token can
    // reference another token AND still carry a theme-specific literal of its
    // own — a shadow built as `rgba(var(--shade-rgb), 0.05)` needs a dark
    // override for the alpha, and a blanket var() exclusion would quietly stop
    // requiring it.
    const derived = new Set([
      "--accent-text",
      "--success-text",
      "--warning-text",
      "--danger-text",
      "--info-text",
      "--claude-text",
    ]);
    const lightNames = declarations(rootBlock)
      .map((declaration) => declaration.split(":")[0] ?? "")
      .filter((name) => !themeIndependent.test(name) && !derived.has(name));
    const darkNames = new Set(
      declarations(darkAttrBlock).map((declaration) => declaration.split(":")[0]),
    );
    // Brand colours are intentionally identical across themes.
    const brandLocked = new Set([
      "--dosu",
      "--dosu-mid",
      "--dosu-strong",
      "--claude",
      "--claude-strong",
    ]);
    for (const name of lightNames) {
      if (brandLocked.has(name)) {
        continue;
      }
      expect(darkNames).toContain(name);
    }
  });

  test("chart tokens match what chartColors() actually reads", () => {
    // If someone adds a tenth read in main.tsx, this list — and the two rules
    // below it — need to grow with it.
    const readNames = [...main.matchAll(/value\("(--[a-z-]+)"\)/g)].flatMap(
      (match) => match[1] ?? [],
    );
    expect(readNames.sort()).toEqual([...CHART_TOKENS].sort());
  });

  test("hover states actually differ from their rest state", () => {
    // A hover built as color-mix(--btn-ink 88%, --fg) was a literal no-op in dark,
    // where those two tokens are byte-identical, and imperceptible in light where
    // both are near-black. Hovers now point at their own token, so the pair can be
    // compared per theme.
    for (const [rest, hover] of [
      ["--btn-ink", "--btn-ink-hover"],
      ["--btn-ghost", "--btn-ghost-hover"],
    ] as const) {
      for (const block of [rootBlock, darkAttrBlock]) {
        const restValue = tokenValue(rest, block);
        const hoverValue = tokenValue(hover, block);
        expect(restValue).toBeDefined();
        expect(hoverValue).toBeDefined();
        expect(hoverValue).not.toBe(restValue);
      }
    }
    // And no hover may mix a token toward one that equals it in either theme.
    expect(styles).not.toMatch(/:hover \{\s*background: color-mix\([^)]*var\(--btn-ink\)/);
  });

  test("--fg stays a plain 6-digit hex", () => {
    // buildChartOption builds an ECharts shadow colour by string concatenation —
    // `${colors.fg}0d` — so --fg has to be hex for that to mean anything. An
    // rgba() or 8-digit value would silently produce a garbage colour.
    expect(main).toContain("colors.fg}0d");
    for (const block of [rootBlock, darkAttrBlock, darkMediaBlock]) {
      const value = tokenValue("--fg", block);
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("fill-grade colours are never used as text", () => {
    // The design's accents are tuned for chart series and badge fills. As `color:`
    // on a page surface they measure 2.1–3.8:1 against cream and miss WCAG AA, so
    // text goes through the -text variants instead. Borders, backgrounds and
    // accent-color are all still fair game for the raw token.
    for (const token of ["accent", "success", "warning", "danger", "info", "claude"]) {
      expect(styles).not.toContain(`color: var(--${token});`);
      expect(styles).toContain(`--${token}-text:`);
    }
  });

  test.each([...CHART_TOKENS])("%s stays parseable by zrender", (token) => {
    // ECharts receives these as raw strings, and zrender's parser
    // (zrender/lib/tool/color.js) understands only hex and comma-separated
    // rgb()/rgba()/hsl(). Anything else silently resolves to black or nothing,
    // which shows up as blank axes rather than an error.
    //
    // 8-digit hex is deliberately allowed: zrender handles it (color.js checks
    // `strLen === 7 || strLen === 9`), and Bun's minifier rewrites our literal
    // rgba() into it anyway, so banning it here would fail on a non-problem.
    const pattern = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gim");
    const values = [...styles.matchAll(pattern)].flatMap((match) => match[1] ?? []);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toContain("var(");
      expect(value).not.toContain("color-mix(");
      // Space/slash syntax: zrender splits on commas, so `rgb(0 0 0 / 50%)`
      // arrives as a single unparseable param and renders black.
      expect(value).not.toContain("/");
    }
  });
});
