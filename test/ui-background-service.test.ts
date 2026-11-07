import { describe, expect, test } from "bun:test";
import { backgroundNote, waitForBackgroundService } from "../src/ui/background-service.ts";
import type { BackgroundStatus } from "../src/ui/types.ts";

const base: BackgroundStatus = {
  supported: true,
  manager: "launchd",
  reason: null,
  installed: false,
  running: false,
  unitPath: null,
  command: null,
  url: null,
  current: false,
  handoff: false,
  stopping: false,
};

describe("backgroundNote", () => {
  test("explains each state in the user's terms", () => {
    expect(backgroundNote(null, "idle")).toBe("Loading...");
    expect(backgroundNote({ ...base, supported: false, reason: "No systemd." }, "idle")).toBe(
      "No systemd.",
    );
    expect(backgroundNote(base, "idle")).toContain("Off.");
    expect(backgroundNote({ ...base, installed: true, current: true }, "idle")).toContain(
      "served by the background service",
    );
    expect(
      backgroundNote(
        { ...base, installed: true, running: true, url: "http://127.0.0.1:4000" },
        "idle",
      ),
    ).toContain("http://127.0.0.1:4000");
    expect(backgroundNote({ ...base, installed: true }, "idle")).toContain("decant service status");
    expect(backgroundNote(base, "handoff")).toContain("reloads");
    expect(backgroundNote(base, "stopped")).toContain("Run decant");
  });
});

describe("waitForBackgroundService", () => {
  test("keeps polling through failed requests until the service answers", async () => {
    let calls = 0;
    const ready = await waitForBackgroundService(
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("Failed to fetch");
        return { ...base, current: calls >= 4 };
      },
      { sleep: async () => undefined, timeoutMs: 1_000 },
    );
    expect(ready).toBe(true);
    expect(calls).toBe(4);
  });

  test("gives up at the deadline", async () => {
    let clock = 0;
    const ready = await waitForBackgroundService(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      {
        timeoutMs: 2_000,
        intervalMs: 500,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    );
    expect(ready).toBe(false);
  });
});
