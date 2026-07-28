import { describe, expect, test } from "bun:test";
import {
  hasShareCardValues,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_SCALE,
  SHARE_CARD_WIDTH,
  SHARE_EXCLUDED_FIELDS,
  SHARE_INCLUDED_FIELDS,
  shareCardAltText,
  shareCardButtonLabel,
  shareCardCaption,
  shareCardFilename,
  shareCardUrl,
} from "../src/ui/share-card.ts";

const DAILY = {
  kind: "sessions_per_day" as const,
  start: "2026-07-17",
  end: "2026-07-23",
  timezone: "America/Los_Angeles",
  labels: ["2026-07-17", "2026-07-18"],
  values: [2, 5],
};

describe("local analytics share cards", () => {
  test("requires at least one aggregate value before sharing", () => {
    expect(hasShareCardValues(null)).toBe(false);
    expect(hasShareCardValues([])).toBe(false);
    expect(hasShareCardValues([0])).toBe(true);
  });

  test("exports at 2× high density by default", () => {
    expect(SHARE_CARD_SCALE).toBe(2);
    expect(SHARE_CARD_WIDTH * SHARE_CARD_SCALE).toBe(2400);
    expect(SHARE_CARD_HEIGHT * SHARE_CARD_SCALE).toBe(1260);
  });

  test("builds deterministic copy, filenames, and placement-specific UTM links", () => {
    expect(shareCardFilename(DAILY.kind, DAILY.start, DAILY.end)).toBe(
      "decant-sessions-per-day-2026-07-17-2026-07-23.png",
    );
    expect(shareCardButtonLabel(DAILY.kind)).toBe("Share Sessions per day");
    expect(shareCardUrl(DAILY.kind)).toBe(
      "https://dosu.dev/for-agents?utm_source=decant&utm_medium=social_share&utm_campaign=analytics_cards&utm_content=sessions_per_day",
    );
    expect(shareCardCaption(DAILY)).toContain("7 coding-agent sessions");
    expect(shareCardCaption(DAILY)).toContain(shareCardUrl(DAILY.kind));
    expect(shareCardAltText(DAILY)).toContain("peaking at 5 on 2026-07-18");
  });

  test("keeps the privacy contract explicit and excludes identifying fields", () => {
    expect(SHARE_INCLUDED_FIELDS).toEqual([
      "Selected date range",
      "Timezone",
      "Aggregate counts or estimated values",
      "Aggregate chart values",
    ]);
    expect(SHARE_EXCLUDED_FIELDS).toContain("Project or repository names");
    expect(SHARE_EXCLUDED_FIELDS).toContain("Prompts");
    expect(SHARE_EXCLUDED_FIELDS).toContain("MCP inputs or outputs");
    expect(SHARE_EXCLUDED_FIELDS).toContain("Usernames");
  });
});
