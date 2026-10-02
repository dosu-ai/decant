import { memo, useEffect, useMemo, useRef } from "react";
import type { AnalyticsChartOption, ECharts as EChartsInstance } from "./chart-runtime.ts";
import {
  type AnalyticsChartMetric,
  type AnalyticsChartState,
  type AnalyticsChartVariant,
  prepareAnalyticsChartState,
} from "./chart-state.ts";
import { compactAxis, formatInt, money } from "./format.ts";

export const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const NO_VALUES: number[] = [];

export const AnalyticsChart = memo(function AnalyticsChart({
  labels,
  metric,
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<EChartsInstance | null>(null);
  const lastDrawnKeyRef = useRef<string | null>(null);
  const chartState = useMemo(
    () => prepareAnalyticsChartState({ labels, metric, values, variant }),
    [labels, metric, values, variant],
  );
  const chartStateRef = useRef<AnalyticsChartState>(chartState);
  chartStateRef.current = chartState;

  useEffect(() => {
    const element = chartRef.current;
    if (element == null) {
      return;
    }
    let cancelled = false;
    let disposeChart: (() => void) | null = null;
    void (async () => {
      const echarts = await import("./chart-runtime.ts");
      if (cancelled) {
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

  return <div aria-label="Analytics chart" className="analytics-chart" ref={chartRef} role="img" />;
});

export function buildChartOption({
  labels,
  metric,
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
}): AnalyticsChartOption {
  const colors = chartColors();
  const moneyMetric = metric === "money";
  const seriesType = variant;
  return {
    color:
      seriesType === "bar"
        ? [colors.success, colors.info, colors.warning, colors.accent]
        : [colors.accent, colors.info, colors.success, colors.warning],
    textStyle: { fontFamily: "inherit", color: colors.muted },
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
      valueFormatter: (value) =>
        moneyMetric ? money(Number(value ?? 0)) : formatInt(Number(value ?? 0)),
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
        data: values,
        smooth: seriesType === "line",
        showSymbol: false,
        barMaxWidth: 26,
        itemStyle: { borderRadius: seriesType === "bar" ? [3, 3, 0, 0] : 0 },
        lineStyle: { width: 2 },
        areaStyle: seriesType === "line" ? { opacity: 0.1 } : undefined,
      },
    ],
  };
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
