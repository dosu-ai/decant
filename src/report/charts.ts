import * as echarts from "echarts";
import type { ContextWindowTimeline } from "../context-window.ts";
import type { DimRow } from "../stats.ts";
import {
  groupContextMarkers,
  layoutContextAnnotations,
  layoutContextCurve,
} from "../ui/context-window-layout.ts";

export interface ReportChartSize {
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 250;
const INK = "#24302a";
const MUTED = "#6d766f";
const RULE = "#dce1da";
const SAGE = "#778561";
const SAGE_LIGHT = "#b4bb91";
const REPORT_SANS_STACK =
  "'IBM Plex Sans', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const CONTEXT_GRID_TOP = 24;
const CONTEXT_GRID_LEFT = 62;
const CONTEXT_GRID_RIGHT = 18;
const CONTEXT_GRID_HORIZONTAL_PADDING = CONTEXT_GRID_LEFT + CONTEXT_GRID_RIGHT;
const CONTEXT_MARKER_GAP_PX = 3;
const CONTEXT_COMPACTION_LABEL_SEPARATION_PX = 100;
const CONTEXT_COMPACTION_LABEL_LANE_GAP_PX = 13;
const REPORT_SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "text",
  "tspan",
  "defs",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
]);
const SVG_STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

export interface ReportContextWindowGeometry {
  compactionXs: number[];
  pointXs: number[];
  segments: [number, number][][];
  slotWidth: number;
  turnOrder: number[];
}

export interface ReportCompactionLabel {
  align: "left" | "right";
  lane: number;
  markerIndex: number;
  offset: [number, number];
  text: string;
}

/**
 * Render an ECharts option as a standalone SVG string. ECharts' SSR mode does
 * not create a DOM and animation is forced off so exported reports contain no
 * script or animation CSS.
 */
export function renderChartSvg(option: echarts.EChartsOption, size: ReportChartSize = {}): string {
  const width = size.width ?? DEFAULT_WIDTH;
  const height = size.height ?? DEFAULT_HEIGHT;
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });
  try {
    chart.setOption({
      ...option,
      animation: false,
      backgroundColor: "transparent",
      textStyle: {
        color: INK,
        fontFamily: REPORT_SANS_STACK,
        ...(option.textStyle ?? {}),
      },
    });
    return sanitizeReportSvg(chart.renderToSVGString());
  } finally {
    chart.dispose();
  }
}

/**
 * ECharts renders a fixed, local option schema in SSR mode, but attribute values
 * are not an HTML escaping boundary. Reject active markup before an SVG reaches
 * the report's intentionally inline render path.
 */
export function sanitizeReportSvg(svg: string): string {
  const styleElements = [...svg.matchAll(SVG_STYLE_ELEMENT)];
  if (styleElements.length > 1) {
    throw new Error("report chart contains injected style markup");
  }
  const styleBody = styleElements[0]?.[1];
  if (
    styleBody != null &&
    (!/^\s*<!\[CDATA\[[\s\S]*\]\]>\s*$/.test(styleBody) ||
      /@import|url\s*\(|expression\s*\(|(?:javascript|data|https?):|\/\//i.test(styleBody))
  ) {
    throw new Error("report chart contains active style markup");
  }
  const styleElement = styleElements[0];
  const sanitized =
    styleElement?.index == null
      ? svg
      : `${svg.slice(0, styleElement.index)}${" ".repeat(styleElement[0].length)}${svg.slice(styleElement.index + styleElement[0].length)}`;
  assertSafeReportSvg(sanitized);
  return sanitized;
}

function assertSafeReportSvg(svg: string): void {
  if (!svg.startsWith("<svg")) {
    throw new Error("report chart did not render an SVG");
  }
  if (/<!doctype|<!entity|<\?xml-stylesheet/i.test(svg)) {
    throw new Error("report chart contains active markup");
  }
  for (const match of svg.matchAll(/<\/?([a-z][\w:-]*)\b/gi)) {
    const tag = match[1]?.toLowerCase();
    if (tag != null && !REPORT_SVG_TAGS.has(tag)) {
      throw new Error(`report chart contains unsupported <${tag}> markup`);
    }
  }
  if (/(?:^|[\s<])on[a-z][\w:.-]*\s*=/i.test(svg)) {
    throw new Error("report chart contains an event-handler attribute");
  }
  if (/(?:href|src)\s*=/i.test(svg)) {
    throw new Error("report chart contains an external or active URL");
  }
  const withoutInternalPaintServers = svg.replace(/url\(\s*#[-\w:.]+\s*\)/gi, "");
  if (/url\s*\(/i.test(withoutInternalPaintServers)) {
    throw new Error("report chart contains an external paint server");
  }
  for (const match of svg.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    const style = match[2] ?? "";
    if (/&|@import|expression\s*\(|(?:javascript|data|https?):|\/\//i.test(style)) {
      throw new Error("report chart contains an active style attribute");
    }
  }
}

export function renderSessionsByDayChart(rows: readonly DimRow[], size?: ReportChartSize): string {
  const ordered = [...rows].sort((left, right) => left.key.localeCompare(right.key));
  return renderChartSvg(
    {
      grid: { top: 18, right: 16, bottom: 44, left: 48 },
      xAxis: {
        type: "category",
        data: ordered.map((row) => row.key),
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
        axisLabel: { color: MUTED, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: MUTED },
        splitLine: { lineStyle: { color: RULE } },
      },
      series: [
        {
          type: "line",
          data: ordered.map((row) => row.sessions),
          symbol: "circle",
          symbolSize: 6,
          lineStyle: { color: SAGE, width: 2.5 },
          itemStyle: { color: SAGE },
          areaStyle: { color: "rgba(180, 187, 145, 0.24)" },
        },
      ],
    },
    size,
  );
}

export function renderCostByDayChart(rows: readonly DimRow[], size?: ReportChartSize): string {
  const ordered = [...rows].sort((left, right) => left.key.localeCompare(right.key));
  return renderChartSvg(
    {
      grid: { top: 18, right: 16, bottom: 44, left: 58 },
      xAxis: {
        type: "category",
        data: ordered.map((row) => row.key),
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
        axisLabel: { color: MUTED, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: MUTED,
          formatter: (value: number) => `$${value.toFixed(value < 1 ? 2 : 0)}`,
        },
        splitLine: { lineStyle: { color: RULE } },
      },
      series: [
        {
          type: "bar",
          data: ordered.map((row) => row.estimated_cost_usd),
          itemStyle: { color: SAGE_LIGHT, borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 30,
        },
      ],
    },
    size,
  );
}

export function renderContextWindowChart(
  timeline: ContextWindowTimeline,
  size: ReportChartSize = {},
): string {
  const width = size.width ?? DEFAULT_WIDTH;
  const geometry = reportContextWindowGeometry(timeline, width);
  const windowTokens = timeline.window_tokens;
  const labelList = reportCompactionLabels(geometry.compactionXs, width);
  const compactionLabels = new Map(labelList.map((label) => [label.markerIndex, label]));
  const compactionLabelLanes = labelList.reduce(
    (highestLane, label) => Math.max(highestLane, label.lane),
    0,
  );
  const compactionMarkLine =
    geometry.compactionXs.length === 0
      ? undefined
      : {
          silent: true,
          symbol: "none" as const,
          label: {
            color: MUTED,
            fontSize: 10,
            position: "end" as const,
            verticalAlign: "bottom" as const,
          },
          lineStyle: { color: MUTED, type: "dashed" as const, width: 1 },
          data: geometry.compactionXs.map((x, index) => {
            const label = compactionLabels.get(index);
            return {
              xAxis: x,
              label:
                label == null
                  ? { show: false }
                  : {
                      align: label.align,
                      formatter: label.text,
                      offset: label.offset,
                      show: true,
                    },
            };
          }),
        };
  const lineSeries = geometry.segments.map(
    (segment, index): echarts.LineSeriesOption => ({
      type: "line",
      data: segment,
      showSymbol: false,
      connectNulls: false,
      lineStyle: { color: SAGE, width: 2.5 },
      itemStyle: { color: SAGE },
      areaStyle: { color: "rgba(180, 187, 145, 0.20)" },
      ...(index === 0 && compactionMarkLine != null ? { markLine: compactionMarkLine } : {}),
    }),
  );
  const pointSeries: echarts.ScatterSeriesOption[] =
    timeline.points.length <= 18
      ? [
          {
            type: "scatter",
            data: timeline.points.map((point, index) => [
              geometry.pointXs[index] ?? 0,
              point.context_tokens,
            ]),
            symbol: "circle",
            symbolSize: 5,
            itemStyle: { color: SAGE },
            z: 3,
          },
        ]
      : [];
  return renderChartSvg(
    {
      grid: {
        top: CONTEXT_GRID_TOP + compactionLabelLanes * CONTEXT_COMPACTION_LABEL_LANE_GAP_PX,
        right: CONTEXT_GRID_RIGHT,
        bottom: 44,
        left: CONTEXT_GRID_LEFT,
      },
      xAxis: {
        type: "value",
        min: 0,
        max: 1,
        interval: geometry.slotWidth,
        axisLine: { lineStyle: { color: RULE } },
        axisTick: { show: false },
        axisLabel: {
          color: MUTED,
          hideOverlap: true,
          formatter: (value: number) => reportTurnLabel(value, geometry),
        },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: windowTokens ?? undefined,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: MUTED,
          formatter: (value: number) => compactNumber(value),
        },
        splitLine: { lineStyle: { color: RULE } },
      },
      series: [...lineSeries, ...pointSeries],
    },
    { width, height: size.height ?? 280 },
  );
}

/**
 * Nearby compaction lines share one count label. Repeating the same word above
 * every line adds no information and makes dense report charts unreadable.
 * Remaining edge collisions move into additional lanes above the plot.
 */
export function reportCompactionLabels(
  compactionXs: readonly number[],
  width = DEFAULT_WIDTH,
): ReportCompactionLabel[] {
  const plotLeft = CONTEXT_GRID_LEFT;
  const plotRight = Math.max(plotLeft, width - CONTEXT_GRID_RIGHT);
  const plotWidth = plotRight - plotLeft;
  const markerPixels = compactionXs.map((x) => plotLeft + x * plotWidth);
  const grouped = groupContextMarkers(markerPixels, CONTEXT_COMPACTION_LABEL_SEPARATION_PX).map(
    (group) => {
      const markerIndex = group.indexes.reduce((nearest, index) => {
        const nearestDistance = Math.abs((markerPixels[nearest] ?? group.x) - group.x);
        const distance = Math.abs((markerPixels[index] ?? group.x) - group.x);
        return distance < nearestDistance ? index : nearest;
      }, group.indexes[0] ?? 0);
      return {
        markerIndex,
        text: group.indexes.length === 1 ? "compaction" : `${group.indexes.length} compactions`,
        x: markerPixels[markerIndex] ?? group.x,
      };
    },
  );
  const placements = layoutContextAnnotations(grouped, {
    labelYs: grouped.map((_, lane) =>
      lane === 0 ? 0 : -lane * CONTEXT_COMPACTION_LABEL_LANE_GAP_PX,
    ),
    plotLeft,
    plotRight,
  });

  return grouped.map((group, index) => {
    const placement = placements[index];
    return {
      align: placement?.anchor === "end" ? "right" : "left",
      lane: placement?.lane ?? 0,
      markerIndex: group.markerIndex,
      offset: [placement == null ? 0 : placement.textX - group.x, placement?.textY ?? 0],
      text: group.text,
    };
  });
}

/**
 * Map the shared live-strip geometry into ECharts' normalized value-axis
 * coordinates. Keeping ECharts as the report renderer preserves its static SVG
 * typography and styling while sharing call slots, curve breaks, and exact
 * compaction positions with the interactive app.
 */
export function reportContextWindowGeometry(
  timeline: ContextWindowTimeline,
  width = DEFAULT_WIDTH,
): ReportContextWindowGeometry {
  const compactions = [...timeline.compactions].sort((left, right) => left.seq - right.seq);
  const plotWidth = Math.max(1, width - CONTEXT_GRID_HORIZONTAL_PADDING);
  const layout = layoutContextCurve(timeline.points, compactions, {
    markerGap: CONTEXT_MARKER_GAP_PX / plotWidth,
    plotLeft: 0,
    plotRight: 1,
    yAt: (tokens) => tokens,
  });
  return {
    compactionXs: layout.markerXs,
    pointXs: layout.xs,
    segments: layout.segments,
    slotWidth: layout.slotWidth,
    turnOrder: layout.turnOrder,
  };
}

function reportTurnLabel(value: number, geometry: ReportContextWindowGeometry): string {
  if (geometry.turnOrder.length === 0 || value >= 1) {
    return "";
  }
  const index = Math.min(
    geometry.turnOrder.length - 1,
    Math.max(0, Math.floor(value / Math.max(Number.EPSILON, geometry.slotWidth))),
  );
  const turn = geometry.turnOrder[index];
  return turn == null ? "" : `T${turn}`;
}

function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(0)}K`;
  }
  return String(Math.round(value));
}
