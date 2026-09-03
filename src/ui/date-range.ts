export type RangePreset = "today" | "7d" | "30d" | "90d" | "all" | "custom";

export type DateRangeSelection = {
  preset: RangePreset;
  from: string | null;
  to: string | null;
};

export type DateBoundsLike = {
  min: string | null;
  max: string | null;
};

export const RANGE_PRESETS = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
] as const;

export const ALL_DATE_RANGE: DateRangeSelection = { preset: "all", from: null, to: null };

export function applyDatePreset(
  key: (typeof RANGE_PRESETS)[number]["key"],
  bounds: DateBoundsLike | null,
): DateRangeSelection {
  const preset = RANGE_PRESETS.find((item) => item.key === key);
  const to = key === "today" ? todayIsoDate() : (validIsoDate(bounds?.max) ?? todayIsoDate());
  if (preset == null) {
    return ALL_DATE_RANGE;
  }
  return {
    preset: key,
    from: addDays(to, -(preset.days - 1)),
    to,
  };
}

export function dateRangeQuery(range: DateRangeSelection): string {
  const params = new URLSearchParams();
  if (range.from != null) {
    params.set("from", range.from);
  }
  if (range.to != null) {
    params.set("to", range.to);
  }
  return params.toString();
}

export function withDateQuery(path: string, dateQuery: string): string {
  if (dateQuery === "") {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${dateQuery}`;
}

export function dateRangeLabel(range: DateRangeSelection): string {
  if (range.from == null && range.to == null) {
    return "All time";
  }
  if (range.from == null) {
    return `Through ${formatDateLabel(range.to ?? "")}`;
  }
  if (range.to == null) {
    return `From ${formatDateLabel(range.from)}`;
  }
  return range.from === range.to
    ? formatDateLabel(range.from)
    : `${formatDateLabel(range.from)} to ${formatDateLabel(range.to)}`;
}

export function dateRangePresetLabel(range: DateRangeSelection): string {
  if (range.preset === "all") {
    return "All time";
  }
  if (range.preset === "custom") {
    return "Custom range";
  }
  return RANGE_PRESETS.find((preset) => preset.key === range.preset)?.label ?? "All time";
}

export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate) ?? new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function validIsoDate(value: string | null | undefined): string | null {
  if (value == null || parseIsoDate(value) == null) {
    return null;
  }
  return value;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function formatDateLabel(value: string): string {
  const date = parseIsoDate(value);
  if (date == null) {
    return value;
  }
  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
}
