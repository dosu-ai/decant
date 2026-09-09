import { describe, expect, test } from "bun:test";
import {
  compactDateTime,
  fullDateTime,
  relativeTime,
  sessionListDate,
} from "../src/ui/date-time.ts";

const UTC_OPTIONS = {
  locale: "en-US",
  now: new Date("2026-07-18T12:00:00Z"),
  timeZone: "UTC",
};

describe("compactDateTime", () => {
  test("shows a compact date and time without the current year", () => {
    expect(compactDateTime("2026-07-17T23:28:00Z", UTC_OPTIONS)).toBe("7/17 11:28 PM");
  });

  test("includes a two-digit year for older timestamps", () => {
    expect(compactDateTime("2025-07-17T23:28:00Z", UTC_OPTIONS)).toBe("7/17/25 11:28 PM");
  });

  test("returns null for missing or invalid timestamps", () => {
    expect(compactDateTime(null, UTC_OPTIONS)).toBeNull();
    expect(compactDateTime("not-a-date", UTC_OPTIONS)).toBeNull();
  });
});

describe("fullDateTime", () => {
  test("provides a detailed timestamp for the tooltip", () => {
    const formatted = fullDateTime("2026-07-17T23:28:00Z", {
      locale: "en-US",
      timeZone: "UTC",
    });
    expect(formatted).toContain("Jul 17, 2026");
    expect(formatted).toContain("11:28:00 PM");
    expect(formatted).toEndWith("UTC");
  });
});

describe("relativeTime", () => {
  test("preserves the existing long-form relative copy", () => {
    expect(relativeTime("2026-07-18T10:00:00Z", UTC_OPTIONS)).toBe("2 hours ago");
    expect(relativeTime("2026-07-15T12:00:00Z", UTC_OPTIONS)).toBe("3 days ago");
    expect(relativeTime("2026-07-18T14:00:00Z", UTC_OPTIONS)).toBe("in 2 hours");
  });

  test("preserves missing and invalid timestamp behavior", () => {
    expect(relativeTime(null, UTC_OPTIONS)).toBe("-");
    expect(relativeTime("not-a-date", UTC_OPTIONS)).toBe("not-a-date");
  });
});

describe("sessionListDate", () => {
  test("uses compact relative copy strictly within seven days", () => {
    expect(sessionListDate("2026-07-18T10:00:00Z", UTC_OPTIONS)).toBe("2h ago");
    expect(sessionListDate("2026-07-17T12:20:00Z", UTC_OPTIONS)).toBe("1d ago");
    expect(sessionListDate("2026-07-15T12:00:00Z", UTC_OPTIONS)).toBe("3d ago");
    expect(sessionListDate("2026-07-18T14:00:00Z", UTC_OPTIONS)).toBe("in 2h");
    expect(sessionListDate("2026-07-19T11:40:00Z", UTC_OPTIONS)).toBe("in 1d");
    expect(sessionListDate("2026-07-11T12:00:01Z", UTC_OPTIONS)).toBe("7d ago");
    expect(sessionListDate("2026-07-11T12:00:00Z", UTC_OPTIONS)).toBe("Jul 11, 12:00 PM");
  });

  test("uses the selected timezone to choose current-year and older formats", () => {
    expect(sessionListDate("2026-01-17T23:28:00Z", UTC_OPTIONS)).toBe("Jan 17, 11:28 PM");
    const boundaryNow = new Date("2027-01-01T00:30:00Z");
    const losAngeles = {
      locale: "en-US",
      now: boundaryNow,
      timeZone: "America/Los_Angeles",
    };
    const utc = { locale: "en-US", now: boundaryNow, timeZone: "UTC" };
    expect(sessionListDate("2026-07-17T23:28:00Z", losAngeles)).toBe("Jul 17, 4:28 PM");
    expect(sessionListDate("2026-07-17T23:28:00Z", utc)).toBe("Jul 17, 2026");
    expect(sessionListDate("2025-07-17T23:28:00Z", UTC_OPTIONS)).toBe("Jul 17, 2025");
  });

  test("returns null for missing or invalid timestamps", () => {
    expect(sessionListDate(null, UTC_OPTIONS)).toBeNull();
    expect(sessionListDate("not-a-date", UTC_OPTIONS)).toBeNull();
  });
});

describe("formatter reuse", () => {
  test("reuses date-time and relative-time formatters for identical options", () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const OriginalRelativeTimeFormat = Intl.RelativeTimeFormat;
    let dateTimeConstructions = 0;
    let relativeTimeConstructions = 0;
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      value: new Proxy(OriginalDateTimeFormat, {
        construct(target, args, newTarget) {
          dateTimeConstructions += 1;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    });
    Object.defineProperty(Intl, "RelativeTimeFormat", {
      configurable: true,
      value: new Proxy(OriginalRelativeTimeFormat, {
        construct(target, args, newTarget) {
          relativeTimeConstructions += 1;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    });

    const options = {
      locale: "en-US-u-ca-gregory",
      now: new Date("2026-07-18T12:00:00Z"),
      timeZone: "UTC",
    };
    try {
      expect(sessionListDate("2026-01-17T23:28:00Z", options)).toBe("Jan 17, 11:28 PM");
      expect(sessionListDate("2026-01-17T23:28:00Z", options)).toBe("Jan 17, 11:28 PM");
      expect(relativeTime("2026-07-18T10:00:00Z", options)).toBe("2 hours ago");
      expect(relativeTime("2026-07-18T10:00:00Z", options)).toBe("2 hours ago");
      expect(dateTimeConstructions).toBe(2);
      expect(relativeTimeConstructions).toBe(1);
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        value: OriginalDateTimeFormat,
      });
      Object.defineProperty(Intl, "RelativeTimeFormat", {
        configurable: true,
        value: OriginalRelativeTimeFormat,
      });
    }
  });
});
