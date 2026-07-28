export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;
export const SHARE_CARD_SCALE = 2;

export const SHARE_INCLUDED_FIELDS = [
  "Selected date range",
  "Timezone",
  "Aggregate counts or estimated values",
  "Aggregate chart values",
] as const;

export const SHARE_EXCLUDED_FIELDS = [
  "Project or repository names",
  "Paths",
  "Session titles",
  "Prompts",
  "MCP inputs or outputs",
  "Model IDs",
  "Usernames",
] as const;

export type ShareCardKind =
  | "busiest_days"
  | "busiest_hours"
  | "estimated_cost_per_day"
  | "sessions_per_day";

export interface ShareCardCopyInput {
  end: string;
  kind: ShareCardKind;
  labels: string[];
  start: string;
  timezone: string;
  values: number[];
}

export function hasShareCardValues(
  values: readonly number[] | null | undefined,
): values is readonly number[] {
  return (values?.length ?? 0) > 0;
}

const TITLES: Record<ShareCardKind, string> = {
  busiest_days: "Busiest days",
  busiest_hours: "Busiest hours",
  estimated_cost_per_day: "Estimated cost per day",
  sessions_per_day: "Sessions per day",
};

const QUALIFIERS: Record<ShareCardKind, string> = {
  busiest_days: "Aggregate only · local session logs",
  busiest_hours: "Timezone included · aggregate only",
  estimated_cost_per_day: "Estimate · model pricing at ingest",
  sessions_per_day: "Aggregate only · local session logs",
};

export function shareCardTitle(kind: ShareCardKind): string {
  return TITLES[kind];
}

export function shareCardButtonLabel(kind: ShareCardKind): string {
  return `Share ${shareCardTitle(kind)}`;
}

export function shareCardQualifier(kind: ShareCardKind): string {
  return QUALIFIERS[kind];
}

export function shareCardUrl(kind: ShareCardKind): string {
  const params = new URLSearchParams({
    utm_source: "decant",
    utm_medium: "social_share",
    utm_campaign: "analytics_cards",
    utm_content: kind,
  });
  return `https://dosu.dev/for-agents?${params.toString()}`;
}

export function shareCardFilename(kind: ShareCardKind, start: string, end: string): string {
  return `decant-${kind.replaceAll("_", "-")}-${safeDate(start)}-${safeDate(end)}.png`;
}

export function shareCardTakeaway(input: ShareCardCopyInput): string {
  const { kind, labels, values } = input;
  const total = values.reduce((sum, value) => sum + value, 0);
  const peakIndex = maxIndex(values);
  const peakLabel = peakIndex == null ? null : (labels[peakIndex] ?? null);
  switch (kind) {
    case "sessions_per_day":
      return `${formatInteger(total)} coding-agent ${total === 1 ? "session" : "sessions"} in the selected range`;
    case "estimated_cost_per_day":
      return `${formatMoney(total)} estimated across the selected range`;
    case "busiest_hours":
      return peakLabel == null
        ? "No hourly activity in the selected range"
        : `Peak agent activity lands around ${peakLabel}`;
    case "busiest_days":
      return peakLabel == null
        ? "No weekday activity in the selected range"
        : `${peakLabel} carries the most agent-assisted work`;
  }
}

export function shareCardCaption(input: ShareCardCopyInput): string {
  const takeaway = shareCardTakeaway(input);
  const link = shareCardUrl(input.kind);
  return input.kind === "sessions_per_day"
    ? `${takeaway}. Decant shows the pattern. Dosu can help the next agent use it. ${link}`
    : `${takeaway}. Shared from Decant. ${link}`;
}

export function shareCardAltText(input: ShareCardCopyInput): string {
  const { end, kind, labels, start, timezone, values } = input;
  const peak = maxIndex(values);
  const low = minIndex(values);
  const peakLabel = peak == null ? "no date" : (labels[peak] ?? "an unknown date");
  const peakValue = peak == null ? 0 : (values[peak] ?? 0);
  switch (kind) {
    case "sessions_per_day":
      return `Decant analytics bar chart of daily sessions from ${start} to ${end}, peaking at ${formatInteger(peakValue)} on ${peakLabel}.`;
    case "estimated_cost_per_day":
      return `Decant analytics line chart of estimated daily model cost from ${start} to ${end}; selected-range total is ${formatMoney(values.reduce((sum, value) => sum + value, 0))}.`;
    case "busiest_hours":
      return `Decant analytics hourly activity chart in ${timezone}, with the highest activity at ${peakLabel}.`;
    case "busiest_days":
      return `Decant analytics weekday activity chart, highest on ${peakLabel} and lowest on ${low == null ? "no day" : (labels[low] ?? "an unknown day")}.`;
  }
}

function safeDate(value: string): string {
  return value.replaceAll(/[^0-9a-z]+/gi, "-").replaceAll(/^-|-$/g, "") || "all";
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function maxIndex(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce(
    (best, value, index) => (value > (values[best] ?? Number.NEGATIVE_INFINITY) ? index : best),
    0,
  );
}

function minIndex(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce(
    (best, value, index) => (value < (values[best] ?? Number.POSITIVE_INFINITY) ? index : best),
    0,
  );
}
