import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextWindowTimeline } from "../src/context-window.ts";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import {
  renderChartSvg,
  renderContextWindowChart,
  renderSessionsByDayChart,
  reportContextWindowGeometry,
  sanitizeReportSvg,
} from "../src/report/charts.ts";
import {
  type AnalyticsReportData,
  assembleAnalyticsReport,
  assembleSessionReport,
  type SessionReportData,
} from "../src/report/data.ts";
import { renderAnalyticsReport, renderSessionReport } from "../src/report/render.tsx";
import { REPORT_CSS } from "../src/report/styles.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { contextCurveTopology } from "../src/ui/context-window-layout.ts";

const totals = {
  sessions: 2,
  messages: 14,
  tool_calls: 8,
  input_tokens: 24_000,
  output_tokens: 4_200,
  cache_read_tokens: 12_000,
  cache_creation_tokens: 7_000,
  reasoning_tokens: 0,
  est_reasoning_tokens: 500,
  estimated_cost_usd: 1.24,
};

const economics = {
  buckets: [
    {
      bucket: "context" as const,
      generation_tokens: 100,
      context_window_tokens: 300,
      estimated_cost_usd: 0.1,
      tool_calls: 2,
      sessions: 1,
      cost_share: 1,
      active_ms: 15_000,
    },
  ],
  totals: {
    generation_tokens: 100,
    context_window_tokens: 300,
    estimated_cost_usd: 0.1,
    input_cost_usd: 0.08,
    output_cost_usd: 0.02,
    active_ms: 15_000,
    waiting_on_user_ms: 0,
    attributed_ms: 15_000,
  },
};

const firstDay = {
  key: "2026-07-27",
  sessions: 1,
  input_tokens: 10_000,
  output_tokens: 2_000,
  reasoning_tokens: 0,
  est_reasoning_tokens: 0,
  estimated_cost_usd: 0.4,
};

const secondDay = {
  key: "2026-07-28",
  sessions: 1,
  input_tokens: 14_000,
  output_tokens: 2_200,
  reasoning_tokens: 0,
  est_reasoning_tokens: 500,
  estimated_cost_usd: 0.84,
};

const daily = [firstDay, secondDay];

const analytics: AnalyticsReportData = {
  kind: "analytics",
  range: { from: "2026-07-27", to: "2026-07-28" },
  totals,
  sessionsByDay: daily,
  byModel: [{ ...firstDay, key: "claude-opus-4-6", sessions: 2 }],
  byProject: [{ ...secondDay, key: "/Users/dev/decant", sessions: 2 }],
  activity: {
    by_hour: Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 2 : 0)),
    by_weekday: [0, 0, 2, 0, 0, 0, 0],
    timezone: "America/Los_Angeles",
    peak_hour: 10,
    peak_weekday: 2,
  },
  economics,
  insights: [
    {
      key: "signal:test",
      kind: "signal",
      category: "Tools",
      title: "Reduce repeated searches",
      detail: "The same paths were searched repeatedly.",
      suggestion: "Promote the stable answer to project guidance.",
      prompt: null,
      url: null,
      link_label: null,
      icon: null,
      tone: "warning",
      impact_label: "12 repeated calls",
      score: 10,
      status: "open",
      status_source: null,
      note: null,
      first_seen_at: "2026-07-28T00:00:00Z",
      updated_at: "2026-07-28T00:00:00Z",
      implemented_at: null,
      memory_layer: null,
      promotion_target: null,
      trigger: null,
      evidence: null,
      action: null,
      success_metric: null,
    },
  ],
};

const session: SessionReportData = {
  kind: "session",
  summary: {
    id: 1,
    tool: "claude_code",
    source_session_id: "synthetic",
    title: "Fix <unsafe> auth behavior",
    project_path: "/Users/dev/decant",
    model: "claude-opus-4-6",
    reasoning_effort: "high",
    reasoning_effort_levels: ["high"],
    started_at: "2026-07-28T10:00:00Z",
    ended_at: "2026-07-28T10:05:00Z",
    message_count: 6,
    total_input_tokens: 2_000,
    total_output_tokens: 500,
    estimated_cost_usd: 0.15,
    user_state: null,
    is_user_archived: false,
    is_archived: false,
    is_subagent: false,
    parent_session_id: null,
    spawn_tool_use_id: null,
    agent_id: null,
    agent_type: null,
    spawn_depth: null,
    context_window_tokens: 200_000,
    peak_context_tokens: 30_000,
    compaction_count: 0,
    subagent_count: 0,
    subagent_estimated_cost_usd: 0,
    ingest_issue_count: 0,
    informational_ingest_issue_count: 0,
    dosu_mcp_direct_calls: 1,
    dosu_mcp_tree_calls: 1,
  },
  replyCount: 2,
  toolCallCount: 2,
  durationSeconds: 300,
  facets: {
    turn_count: 2,
    error_count: 0,
    interruption_count: 0,
    compaction_count: 0,
    sidechain_message_count: 0,
    agent_spawn_count: 0,
    skill_count: 0,
    command_count: 1,
    thinking_block_count: 0,
    thinking_chars: 0,
    active_seconds: 300,
    outcome: "completed",
    work_type: "implementation",
  },
  contextWindow: {
    session_id: 1,
    tool: "claude_code",
    window_tokens: 200_000,
    window_inferred: true,
    peak_tokens: 30_000,
    peak_pct: 0.15,
    turn_count: 2,
    points: [
      {
        seq: 1,
        timestamp: "2026-07-28T10:00:30Z",
        turn: 1,
        context_tokens: 20_000,
        input_tokens: 200,
        cache_read_tokens: 18_000,
        cache_creation_tokens: 1_800,
        output_tokens: 300,
      },
      {
        seq: 3,
        timestamp: "2026-07-28T10:03:00Z",
        turn: 2,
        context_tokens: 30_000,
        input_tokens: 300,
        cache_read_tokens: 28_000,
        cache_creation_tokens: 1_700,
        output_tokens: 200,
      },
    ],
    compactions: [],
  },
  economics,
  tools: [
    {
      toolName: "Read",
      toolKind: "builtin",
      mcpServer: null,
      calls: 2,
      errors: 0,
      p50Ms: 18,
      p95Ms: 24,
    },
  ],
  hotFiles: [
    {
      key: "src/report/render.tsx",
      project: "/Users/dev/decant",
      reads: 1,
      edits: 1,
      writes: 0,
      deletes: 0,
      sessions: 1,
      last_touched_at: "2026-07-28T10:04:00Z",
    },
  ],
};

function expectSelfContained(html: string): void {
  expect(html).toStartWith("<!doctype html>");
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/<(?:img|source|link)\b[^>]+(?:src|href)=["']https?:/i);
  expect(html).not.toMatch(/url\(["']?https?:/i);
  expect(html).toContain("<style>");
  expect(html).toContain('font-family: "IBM Plex Sans"');
  expect(html).toContain("data:font/woff2;base64,");
}

describe("report charts", () => {
  test("ECharts SSR returns a non-empty standalone SVG using the bundled report sans stack", () => {
    const svg = renderChartSvg({
      xAxis: { type: "category", data: ["one"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: [1] }],
    });
    expect(svg).toMatch(/^<svg\b/);
    expect(svg.length).toBeGreaterThan(200);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<style");
    expect(svg).toContain("IBM Plex Sans");
    expect(renderSessionsByDayChart(daily)).toContain("<svg");
  });

  test("removes safe ECharts style blocks without joining surrounding markup", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[.chart{}]]></style><rect width="1" height="1"/></svg>';
    const sanitized = sanitizeReportSvg(svg);
    expect(sanitized).not.toContain("<style");
    expect(sanitized).toHaveLength(svg.length);
    expect(sanitized).toContain('<rect width="1" height="1"/>');
  });

  test("ECharts SSR escapes dynamic labels before reports embed its SVG", () => {
    const svg = renderSessionsByDayChart([
      {
        ...firstDay,
        key: "</text><script>globalThis.pwned = true</script><text>",
      },
    ]);
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;");
  });

  test("rejects active attribute injection in chart options", () => {
    expect(() =>
      renderChartSvg({
        xAxis: { type: "category", data: ["one"] },
        yAxis: { type: "value" },
        series: [
          {
            type: "bar",
            data: [1],
            itemStyle: { color: '#fff" onload="alert(1)' },
          },
        ],
      }),
    ).toThrow(/event-handler attribute/);
  });

  test("rejects injected style tags and external CSS references", () => {
    expect(() =>
      renderChartSvg({
        xAxis: { type: "category", data: ["one"] },
        yAxis: { type: "value" },
        series: [
          {
            type: "bar",
            data: [1],
            itemStyle: {
              color: '#fff"><style>@import url(https://example.com/leak);</style><rect fill="#fff',
            },
          },
        ],
      }),
    ).toThrow(/style markup|unsupported <style>/);
  });

  test("uses the live context strip's call slots, curve breaks, and compaction positions", () => {
    const sourceTimeline = session.contextWindow;
    expect(sourceTimeline).not.toBeNull();
    if (sourceTimeline == null) {
      throw new Error("session fixture must include context-window telemetry");
    }
    const firstPoint = sourceTimeline.points[0];
    const secondPoint = sourceTimeline.points[1];
    if (firstPoint == null || secondPoint == null) {
      throw new Error("session fixture must include at least two context-window points");
    }
    const timeline: ContextWindowTimeline = {
      ...sourceTimeline,
      points: [
        { ...firstPoint, seq: 1, turn: 1 },
        { ...firstPoint, seq: 2, turn: 1, context_tokens: 25_000 },
        { ...secondPoint, seq: 4, turn: 2 },
      ],
      compactions: [
        {
          seq: 3,
          timestamp: "2026-07-28T10:01:30Z",
          trigger: "auto",
          pre_tokens: 25_000,
          post_tokens: 5_000,
        },
      ],
    };
    const shared = contextCurveTopology(timeline.points, timeline.compactions);
    const report = reportContextWindowGeometry(timeline, 760);

    expect(report.pointXs).toEqual(shared.xs);
    expect(report.compactionXs).toEqual(shared.markerXs);
    expect(report.turnOrder).toEqual(shared.turnOrder);
    expect(report.segments).toHaveLength(shared.segmentIndexes.length);
    const svg = renderContextWindowChart(timeline);
    expect(svg).toContain("<svg");
    expect(svg).toContain("compaction");
    expect(svg).not.toContain("NaN");
  });

  test("report narrative and notices name the bundled font families and licenses", () => {
    expect(REPORT_CSS).toMatch(/\.lede\s*\{[^}]*font-family:\s*var\(--serif\)/s);
    const notice = readFileSync(join(import.meta.dir, "..", "NOTICE"), "utf8");
    expect(notice).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
    expect(notice).toContain("Copyright 2014 - 2023 Adobe");
    expect(notice).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});

describe("static report rendering", () => {
  test("analytics export is self-contained and always carries quiet attribution", () => {
    const html = renderAnalyticsReport(analytics, {
      generatedAt: new Date("2026-07-28T12:00:00Z"),
      version: "v1.2.3",
    });
    expectSelfContained(html);
    expect(html).toContain("<title>Agent activity report · Decant</title>");
    expect(html).toContain("Generated by Decant v1.2.3 · 2026-07-28");
    expect(html).toContain('aria-label="Optimized with Dosu"');
    expect(html).toContain(">Optimized</span>");
    expect(html).not.toContain("Optimized by Dosu");
    expect(html).toContain("utm_content=report_footer");
    expect(html).toContain("Dosu keeps agent context fresh automatically");
    expect(html).toContain("utm_content=report_cta");
    expect(html).toContain("<svg");
    expect(html).toContain('width="380" height="220"');
    expect(html).not.toContain("data-report-chart");
  });

  test("omits archive-wide insights from date-filtered reports", () => {
    const html = renderAnalyticsReport(analytics);
    expect(html).toContain(
      "Insights are omitted from date-filtered reports because signals use archive-wide evidence.",
    );
    expect(html).not.toContain("Reduce repeated searches");
    expect(html).not.toContain("The same paths were searched repeatedly.");

    const allTimeHtml = renderAnalyticsReport({
      ...analytics,
      range: { from: null, to: null },
    });
    expect(allTimeHtml).toContain("Reduce repeated searches");
    expect(allTimeHtml).toContain("The same paths were searched repeatedly.");
  });

  test("session reports always render the CTA alongside attribution", () => {
    const html = renderSessionReport(session, {
      generatedAt: new Date("2026-07-28T12:00:00Z"),
      version: "dev",
    });
    expectSelfContained(html);
    expect(html).toContain("<title>Session report · Decant</title>");
    expect(html).toContain("Generated by Decant dev · 2026-07-28");
    expect(html).toContain('aria-label="Optimized with Dosu"');
    expect(html).toContain("Dosu keeps agent context fresh automatically");
    expect(html).toContain("utm_content=report_cta");
    expect(html).toContain("<h1>Session report</h1>");
    expect(html).toContain(
      '<p class="report-subject"><span>Session prompt</span>Fix &lt;unsafe&gt; auth behavior</p>',
    );
    expect(html).toContain("Transcript content beyond the prompt preview is not included.");
    expect(html.indexOf("<h2>Token economics</h2>")).toBeLessThan(
      html.indexOf("<h2>Context window</h2>"),
    );
    expect(html).toContain("<svg");
  });

  test("keeps analytics token economics near the top of the report", () => {
    const html = renderAnalyticsReport(analytics);
    expect(html.indexOf("<h2>Working rhythm</h2>")).toBeLessThan(
      html.indexOf("<h2>Token economics</h2>"),
    );
    expect(html.indexOf("<h2>Token economics</h2>")).toBeLessThan(
      html.indexOf("<h2>Activity over time</h2>"),
    );
  });
});

describe("report data assembly", () => {
  test("composes analytics and session reports from the shared read APIs", () => {
    const workDir = mkdtempSync(join(tmpdir(), "decant-report-test-"));
    const db = openDb(join(workDir, "report.db"));
    try {
      const fixture = readFileSync(
        join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
        "utf8",
      );
      const id = upsertSession(
        db,
        parseClaudeSession("report-session", fixture),
        "/synthetic/report.jsonl",
        1,
        2,
        "report",
      );
      const insertTool = db.prepare(
        `INSERT INTO tool_call(
           session_id, tool_kind, tool_name, is_error, has_result, duration_ms, ordinal
         ) VALUES (?1, 'builtin', 'Perf', ?2, 1, ?3, ?4)`,
      );
      try {
        for (let ordinal = 1; ordinal <= 250; ordinal += 1) {
          insertTool.run(id, Number(ordinal % 10 === 0), ordinal, 1_000 + ordinal);
        }
      } finally {
        insertTool.finalize();
      }
      db.query(
        `INSERT INTO recommendation(key, kind, title, detail, score, status)
         VALUES ('signal:report-scope', 'signal', 'Archive-wide signal',
                 'Evidence from the full archive.', 100, 'open')`,
      ).run();

      const analyticsData = assembleAnalyticsReport(db);
      const filteredAnalyticsData = assembleAnalyticsReport(db, {
        filter: { from: "1900-01-01", to: "2100-01-01" },
      });
      const sessionData = assembleSessionReport(db, id);
      expect(analyticsData.kind).toBe("analytics");
      expect(analyticsData.totals.sessions).toBe(1);
      expect(analyticsData.sessionsByDay.length).toBeGreaterThan(0);
      expect(analyticsData.insights.map((insight) => insight.key)).toContain("signal:report-scope");
      expect(filteredAnalyticsData.insights).toEqual([]);
      expect(sessionData?.kind).toBe("session");
      expect(sessionData?.summary.id).toBe(id);
      expect(sessionData?.toolCallCount).toBeGreaterThan(0);
      expect(sessionData?.tools.find((tool) => tool.toolName === "Perf")).toEqual({
        toolName: "Perf",
        toolKind: "builtin",
        mcpServer: null,
        calls: 250,
        errors: 25,
        p50Ms: 125,
        p95Ms: 238,
      });
      expect(assembleSessionReport(db, 999_999)).toBeNull();
    } finally {
      db.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
