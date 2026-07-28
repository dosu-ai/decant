import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");
const badge = readFileSync(join(root, "src", "ui", "dosu-badge.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const npmReadme = readFileSync(join(root, "npm", "decant", "README.md"), "utf8");

describe("Dosu product copy", () => {
  test("keeps attribution, contextual conversion, privacy, and provenance distinct", () => {
    expect(main).toContain("Built by Dosu ↗");
    expect(main).toContain("Make these patterns available to every coding agent");
    expect(main).toContain("Your archive shows the pattern.");
    expect(main).toContain("decant is an open source");
    expect(badge).toContain("Optimized by Dosu");
    expect(main).not.toContain("saved you $");
  });

  test("uses the truthful origin line in both source and launcher documentation", () => {
    const origin =
      "Built by [Dosu](https://dosu.dev) for developers who want their agents to learn";
    expect(readme).toContain(origin);
    expect(npmReadme).toContain(origin);
  });
});
