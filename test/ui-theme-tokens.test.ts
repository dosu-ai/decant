import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");

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
    const fromMedia = declarations(darkMediaBlock);
    const fromAttribute = declarations(darkAttrBlock);
    expect(fromMedia.length).toBeGreaterThan(10);
    expect(fromAttribute).toEqual(fromMedia);
  });

  test("dark overrides every themed token light defines", () => {
    const themeIndependent = /^--(font|radius)-/;
    const derived = new Set([
      "--accent-text",
      "--success-text",
      "--warning-text",
      "--danger-text",
      "--info-text",
      "--claude-text",
    ]);
    const pureAlias = /^var\(--[a-z0-9-]+\)$/;
    const lightNames = declarations(rootBlock)
      .filter((declaration) => !pureAlias.test(declaration.split(": ").slice(1).join(": ")))
      .map((declaration) => declaration.split(":")[0] ?? "")
      .filter((name) => !themeIndependent.test(name) && !derived.has(name));
    const darkNames = new Set(
      declarations(darkAttrBlock).map((declaration) => declaration.split(":")[0]),
    );
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
    const readNames = [...main.matchAll(/value\("(--[a-z-]+)"\)/g)].flatMap(
      (match) => match[1] ?? [],
    );
    expect(readNames.sort()).toEqual([...CHART_TOKENS].sort());
  });

  test("bar charts use a neutral hover band in both themes", () => {
    expect(main).toContain("shadowStyle: { color: colors.hover }");
    expect(main).toContain('styles.colorScheme === "dark"');
    expect(main).toContain('"rgba(255, 255, 255, 0.05)"');
    expect(main).toContain('"rgba(20, 20, 20, 0.05)"');
    expect(main).not.toContain("colors.fg}0d");
    expect(main).not.toContain('seriesType === "bar" && colors.dark');
  });

  test("hover states actually differ from their rest state", () => {
    const resolve = (name: string, block: string): string | undefined => {
      let value = tokenValue(name, block) ?? tokenValue(name, rootBlock);
      for (let hop = 0; hop < 8; hop++) {
        const target = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? "")?.[1];
        if (!target) {
          break;
        }
        const next = tokenValue(target, block) ?? tokenValue(target, rootBlock);
        if (next === undefined) {
          return `var(${target})`;
        }
        value = next;
      }
      return value;
    };
    for (const [rest, hover] of [
      ["--btn-ink", "--btn-ink-hover"],
      ["--btn-ghost", "--btn-ghost-hover"],
    ] as const) {
      for (const block of [rootBlock, darkAttrBlock]) {
        const restValue = resolve(rest, block);
        const hoverValue = resolve(hover, block);
        expect(restValue).toBeDefined();
        expect(hoverValue).toBeDefined();
        expect(hoverValue).not.toBe(restValue);
      }
    }
    expect(styles).not.toMatch(/:hover \{\s*background: color-mix\([^)]*var\(--btn-ink\)/);
  });

  test("fill-grade colours are never used as text", () => {
    for (const token of ["accent", "success", "warning", "danger", "info", "claude"]) {
      expect(styles).not.toContain(`color: var(--${token});`);
      expect(styles).toContain(`--${token}-text:`);
    }
  });

  test.each([...CHART_TOKENS])("%s stays parseable by zrender", (token) => {
    const pattern = new RegExp(`^\\s*${token}:\\s*([^;]+);`, "gim");
    const values = [...styles.matchAll(pattern)].flatMap((match) => match[1] ?? []);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toContain("var(");
      expect(value).not.toContain("color-mix(");
      expect(value).not.toContain("/");
    }
  });
});
