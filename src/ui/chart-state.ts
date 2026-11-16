export type AnalyticsChartMetric = "int" | "money";
export type AnalyticsChartVariant = "bar" | "line";
export type AnalyticsChartPeriod = "category" | "day" | "week";

export type AnalyticsChartState = {
  key: string;
  labels: string[];
  metric: AnalyticsChartMetric;
  period: AnalyticsChartPeriod;
  values: (number | null)[];
  variant: AnalyticsChartVariant;
};

export function prepareAnalyticsChartState({
  labels,
  metric,
  period = "category",
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  period?: AnalyticsChartPeriod;
  values: readonly (number | null)[];
  variant: AnalyticsChartVariant;
}): AnalyticsChartState {
  const cleanValues = labels.map((_, index) => {
    const value = values[index];
    return value === null ? null : Math.max(0, value ?? 0);
  });
  return {
    key: JSON.stringify([metric, variant, period, labels, cleanValues]),
    labels,
    metric,
    period,
    values: cleanValues,
    variant,
  };
}
