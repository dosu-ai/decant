import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const formatModule = resolve(import.meta.dir, "../src/ui/format.ts");

// The day formatter resolves its time zone when the module loads, so the zone
// has to be set before import. A child process gives the module a clean load.
function formatDayIn(timeZone: string, value: string): { actual: string; expected: string } {
  const script = `
    const { formatDay } = await import(${JSON.stringify(formatModule)});
    const local = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" });
    console.log(JSON.stringify({
      actual: formatDay(${JSON.stringify(value)}),
      expected: local.format(new Date(2026, 9, 12)),
    }));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TZ: timeZone },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return JSON.parse(result.stdout.toString());
}

describe("formatDay", () => {
  test("keeps a bare calendar day on that day west of UTC", () => {
    const { actual, expected } = formatDayIn("America/Los_Angeles", "2026-10-12");
    expect(actual).toBe(expected);
  });

  test("keeps a bare calendar day on that day east of UTC", () => {
    const { actual, expected } = formatDayIn("Pacific/Kiritimati", "2026-10-12");
    expect(actual).toBe(expected);
  });

  test("still converts a full timestamp to the local day", () => {
    // 07:26 UTC on Oct 12 is 00:26 on Oct 12 in Los Angeles.
    const { actual, expected } = formatDayIn("America/Los_Angeles", "2026-10-12T07:26:00Z");
    expect(actual).toBe(expected);
  });
});
