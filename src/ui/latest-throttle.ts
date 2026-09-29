export interface LatestThrottle<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

export interface ThrottleClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const browserClock: ThrottleClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Delivers the first value immediately, then at most one value per interval,
 * always ending on the most recent one so the final state is never dropped.
 * `cancel` discards a pending value so a stale update cannot land after the
 * caller has moved on; `flush` delivers it now.
 */
export function createLatestThrottle<T>(
  deliver: (value: T) => void,
  intervalMs: number,
  clock: ThrottleClock = browserClock,
): LatestThrottle<T> {
  let lastDelivery = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    if (pending == null) {
      return;
    }
    const { value } = pending;
    pending = null;
    lastDelivery = clock.now();
    deliver(value);
  };

  return {
    push(value) {
      const elapsed = clock.now() - lastDelivery;
      if (timer == null && elapsed >= intervalMs) {
        lastDelivery = clock.now();
        deliver(value);
        return;
      }
      pending = { value };
      if (timer == null) {
        timer = clock.setTimer(flush, Math.max(0, intervalMs - elapsed));
      }
    },
    flush() {
      if (timer != null) {
        clock.clearTimer(timer);
      }
      flush();
    },
    cancel() {
      if (timer != null) {
        clock.clearTimer(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
