import { BarChart, type BarSeriesOption, LineChart, type LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  type GridComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from "echarts/components";
import { type ComposeOption, type ECharts, init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

// Registering only what the analytics chart draws keeps the rest of ECharts
// out of the bundle; add a component here when buildChartOption starts using it.
use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export type AnalyticsChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | GridComponentOption | TooltipComponentOption
>;

export type { ECharts };
export { init };
