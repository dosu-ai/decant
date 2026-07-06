// Modular echarts registration: only the chart types, components, and renderer
// the UI actually uses are bundled. `TooltipComponent` installs the axis
// pointer it needs itself. Adding a new chart type or option component to the
// UI means registering it here first.
import { BarChart, type BarSeriesOption, LineChart, type LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  type GridComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export type ChartOption = echarts.ComposeOption<
  BarSeriesOption | GridComponentOption | LineSeriesOption | TooltipComponentOption
>;

export { echarts };
