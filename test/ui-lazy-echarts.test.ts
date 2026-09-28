import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readUiSource, sourceFrom } from "./ui-source.ts";

const uiDir = join(import.meta.dir, "..", "src", "ui");
const main = readUiSource(["chart-runtime.ts"]);

test("ECharts is only ever reached through the lazy chart runtime", () => {
  // Bun's compiled binary does not split chunks, so laziness only defers module
  // initialisation; what shrinks the download is registering just the parts of
  // ECharts the analytics chart draws with, in one module.
  expect(main).not.toMatch(/^import \* as echarts/m);
  expect(main).not.toMatch(/^import echarts/m);
  expect(main).not.toMatch(/from "echarts/);
  expect(main).toMatch(/^import type \{[^}]*\} from "\.\/chart-runtime\.ts";/m);

  const dynamicImports = main.match(/await import\("\.\/chart-runtime\.ts"\)/g) ?? [];
  expect(dynamicImports).toHaveLength(2);
  expect(main).not.toMatch(/import\("echarts/);
});

test("the chart runtime imports only the modular ECharts entry points", () => {
  const runtime = readFileSync(join(uiDir, "chart-runtime.ts"), "utf8");
  const specifiers = [...runtime.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  expect(specifiers.sort()).toEqual([
    "echarts/charts",
    "echarts/components",
    "echarts/core",
    "echarts/features",
    "echarts/renderers",
  ]);
  const registered = /use\(\[([^\]]+)\]\)/.exec(runtime)?.[1]?.match(/\b[A-Z]\w+/g) ?? [];
  expect(registered.sort()).toEqual([
    "BarChart",
    "CanvasRenderer",
    "GridComponent",
    "LegacyGridContainLabel",
    "LineChart",
    "TooltipComponent",
  ]);
});

test("no UI module pulls in the whole ECharts bundle", () => {
  const wholeLibrary = /from "echarts"|import\("echarts"\)|require\("echarts"\)/;
  const offenders = readdirSync(uiDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => wholeLibrary.test(readFileSync(join(uiDir, file), "utf8")));
  expect(offenders).toEqual([]);
});

test("the chart effect survives unmounting mid-import", () => {
  // useEffect has to return its cleanup synchronously, but the chart does not
  // exist until the import settles. If the component unmounts in that window the
  // cleanup must still prevent an orphaned chart holding a canvas and listeners.
  const effect = sourceFrom(main, "function AnalyticsChart");
  expect(effect).toContain("let cancelled = false;");
  expect(effect).toContain("let disposeChart: (() => void) | null = null;");
  // Bails before init when we already unmounted...
  expect(effect).toMatch(
    /const echarts = await import\("\.\/chart-runtime\.ts"\);\s*if \(cancelled\) \{/,
  );
  // ...and otherwise runs the teardown the async body published.
  expect(effect).toMatch(/cancelled = true;\s*disposeChart\?\.\(\);/);
});
