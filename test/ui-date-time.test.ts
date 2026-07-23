import { describe, expect, test } from "bun:test";
import { compactDateTime, fullDateTime } from "../src/ui/date-time.ts";

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
