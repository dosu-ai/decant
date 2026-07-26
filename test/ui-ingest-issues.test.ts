import { expect, test } from "bun:test";
import { formatIssueBadge } from "../src/ui/ingest-issues.ts";

test("formats the badge label", () => {
  expect(formatIssueBadge(1)).toBe("1 ingest issue");
  expect(formatIssueBadge(3)).toBe("3 ingest issues");
});
