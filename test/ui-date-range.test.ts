import { describe, expect, test } from "bun:test";
import {
  applyDatePreset,
  checkCustomRange,
  datePopoverAlign,
  dateRangePresetLabel,
  dateRangeQuery,
  formatDateLabel,
  msUntilNextUtcDay,
  RANGE_PRESETS,
  refreshTodayRange,
  scheduleUtcDayRollover,
  type WallClock,
  withDateQuery,
} from "../src/ui/date-range.ts";
import { focusLeftMenu } from "../src/ui/date-range-control.tsx";
import type { DateRangeSelection } from "../src/ui/types.ts";

function fakeWallClock(start: string) {
  let time = Date.parse(start);
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: WallClock = {
    now: () => time,
    setTimer: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: time + delayMs, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    pendingTimers: () => timers.size,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end);
        const first = due.sort(([, a], [, b]) => a.at - b.at)[0];
        if (first == null) {
          break;
        }
        timers.delete(first[0]);
        time = first[1].at;
        first[1].callback();
      }
      time = end;
    },
  };
}

describe("dashboard date ranges", () => {
  test("offers the supported relative ranges in display order", () => {
    expect(RANGE_PRESETS).toEqual([
      { key: "today", label: "Today", days: 1 },
      { key: "7d", label: "Last 7 days", days: 7 },
      { key: "30d", label: "Last 30 days", days: 30 },
      { key: "90d", label: "Last 90 days", days: 90 },
    ]);
  });

  test("scopes Today to the current calendar date", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(applyDatePreset("today", { min: "2026-01-01", max: "2026-08-26" })).toEqual({
      preset: "today",
      from: today,
      to: today,
    });
  });

  test("anchors relative presets to the newest archived session date", () => {
    expect(applyDatePreset("7d", { min: "2026-01-01", max: "2026-08-26" })).toEqual({
      preset: "7d",
      from: "2026-08-20",
      to: "2026-08-26",
    });
  });

  test("passes arbitrary custom bounds through to API requests", () => {
    const query = dateRangeQuery({ preset: "custom", from: "2026-04-03", to: "2026-05-17" });
    expect(query).toBe("from=2026-04-03&to=2026-05-17");
    expect(withDateQuery("/api/stats/summary", query)).toBe(
      "/api/stats/summary?from=2026-04-03&to=2026-05-17",
    );
  });

  test("keeps the compact control label independent from exact custom dates", () => {
    expect(dateRangePresetLabel({ preset: "all", from: null, to: null })).toBe("All time");
    expect(dateRangePresetLabel({ preset: "custom", from: "2026-04-03", to: "2026-05-17" })).toBe(
      "Custom range",
    );
    expect(dateRangePresetLabel(applyDatePreset("30d", { min: null, max: "2026-08-26" }))).toBe(
      "Last 30 days",
    );
  });

  test("opens the popover toward whichever side has room for it", () => {
    // Trigger against the right gutter of a 1200px page: open leftward.
    expect(datePopoverAlign(1181, 304)).toBe("end");
    // Heading wrapped the trigger to the left edge (Files at 1024px): open rightward.
    expect(datePopoverAlign(179, 304)).toBe("start");
    expect(datePopoverAlign(304, 304)).toBe("end");
  });

  test("formats ISO calendar dates without shifting them to the local timezone", () => {
    expect(formatDateLabel("2026-08-27")).toMatch(/(^|\D)27(\D|$)/);
  });
});

describe("custom date range validation", () => {
  test("applies an ordered range as a custom selection", () => {
    expect(checkCustomRange("2026-10-01", "2026-10-23")).toEqual({
      status: "valid",
      range: { preset: "custom", from: "2026-10-01", to: "2026-10-23" },
    });
    expect(checkCustomRange("2026-10-23", "2026-10-23")).toEqual({
      status: "valid",
      range: { preset: "custom", from: "2026-10-23", to: "2026-10-23" },
    });
  });

  test("treats a cleared field as an open-ended bound", () => {
    expect(checkCustomRange("", "2026-10-23")).toEqual({
      status: "valid",
      range: { preset: "custom", from: null, to: "2026-10-23" },
    });
    expect(checkCustomRange("2026-10-01", "")).toEqual({
      status: "valid",
      range: { preset: "custom", from: "2026-10-01", to: null },
    });
  });

  test("rejects a To date before the From date in either order of editing", () => {
    expect(checkCustomRange("2026-10-23", "2026-10-01")).toEqual({ status: "reversed" });
    expect(checkCustomRange("2026-11-15", "2026-10-28")).toEqual({ status: "reversed" });
  });

  test("ignores the partial years Chrome emits while a year is typed", () => {
    for (const partial of ["0002-10-01", "0020-10-01", "0202-10-01"]) {
      expect(checkCustomRange("2026-10-23", partial)).toEqual({
        status: "incomplete",
        field: "to",
      });
      expect(checkCustomRange(partial, "2026-10-23")).toEqual({
        status: "incomplete",
        field: "from",
      });
    }
  });

  test("ignores dates the browser reports as partly typed or impossible", () => {
    expect(checkCustomRange(null, "2026-10-23")).toEqual({ status: "incomplete", field: "from" });
    expect(checkCustomRange("2026-10-01", null)).toEqual({ status: "incomplete", field: "to" });
    expect(checkCustomRange("2026-02-30", "")).toEqual({ status: "incomplete", field: "from" });
  });
});

describe("date-range menu focus", () => {
  const inside = { nodeType: 1 };
  const outside = { nodeType: 1 };
  const menu = { contains: (node: unknown) => node === inside };

  test("stays open when a label click or Safari press blurs with no new focus target", () => {
    expect(focusLeftMenu(menu as unknown as Node, null)).toBe(false);
  });

  test("stays open while focus moves between its own controls", () => {
    expect(focusLeftMenu(menu as unknown as Node, inside as unknown as EventTarget)).toBe(false);
  });

  test("closes once focus lands outside the menu", () => {
    expect(focusLeftMenu(menu as unknown as Node, outside as unknown as EventTarget)).toBe(true);
  });
});

describe("Today across UTC midnight", () => {
  const today = (date: string): DateRangeSelection => ({ preset: "today", from: date, to: date });

  test("counts down to the next UTC midnight", () => {
    expect(msUntilNextUtcDay(Date.parse("2026-10-29T23:59:00.000Z"))).toBe(60_000);
    expect(msUntilNextUtcDay(Date.parse("2026-10-30T00:00:00.000Z"))).toBe(86_400_000);
  });

  test("moves a Today selection onto the new date and leaves other ranges alone", () => {
    const now = Date.parse("2026-10-30T00:00:01.000Z");
    expect(refreshTodayRange(today("2026-10-29"), now)).toEqual(today("2026-10-30"));
    const current = today("2026-10-30");
    expect(refreshTodayRange(current, now)).toBe(current);
    const week: DateRangeSelection = { preset: "7d", from: "2026-10-23", to: "2026-10-29" };
    expect(refreshTodayRange(week, now)).toBe(week);
  });

  test("re-runs at each UTC midnight with one pending timer until stopped", () => {
    const fake = fakeWallClock("2026-10-29T23:58:00.000Z");
    let range = today("2026-10-29");
    const stop = scheduleUtcDayRollover(() => {
      range = refreshTodayRange(range, fake.clock.now());
    }, fake.clock);
    expect(fake.pendingTimers()).toBe(1);

    fake.advance(60_000);
    expect(range).toEqual(today("2026-10-29"));
    fake.advance(60_000);
    expect(range).toEqual(today("2026-10-30"));
    expect(fake.pendingTimers()).toBe(1);
    fake.advance(86_400_000);
    expect(range).toEqual(today("2026-10-31"));

    stop();
    expect(fake.pendingTimers()).toBe(0);
    fake.advance(86_400_000);
    expect(range).toEqual(today("2026-10-31"));
  });

  test("a timer that fires early re-arms for the real boundary", () => {
    const fake = fakeWallClock("2026-10-29T23:59:00.000Z");
    let runs = 0;
    let firedEarly = false;
    // Only the first timer fires 5ms early, as a clock adjustment might cause.
    const early: WallClock = {
      ...fake.clock,
      setTimer: (callback, delayMs) => {
        const delay = firedEarly ? delayMs : delayMs - 5;
        firedEarly = true;
        return fake.clock.setTimer(callback, delay);
      },
    };
    let range = today("2026-10-29");
    scheduleUtcDayRollover(() => {
      runs += 1;
      range = refreshTodayRange(range, early.now());
    }, early);
    fake.advance(59_995);
    expect(runs).toBe(1);
    expect(range).toEqual(today("2026-10-29"));
    fake.advance(5);
    expect(runs).toBe(2);
    expect(range).toEqual(today("2026-10-30"));
  });
});
