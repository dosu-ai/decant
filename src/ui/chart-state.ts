export type AnalyticsChartMetric = "int" | "money";
export type AnalyticsChartVariant = "bar" | "line";

export type AnalyticsChartState = {
  key: string;
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
};

export function prepareAnalyticsChartState({
  labels,
  metric,
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
}): AnalyticsChartState {
  const cleanValues = labels.map((_, index) => Math.max(0, values[index] ?? 0));
  return {
    key: JSON.stringify([metric, variant, labels, cleanValues]),
    labels,
    metric,
    values: cleanValues,
    variant,
  };
}
