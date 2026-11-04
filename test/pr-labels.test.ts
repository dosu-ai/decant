import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
}

interface Labels {
  SIZE_LABELS: { name: string; description: string }[];
  areaLabels(files: PrFile[]): { name: string }[];
  effectiveLines(files: PrFile[]): number;
  sizeLabel(files: PrFile[]): { name: string };
}

const labels = createRequire(import.meta.url)("../.github/scripts/pr-labels.cjs") as Labels;

const file = (filename: string, additions: number, deletions = 0): PrFile => ({
  filename,
  additions,
  deletions,
});

describe("PR size label", () => {
  test("leaves tests, fixtures, and the lockfile out of a mixed pull request", () => {
    const files = [
      file("src/cost.ts", 20, 5),
      file("test/cost.test.ts", 400),
      file("fixtures/claude/x.jsonl", 90),
      file("bun.lock", 300),
    ];
    expect(labels.effectiveLines(files)).toBe(25);
    expect(labels.sizeLabel(files).name).toBe("size:S");
  });

  test("counts everything when a pull request only touches tests", () => {
    expect(labels.sizeLabel([file("test/a.test.ts", 120)]).name).toBe("size:L");
  });

  test("covers every boundary", () => {
    const at = (lines: number) => labels.sizeLabel([file("src/x.ts", lines)]).name;
    expect([0, 9, 10, 29, 30, 99, 100, 499, 500, 999, 1000, 50_000].map(at)).toEqual([
      "size:XS",
      "size:XS",
      "size:S",
      "size:S",
      "size:M",
      "size:M",
      "size:L",
      "size:L",
      "size:XL",
      "size:XL",
      "size:XXL",
      "size:XXL",
    ]);
  });

  test("keeps label descriptions within GitHub's 100-character limit", () => {
    for (const label of labels.SIZE_LABELS) {
      expect(label.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("PR area labels", () => {
  test("maps paths to areas", () => {
    const names = (paths: string[]) =>
      labels.areaLabels(paths.map((path) => file(path, 1))).map((area) => area.name);
    expect(names(["src/sources/cursor.ts", "fixtures/cursor/sample/meta.json"])).toEqual([
      "area: sources",
    ]);
    expect(names(["src/server.ts", "src/server/routes.ts", "docs/api/openapi.yaml"])).toEqual([
      "area: api",
    ]);
    expect(names(["src/cli.ts", "src/cli/commands/doctor.ts", "src/doctor.ts"])).toEqual([
      "area: cli",
    ]);
    expect(names(["src/db.ts", "src/cost.ts", ".github/workflows/ci.yml"])).toEqual([
      "area: cost",
      "area: schema",
      "area: ci",
    ]);
    expect(names(["src/server-utils.ts", "README.md"])).toEqual([]);
  });
});
