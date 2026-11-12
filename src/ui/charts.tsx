import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isolatedPoints } from "../day-series.ts";
import type * as ChartRuntime from "./chart-runtime.ts";
import type { AnalyticsChartOption, ECharts as EChartsInstance } from "./chart-runtime.ts";
import {
  type AnalyticsChartMetric,
  type AnalyticsChartPeriod,
  type AnalyticsChartState,
  type AnalyticsChartVariant,
  prepareAnalyticsChartState,
} from "./chart-state.ts";
import { compactAxis, formatInt, money } from "./format.ts";

export const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const NO_VALUES: number[] = [];

/**
 * The chart runtime is its own file in a release build. Resolves to null when
 * it cannot be fetched, as when Decant was updated or stopped under an open tab.
 */
export async function loadChartRuntime(
  load: () => Promise<typeof ChartRuntime> = () => import("./chart-runtime.ts"),
): Promise<typeof ChartRuntime | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

export function ChartUnavailable() {
  return (
    <div className="error-state" role="status">
      <span aria-hidden="true">!</span>
      <div>
        <h3>This chart could not load</h3>
        <p>Decant may have been updated or stopped since this page opened.</p>
        <div className="state-actions">
          <button
            className="secondary-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload Decant
          </button>
        </div>
      </div>
    </div>
  );
}

export const AnalyticsChart = memo(function AnalyticsChart({
  description,
  labels,
  metric,
  period = "category",
  values,
  variant,
}: {
  /** What the chart shows, read out by screen readers in place of the canvas. */
  description: string;
  labels: string[];
  metric: AnalyticsChartMetric;
  period?: AnalyticsChartPeriod;
  values: readonly (number | null)[];
  variant: AnalyticsChartVariant;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<EChartsInstance | null>(null);
  const lastDrawnKeyRef = useRef<string | null>(null);
  const chartState = useMemo(
    () => prepareAnalyticsChartState({ labels, metric, period, values, variant }),
    [labels, metric, period, values, variant],
  );
  const chartStateRef = useRef<AnalyticsChartState>(chartState);
  chartStateRef.current = chartState;
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = chartRef.current;
    if (element == null) {
      return;
    }
    let cancelled = false;
    let disposeChart: (() => void) | null = null;
    void (async () => {
      const echarts = await loadChartRuntime();
      if (cancelled) {
        return;
      }
      if (echarts == null) {
        setUnavailable(true);
        return;
      }
      const chart = echarts.init(element, null, { renderer: "canvas" });
      chartInstanceRef.current = chart;
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const draw = (force = false) => {
        const current = chartStateRef.current;
        if (!force && lastDrawnKeyRef.current === current.key) {
          return;
        }
        chart.setOption(buildChartOption(current), true);
        lastDrawnKeyRef.current = current.key;
        chart.resize();
      };
      const resize = () => chart.resize();
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      window.addEventListener("resize", resize);
      const redrawForTheme = () => draw(true);
      window.addEventListener("decant:set-theme", redrawForTheme);
      media.addEventListener("change", redrawForTheme);
      // Draws whatever chartStateRef holds now, so a state change that arrived
      // while the import was in flight is not lost.
      draw();
      disposeChart = () => {
        observer.disconnect();
        window.removeEventListener("resize", resize);
        window.removeEventListener("decant:set-theme", redrawForTheme);
        media.removeEventListener("change", redrawForTheme);
        chart.dispose();
        chartInstanceRef.current = null;
        lastDrawnKeyRef.current = null;
      };
    })();
    return () => {
      cancelled = true;
      disposeChart?.();
    };
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    const current = chartStateRef.current;
    if (chart == null || lastDrawnKeyRef.current === chartState.key) {
      return;
    }
    chart.setOption(buildChartOption(current), true);
    lastDrawnKeyRef.current = chartState.key;
    chart.resize();
  }, [chartState.key]);

  if (unavailable) {
    return <ChartUnavailable />;
  }
  return <div aria-label={description} className="analytics-chart" ref={chartRef} role="img" />;
});

export type ChartColors = ReturnType<typeof chartColors>;

export function buildChartOption(
  {
    labels,
    metric,
    period,
    values,
    variant,
  }: Pick<AnalyticsChartState, "labels" | "metric" | "period" | "values" | "variant">,
  colors: ChartColors = chartColors(),
): AnalyticsChartOption {
  const moneyMetric = metric === "money";
  const seriesType = variant;
  const isolated = isolatedPoints(values);
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  return {
    color:
      seriesType === "bar"
        ? [colors.success, colors.info, colors.warning, colors.accent]
        : [colors.accent, colors.info, colors.success, colors.warning],
    textStyle: { fontFamily: "inherit", color: colors.muted },
    animation: !reduceMotion,
    animationDuration: 180,
    grid: { left: 6, right: 16, top: 18, bottom: 6, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: colors.fg, fontSize: 12 },
      axisPointer: {
        type: seriesType === "bar" ? "shadow" : "line",
        lineStyle: { color: colors.faint, width: 1 },
        shadowStyle: { color: colors.hover },
      },
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params];
        const heading = tooltipHeading(String(items[0]?.name ?? ""), period);
        const rows = items.map(
          (item) =>
            `${typeof item.marker === "string" ? item.marker : ""}${escapeHtml(
              tooltipValue(item.value, moneyMetric),
            )}`,
        );
        return [escapeHtml(heading), ...rows].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: seriesType !== "line",
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.faint,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: string) => chartLabel(value),
      },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: colors.faint,
        fontSize: 11,
        formatter: (value: number) => chartValue(value, metric),
      },
      splitLine: { lineStyle: { color: colors.line, type: "dashed" } },
    },
    series: [
      {
        name: moneyMetric ? "cost" : "sessions",
        type: seriesType,
        // A line leaves gaps unconnected, so a known point between two gaps
        // has no segment and needs a marker to show at all.
        data:
          seriesType === "line"
            ? values.map((value, index) => ({
                value,
                symbol: isolated[index] === true ? "circle" : "none",
              }))
            : values,
        // Smoothing invents values between points; idle days are real zeros.
        smooth: false,
        connectNulls: false,
        showSymbol: seriesType === "line",
        symbolSize: 6,
        barMaxWidth: 26,
        itemStyle: { borderRadius: seriesType === "bar" ? [3, 3, 0, 0] : 0 },
        lineStyle: { width: 2 },
        areaStyle: seriesType === "line" ? { opacity: 0.1 } : undefined,
      },
    ],
  };
}

const utcDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** Tooltip heading for one category: a UTC day, the week it starts, or the label. */
export function tooltipHeading(label: string, period: AnalyticsChartPeriod): string {
  if (period === "category" || !/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    return label;
  }
  const date = new Date(`${label}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return label;
  }
  const day = utcDayFormatter.format(date);
  return period === "week" ? `Week of ${day} (UTC)` : `${day} (UTC)`;
}

/** A null point is unknown (no usage data), which is not the same as zero. */
export function tooltipValue(value: unknown, moneyMetric: boolean): string {
  if (value == null || value === "-" || (typeof value === "number" && Number.isNaN(value))) {
    return "No usage data";
  }
  return moneyMetric ? money(Number(value)) : formatInt(Number(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    fg: value("--fg"),
    hover: styles.colorScheme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(20, 20, 20, 0.05)",
    muted: value("--muted"),
    faint: value("--faint"),
    line: value("--line"),
    surface: value("--surface"),
    accent: value("--accent"),
    info: value("--info"),
    success: value("--success"),
    warning: value("--warning"),
  };
}

export function hourLabel(hour: number): string {
  if (hour === 0) {
    return "12a";
  }
  if (hour === 12) {
    return "12p";
  }
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export function weekdayLabel(day: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] ?? String(day);
}

export function peakIndex(values: number[]): number | null {
  const max = Math.max(0, ...values);
  return max > 0 ? values.indexOf(max) : null;
}

export function chartLabel(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(5, 10) : value;
}

export function chartValue(value: number, metric: AnalyticsChartMetric): string {
  const formatted = compactAxis(value);
  return metric === "money" ? `$${formatted}` : formatted;
}
