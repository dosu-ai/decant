export interface DateTimeFormatOptions {
  locale?: string;
  now?: Date;
  timeZone?: string;
}

const DAY_MS = 86_400_000;
const RECENT_SESSION_MS = 7 * DAY_MS;
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormatCache = new Map<string, Intl.RelativeTimeFormat>();

export function compactDateTime(
  value: string | null | undefined,
  options: DateTimeFormatOptions = {},
): string | null {
  const date = parsedDate(value);
  if (date == null) {
    return null;
  }
  const now = options.now ?? new Date();
  const includeYear =
    calendarYear(date, options.locale, options.timeZone) !==
    calendarYear(now, options.locale, options.timeZone);
  return getDateTimeFormatter(options.locale, {
    year: includeYear ? "2-digit" : undefined,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  })
    .format(date)
    .replace(/,\s*/g, " ");
}

export function relativeTime(
  value: string | null | undefined,
  options: DateTimeFormatOptions = {},
): string {
  if (value == null || value === "") {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const deltaSeconds = Math.round(((options.now ?? new Date()).getTime() - timestamp) / 1000);
  const abs = Math.abs(deltaSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = getRelativeTimeFormatter(options.locale, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (abs >= seconds) {
      return formatter.format(Math.round(-deltaSeconds / seconds), unit);
    }
  }
  return "just now";
}

export function sessionListDate(
  value: string | null | undefined,
  options: DateTimeFormatOptions = {},
): string | null {
  const date = parsedDate(value);
  if (date == null) {
    return null;
  }
  const now = options.now ?? new Date();
  const deltaMs = now.getTime() - date.getTime();
  if (Math.abs(deltaMs) < RECENT_SESSION_MS) {
    return compactRelativeTime(deltaMs);
  }
  const includeYear =
    calendarYear(date, options.locale, options.timeZone) !==
    calendarYear(now, options.locale, options.timeZone);
  return getDateTimeFormatter(options.locale, {
    year: includeYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
    hour: includeYear ? undefined : "numeric",
    minute: includeYear ? undefined : "2-digit",
    timeZone: options.timeZone,
  })
    .format(date)
    .replace(/\s+at\s+/, ", ");
}

export function fullDateTime(
  value: string | null | undefined,
  options: Omit<DateTimeFormatOptions, "now"> = {},
): string | null {
  const date = parsedDate(value);
  if (date == null) {
    return null;
  }
  return getDateTimeFormatter(options.locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: options.timeZone,
  }).format(date);
}

function compactRelativeTime(deltaMs: number): string {
  const deltaSeconds = Math.round(deltaMs / 1000);
  const abs = Math.abs(deltaSeconds);
  const roundedHours = Math.round(abs / 3_600);
  if (abs < 86_400 && roundedHours >= 24) {
    return deltaSeconds < 0 ? "in 1d" : "1d ago";
  }
  const units: [suffix: string, seconds: number][] = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  for (const [suffix, seconds] of units) {
    if (abs >= seconds) {
      const amount = Math.round(abs / seconds);
      return deltaSeconds < 0 ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
    }
  }
  return "just now";
}

function calendarYear(
  date: Date,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  return getDateTimeFormatter(locale, { year: "numeric", timeZone }).format(date);
}

function parsedDate(value: string | null | undefined): Date | null {
  if (value == null || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDateTimeFormatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let formatter = dateTimeFormatCache.get(key);
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateTimeFormatCache.set(key, formatter);
  }
  return formatter;
}

function getRelativeTimeFormatter(
  locale: string | undefined,
  options: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let formatter = relativeTimeFormatCache.get(key);
  if (formatter == null) {
    formatter = new Intl.RelativeTimeFormat(locale, options);
    relativeTimeFormatCache.set(key, formatter);
  }
  return formatter;
}
