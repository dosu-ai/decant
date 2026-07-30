import { describe, expect, test } from "bun:test";
import {
  scopedSessionSummaryKey,
  sessionCardMetrics,
  sessionSummaryPath,
} from "../src/ui/session-summary.ts";

describe("session summary cards", () => {
  const archiveSummary = {
    sessions: 12,
    messages: 50,
    estimated_cost_usd: 9.5,
  };
  const visibleRows = [
    { message_count: 4, estimated_cost_usd: 0.75 },
    { message_count: 7, estimated_cost_usd: 1.25 },
  ];

  test("uses the server summary until a client text filter is active", () => {
    expect(sessionCardMetrics(archiveSummary, visibleRows, "  ")).toEqual(archiveSummary);
  });

  test("derives cards from visible rows for a client text filter", () => {
    expect(sessionCardMetrics(archiveSummary, visibleRows, "codex")).toEqual({
      sessions: 2,
      messages: 11,
      estimated_cost_usd: 2,
    });
  });

  test("falls back to loaded rows when a scoped summary request is unavailable", () => {
    expect(sessionCardMetrics(null, visibleRows, "")).toEqual({
      sessions: 2,
      messages: 11,
      estimated_cost_usd: 2,
    });
  });

  test("uses root messages but recursive displayed cost when a query matched a child", () => {
    const matchingRoots = [
      {
        message_count: 4,
        estimated_cost_usd: 1,
        subagent_estimated_cost_usd: 99,
        subagents: [
          {
            message_count: 7,
            estimated_cost_usd: 0.5,
            subagent_estimated_cost_usd: 0.25,
          },
        ],
      },
    ];

    expect(sessionCardMetrics(archiveSummary, matchingRoots, "child title")).toEqual({
      sessions: 1,
      messages: 4,
      estimated_cost_usd: 1.75,
    });
  });

  test("builds a project-scoped summary request without dropping the date range", () => {
    expect(sessionSummaryPath("/Users/dev/a repo", "from=2026-05-01&to=2026-05-31")).toBe(
      "/api/stats/summary?from=2026-05-01&to=2026-05-31&project=%2FUsers%2Fdev%2Fa+repo",
    );
    expect(sessionSummaryPath(null, "from=2026-05-01")).toBe("/api/stats/summary?from=2026-05-01");
    expect(sessionSummaryPath(null, "from=2026-05-01", true)).toBe(
      "/api/stats/summary?from=2026-05-01&include_archived=true",
    );
  });

  test("keys a scoped summary by its archive reload generation", () => {
    const request = sessionSummaryPath("/Users/dev/a repo", "from=2026-05-01", true);

    expect(scopedSessionSummaryKey(request, 3)).toBe(scopedSessionSummaryKey(request, 3));
    expect(scopedSessionSummaryKey(request, 4)).not.toBe(scopedSessionSummaryKey(request, 3));
  });
});
