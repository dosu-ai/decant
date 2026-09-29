import { describe, expect, test } from "bun:test";
import { createLatestThrottle, type ThrottleClock } from "../src/ui/latest-throttle.ts";

function fakeClock() {
  let time = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ThrottleClock = {
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
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

describe("createLatestThrottle", () => {
  test("delivers the first value immediately", () => {
    const seen: number[] = [];
    const { clock } = fakeClock();
    createLatestThrottle((value: number) => seen.push(value), 100, clock).push(1);
    expect(seen).toEqual([1]);
  });

  test("coalesces a burst into one trailing delivery of the latest value", () => {
    const seen: number[] = [];
    const time = fakeClock();
    const throttle = createLatestThrottle((value: number) => seen.push(value), 100, time.clock);
    for (const value of [1, 2, 3, 4, 5]) {
      throttle.push(value);
      time.advance(10);
    }
    expect(seen).toEqual([1]);
    time.advance(100);
    expect(seen).toEqual([1, 5]);
  });

  test("always ends on the final value even if the stream stops mid-interval", () => {
    const seen: number[] = [];
    const time = fakeClock();
    const throttle = createLatestThrottle((value: number) => seen.push(value), 100, time.clock);
    throttle.push(1);
    time.advance(30);
    throttle.push(2);
    time.advance(500);
    expect(seen.at(-1)).toBe(2);
  });

  test("delivers immediately again once the interval has elapsed", () => {
    const seen: number[] = [];
    const time = fakeClock();
    const throttle = createLatestThrottle((value: number) => seen.push(value), 100, time.clock);
    throttle.push(1);
    time.advance(150);
    throttle.push(2);
    expect(seen).toEqual([1, 2]);
  });

  test("flush delivers the pending value now and clears its timer", () => {
    const seen: number[] = [];
    const time = fakeClock();
    const throttle = createLatestThrottle((value: number) => seen.push(value), 100, time.clock);
    throttle.push(1);
    throttle.push(2);
    throttle.flush();
    expect(seen).toEqual([1, 2]);
    expect(time.pendingTimers()).toBe(0);
    throttle.flush();
    expect(seen).toEqual([1, 2]);
  });

  test("cancel drops the pending value and its timer", () => {
    const seen: number[] = [];
    const time = fakeClock();
    const throttle = createLatestThrottle((value: number) => seen.push(value), 100, time.clock);
    throttle.push(1);
    throttle.push(2);
    expect(time.pendingTimers()).toBe(1);
    throttle.cancel();
    expect(time.pendingTimers()).toBe(0);
    time.advance(1_000);
    expect(seen).toEqual([1]);
  });
});
