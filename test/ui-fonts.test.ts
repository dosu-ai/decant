import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

function fontFaceSources(): string[] {
  return [...styles.matchAll(/src: url\("([^"]+\.woff2?)"\)/g)].flatMap((match) => match[1] ?? []);
}

test("UI fonts are bundled from the repo, never fetched remotely", () => {
  expect(styles).not.toMatch(/@import|fonts\.googleapis|fonts\.gstatic|use\.typekit/);
  expect(styles).not.toMatch(/src: url\("https?:/);

  const sources = fontFaceSources();
  expect(sources).toHaveLength(3);
  for (const source of sources) {
    expect(existsSync(join(root, "src", "ui", source))).toBe(true);
  }
});

test("bundled faces are declared at the weight they actually ship", () => {
  expect(styles).toMatch(
    /@font-face \{[^}]*font-family: "Northrup Serif Large";[^}]*font-weight: 400;[^}]*\}/,
  );
  for (const weight of [400, 500]) {
    expect(styles).toMatch(
      new RegExp(
        `@font-face \\{[^}]*font-family: "Geist Mono";[^}]*font-weight: ${weight};[^}]*\\}`,
      ),
    );
  }
});

test("bundled faces include their OFL license texts", () => {
  for (const license of ["Geist-OFL.txt", "Northrup-OFL.txt"]) {
    const text = readFileSync(join(root, "src", "ui", "fonts", license), "utf8");
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }
  expect(styles).not.toMatch(/Aeonik|Mondwest/);
});

test("the mono stack is defined once and referenced everywhere", () => {
  expect(styles).toContain("--font-mono:");
  expect(styles).toContain("--font-serif:");
  expect(styles).not.toMatch(/font-family: ui-monospace/);
});
