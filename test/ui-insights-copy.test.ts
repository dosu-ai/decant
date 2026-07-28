import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

describe("Insights information hierarchy", () => {
  test("explains how archive evidence becomes future-agent improvements", () => {
    expect(main).toContain("Archive → action");
    expect(main).toContain("Decant finds recurring patterns in your local sessions");
    expect(main).toContain("Detected in your archive");
    expect(main).toContain("Patterns worth acting on");
    expect(main).toContain("Reusable improvements");
    expect(main).toContain("Set up for future runs");
  });

  test("keeps the Dosu suggestion explicitly optional", () => {
    expect(main).toContain("Optional · Dosu");
  });
});
