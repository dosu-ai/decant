import { expect, test } from "bun:test";
import { formatIssueBadge, unknownRecordTypeSummary } from "../src/ui/ingest-issues.ts";

test("formats the badge label", () => {
  expect(formatIssueBadge(1)).toBe("1 ingest issue");
  expect(formatIssueBadge(3)).toBe("3 ingest issues");
});

test("summarizes unknown source record types without repeating them", () => {
  expect(
    unknownRecordTypeSummary([
      'unknown record type "future_event" on 3 line(s); ignored',
      'unknown record type "new_metadata" on 1 line(s); kept as role "other"',
      'unknown record type "future_event" on 2 line(s); ignored',
    ]),
  ).toEqual({
    count: 3,
    types: ["future_event", "new_metadata"],
  });
});

test("keeps the diagnostic count when an older row has no quoted type", () => {
  expect(unknownRecordTypeSummary(["unknown record", 'unknown record type "known"'])).toEqual({
    count: 2,
    types: ["known"],
  });
});
