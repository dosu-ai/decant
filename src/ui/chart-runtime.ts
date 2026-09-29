import { BarChart, type BarSeriesOption, LineChart, type LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  type GridComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from "echarts/components";
import { type ComposeOption, type ECharts, init, use } from "echarts/core";
import { LegacyGridContainLabel } from "echarts/features";
import { CanvasRenderer } from "echarts/renderers";

// Registering only what the analytics chart draws keeps the rest of ECharts
// out of the bundle; add a component here when buildChartOption starts using it.
// LegacyGridContainLabel backs grid.containLabel, which ECharts 6 made opt-in.
use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer, LegacyGridContainLabel]);

export type AnalyticsChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | GridComponentOption | TooltipComponentOption
>;

export type { ECharts };
export { init };
