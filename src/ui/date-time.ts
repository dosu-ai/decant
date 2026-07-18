export interface DateTimeFormatOptions {
  locale?: string;
  now?: Date;
  timeZone?: string;
}

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
  return new Intl.DateTimeFormat(options.locale, {
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

export function fullDateTime(
  value: string | null | undefined,
  options: Omit<DateTimeFormatOptions, "now"> = {},
): string | null {
  const date = parsedDate(value);
  if (date == null) {
    return null;
  }
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone: options.timeZone,
  }).format(date);
}

function calendarYear(
  date: Date,
  locale: string | undefined,
  timeZone: string | undefined,
): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", timeZone }).format(date);
}

function parsedDate(value: string | null | undefined): Date | null {
  if (value == null || value === "") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
