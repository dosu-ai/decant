import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

test("ECharts is only ever reached through a dynamic import", () => {
  // ECharts is ~1.1MB minified and only two call sites draw with it. Importing it
  // at the top level ran its module initialisation on every route, including the
  // six that never render a chart.
  //
  // Bun's HTMLBundle does not split chunks in a compiled binary, so this does not
  // shrink the download — the bytes still ship. What it buys is deferred
  // *execution*: Bun compiles `import("echarts")` to a lazy `__esm` factory, so
  // the library's top-level work happens on first chart render instead of on
  // every page load. Verified by inspecting a `bun build` of src/ui/index.html.
  expect(main).not.toMatch(/^import \* as echarts/m);
  expect(main).not.toMatch(/^import echarts/m);
  // The type import is fine — it erases at build time.
  expect(main).toMatch(/^import type \{[^}]*\} from "echarts";/m);

  const dynamicImports = main.match(/await import\("echarts"\)/g) ?? [];
  expect(dynamicImports).toHaveLength(2);
});

test("the chart effect survives unmounting mid-import", () => {
  // useEffect has to return its cleanup synchronously, but the chart does not
  // exist until the import settles. If the component unmounts in that window the
  // cleanup must still prevent an orphaned chart holding a canvas and listeners.
  const effect = main.slice(main.indexOf("function AnalyticsChart"));
  expect(effect).toContain("let cancelled = false;");
  expect(effect).toContain("let disposeChart: (() => void) | null = null;");
  // Bails before init when we already unmounted...
  expect(effect).toMatch(/const echarts = await import\("echarts"\);\s*if \(cancelled\) \{/);
  // ...and otherwise runs the teardown the async body published.
  expect(effect).toMatch(/cancelled = true;\s*disposeChart\?\.\(\);/);
});
