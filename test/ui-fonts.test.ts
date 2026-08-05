import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

/** Each UI @font-face src, resolved to a repo path. Bun's CSS bundler inlines
 * these as data URIs at build time, so a missing file is a build failure rather
 * than a 404 — but only if the path stays resolvable, which is what this pins. */
function fontFaceSources(): string[] {
  return [...styles.matchAll(/src: url\("([^"]+\.woff2)"\)/g)].flatMap((match) => match[1] ?? []);
}

test("UI fonts are bundled from the repo, never fetched remotely", () => {
  // Invariant 3: this app makes no outbound requests. A webfont is the easiest
  // way to break that by accident.
  expect(styles).not.toMatch(/@import|fonts\.googleapis|fonts\.gstatic|use\.typekit/);
  expect(styles).not.toMatch(/src: url\("https?:/);

  const sources = fontFaceSources();
  expect(sources).toHaveLength(2);
  for (const source of sources) {
    expect(existsSync(join(root, "src", "ui", source))).toBe(true);
  }
});

test("bundled faces are declared at the weight they actually ship", () => {
  // Only the Semibold serif is in the repo. Declaring it as 400 would make
  // browsers synthesize a bold on top of an already-semibold face.
  expect(styles).toMatch(
    /@font-face \{[^}]*font-family: "Source Serif 4";[^}]*font-weight: 600;[^}]*\}/,
  );
  expect(styles).toMatch(
    /@font-face \{[^}]*font-family: "IBM Plex Mono";[^}]*font-weight: 400;[^}]*\}/,
  );
});

test("the mono stack is defined once and referenced everywhere", () => {
  expect(styles).toContain("--font-mono:");
  expect(styles).toContain("--font-serif:");
  // Regression guard for two invisible failures this replaced: the stack was
  // copy-pasted into 12 rules, and a 13th site referenced an undefined
  // --font-mono and silently rendered in the sans face instead.
  expect(styles).not.toMatch(/font-family: ui-monospace/);
});
