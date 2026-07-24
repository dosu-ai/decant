import { describe, expect, test } from "bun:test";
import {
  appendTranscriptPage,
  clampTranscriptWindowOffset,
  runWithTranscriptRequestSlot,
  transcriptWindowOffset,
} from "../src/ui/transcript-pagination.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("transcript pagination", () => {
  test("appends a page in order and removes retry overlap by sequence", () => {
    const current = [
      { seq: 0, text: "first" },
      { seq: 1, text: "second" },
    ];
    const incoming = [
      { seq: 1, text: "duplicate retry" },
      { seq: 2, text: "third" },
    ];

    expect(appendTranscriptPage(current, incoming)).toEqual([
      { seq: 0, text: "first" },
      { seq: 1, text: "second" },
      { seq: 2, text: "third" },
    ]);
  });

  test("does not mutate the existing message array", () => {
    const current = [{ seq: 0 }];
    expect(appendTranscriptPage(current, [])).not.toBe(current);
    expect(current).toEqual([{ seq: 0 }]);
  });

  test("opens unloaded outline targets with bounded preceding context", () => {
    expect(transcriptWindowOffset(1_574)).toBe(1_554);
    expect(transcriptWindowOffset(8)).toBe(0);
  });

  test("serializes callers that were waiting on the same active request", async () => {
    const requestRef: { current: Promise<void> | null } = { current: null };
    const initial = deferred();
    requestRef.current = initial.promise.then(() => {
      requestRef.current = null;
    });
    const started: { label: string; resolve: () => void }[] = [];

    const startWindow = async (label: string) => {
      await runWithTranscriptRequestSlot(
        requestRef,
        () => true,
        undefined,
        async () => {
          const gate = deferred();
          started.push({ label, resolve: gate.resolve });
          await gate.promise;
        },
      );
    };

    const first = startWindow("first");
    const second = startWindow("second");
    initial.resolve();
    await nextMicrotask();
    expect(started.map((item) => item.label)).toEqual(["first"]);

    started[0]?.resolve();
    await nextMicrotask();
    expect(started.map((item) => item.label)).toEqual(["first", "second"]);

    started[1]?.resolve();
    await Promise.all([first, second]);
  });

  test("abandons a queued request when its session version becomes stale", async () => {
    const active = deferred();
    const requestRef = { current: active.promise as Promise<unknown> | null };
    let sessionVersion = 1;
    const waiting = runWithTranscriptRequestSlot(
      requestRef,
      () => sessionVersion === 1,
      "stale",
      async () => "started",
    );

    sessionVersion = 2;
    active.resolve();
    expect(await waiting).toBe("stale");
  });
});

describe("transcript window clamping", () => {
  test("keeps an out-of-range deep link on the last real page", () => {
    // A link shared from a longer archive -- /sessions/12#message-1400 where
    // this archive's session 12 holds 200 messages -- used to request offset
    // 1380, get an empty page back, and blank the transcript.
    expect(clampTranscriptWindowOffset(transcriptWindowOffset(1400), 200, 160)).toBe(40);
  });

  test("leaves in-range offsets alone", () => {
    expect(clampTranscriptWindowOffset(880, 2000, 160)).toBe(880);
    expect(clampTranscriptWindowOffset(0, 2000, 160)).toBe(0);
  });

  test("collapses to the first page when the session is shorter than one page", () => {
    expect(clampTranscriptWindowOffset(120, 40, 160)).toBe(0);
  });

  test("survives absent or nonsensical counts", () => {
    expect(clampTranscriptWindowOffset(500, 0, 160)).toBe(0);
    expect(clampTranscriptWindowOffset(500, Number.NaN, 160)).toBe(0);
    expect(clampTranscriptWindowOffset(-5, 2000, 160)).toBe(0);
  });
});
