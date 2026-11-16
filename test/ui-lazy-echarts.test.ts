import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartUnavailable, loadChartRuntime } from "../src/ui/charts.tsx";
import { readUiFile, readUiSource, sourceFrom } from "./ui-source.ts";

const uiDir = join(import.meta.dir, "..", "src", "ui");
const main = readUiSource(["chart-runtime.ts"]);

test("ECharts is only ever reached through the lazy chart runtime", () => {
  expect(main).not.toMatch(/^import \* as echarts/m);
  expect(main).not.toMatch(/^import echarts/m);
  expect(main).not.toMatch(/from "echarts/);
  expect(main).toMatch(/^import type \{[^}]*\} from "\.\/chart-runtime\.ts";/m);

  const dynamicImports = main.match(/import\("\.\/chart-runtime\.ts"\)/g) ?? [];
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
  const effect = sourceFrom(readUiFile("charts.tsx"), "function AnalyticsChart");
  expect(effect).toContain("let cancelled = false;");
  expect(effect).toContain("let disposeChart: (() => void) | null = null;");
  expect(effect).toMatch(/const echarts = await loadChartRuntime\(\);\s*if \(cancelled\) \{/);
  expect(effect).toMatch(/cancelled = true;\s*disposeChart\?\.\(\);/);
});

test("a chart runtime that cannot be fetched is reported, not thrown", async () => {
  const runtime = await loadChartRuntime();
  expect(typeof runtime?.init).toBe("function");
  const missing = await loadChartRuntime(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(missing).toBeNull();
});

test("a chart that cannot load says so and offers a reload", () => {
  const html = renderToStaticMarkup(createElement(ChartUnavailable));
  expect(html).toContain("This chart could not load");
  expect(html).toContain("Reload Decant");
  const chart = sourceFrom(readUiFile("charts.tsx"), "function AnalyticsChart");
  expect(chart).toMatch(/if \(echarts == null\) \{\s*setUnavailable\(true\);/);
  expect(chart).toMatch(/if \(unavailable\) \{\s*return <ChartUnavailable \/>;/);
});
