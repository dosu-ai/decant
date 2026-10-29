import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import { sync } from "../src/ingest.ts";
import { listProjects } from "../src/query.ts";
import { byDimension } from "../src/stats.ts";
import { CostValue } from "../src/ui/common.tsx";
import { emptyData } from "../src/ui/data-slices.ts";
import { ALL_DATE_RANGE } from "../src/ui/date-range.ts";
import { costDisplay, NO_USAGE_TITLE } from "../src/ui/format.ts";
import type { DimensionRow, ProjectSummary } from "../src/ui/types.ts";
import { AnalyticsView, DailyPanel } from "../src/ui/views/analytics.tsx";
import { ProjectsView } from "../src/ui/views/projects.tsx";
import { buildCursorChat } from "./cursor-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "decant-cursor-cost-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A Cursor chat (no usage) beside a Codex session (usage as session totals). */
function mixedArchive(): string {
  const dir = mkdtempSync(join(root, "case-"));
  const cursorDir = join(dir, "cursor");
  buildCursorChat(join(cursorDir, "workspace", "chat"));
  const codexSessions = join(dir, "codex", "sessions");
  mkdirSync(codexSessions, { recursive: true });
  writeFileSync(
    join(codexSessions, "rollout-sample.jsonl"),
    readFileSync(join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl")),
  );
  const dbPath = join(dir, "archive.db");
  const db = openDb(dbPath);
  try {
    sync(db, { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), cursorDir });
  } finally {
    closeDb(db);
  }
  return dbPath;
}

function dimRow(overrides: Partial<DimensionRow>): DimensionRow {
  return {
    key: "2026-10-01",
    sessions: 1,
    usage_sessions: 1,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    est_reasoning_tokens: 0,
    estimated_cost_usd: 0,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: 1,
    path: "/synthetic/project",
    name: "project",
    sessions: 1,
    usage_sessions: 1,
    estimated_cost_usd: 0,
    last_seen_at: null,
    is_worktree: false,
    root_path: null,
    worktree_label: null,
    worktree_tool: null,
    root_source: null,
    worktree_count: 0,
    session_tools: [],
    ...overrides,
  };
}

describe("cost for sessions without recorded usage", () => {
  test("stats rows and project rollups count the sessions with usage", () => {
    const db = openDb(mixedArchive());
    try {
      const usage = (rows: { key: string; sessions: number; usage_sessions: number }[]) =>
        Object.fromEntries(rows.map((row) => [row.key, [row.sessions, row.usage_sessions]]));
      expect(usage(byDimension(db, "tool"))).toEqual({ codex: [1, 1], cursor: [1, 0] });
      expect(usage(byDimension(db, "model"))["cursor-test-model"]).toEqual([1, 0]);
      expect(usage(byDimension(db, "project"))["/Users/dev/cursor-demo"]).toEqual([1, 0]);
      expect(usage(byDimension(db, "day"))["2025-07-14"]).toEqual([1, 0]);
      const cursorProject = listProjects(db).find((row) => row.path === "/Users/dev/cursor-demo");
      expect(cursorProject).toMatchObject({ sessions: 1, usage_sessions: 0 });
    } finally {
      closeDb(db);
    }
  });

  test("a total is unavailable with no usage and marked when some is missing", () => {
    expect(costDisplay(0, 2, 0)).toEqual({ text: "Unavailable", title: NO_USAGE_TITLE });
    expect(costDisplay(0, 2, 0, true).text).toBe("-");
    expect(costDisplay(1.5, 3, 2)).toEqual({
      text: "$1.50*",
      title: `1 session lacks usage data and is not in this cost. ${NO_USAGE_TITLE}`,
    });
    expect(costDisplay(1.5, 3, 3)).toEqual({ text: "$1.50", title: undefined });
    // An empty scope is a real zero.
    expect(costDisplay(0, 0, 0)).toEqual({ text: "$0.00", title: undefined });
    expect(
      renderToStaticMarkup(<CostValue cost={0} dense sessions={1} usageSessions={0} />),
    ).toContain(`title="${NO_USAGE_TITLE}"`);
  });

  test("the Projects table shows unavailable and partial costs", () => {
    const html = renderToStaticMarkup(
      <ProjectsView
        onSync={() => {}}
        projects={[
          project({ id: 1, path: "/synthetic/cursor-only", sessions: 2, usage_sessions: 0 }),
          project({
            id: 2,
            path: "/synthetic/mixed",
            sessions: 3,
            usage_sessions: 1,
            estimated_cost_usd: 0.25,
          }),
        ]}
        syncing={false}
      />,
    );
    expect(html).not.toContain("$0.00");
    expect(html).toContain(`<span class="faint" title="${NO_USAGE_TITLE}">-</span>`);
    expect(html).toContain("$0.25*");
    expect(html).toContain("2 sessions lack usage data and are not in this cost.");
  });

  test("By model and By project rows show unavailable usage as a dash", () => {
    const html = renderToStaticMarkup(
      <AnalyticsView
        data={{
          ...emptyData,
          dateBounds: { min: "2026-10-01", max: "2026-10-01" },
          byModel: [dimRow({ key: "cursor-only-model", usage_sessions: 0, input_tokens: 0 })],
          byProject: [
            dimRow({
              key: "/synthetic/mixed",
              sessions: 2,
              usage_sessions: 1,
              estimated_cost_usd: 0.5,
            }),
          ],
        }}
        dateRange={ALL_DATE_RANGE}
        onDateRangeChange={() => {}}
        onSync={() => {}}
        syncing={false}
      />,
    );
    const modelRow = html.slice(html.indexOf("cursor-only-model"));
    expect(modelRow.slice(0, modelRow.indexOf("</tr>"))).not.toMatch(/Unavailable|\$0\.00|>0</);
    expect(html.match(new RegExp(`title="${NO_USAGE_TITLE}">-<`, "g"))).toHaveLength(3);
    expect(html).toContain("$0.50*");
  });

  test("the cost-per-day chart leaves out days without usage data", () => {
    const render = (rows: DimensionRow[]) =>
      renderToStaticMarkup(
        <DailyPanel
          metric="cost"
          onShowAllTime={() => {}}
          rows={rows}
          timezone="UTC"
          title="Cost per day"
        />,
      );
    const unavailable = render([dimRow({ usage_sessions: 0 })]);
    expect(unavailable).toContain("Cost unavailable");
    const mixed = render([
      dimRow({ key: "2026-10-01", usage_sessions: 0 }),
      dimRow({ key: "2026-10-02", sessions: 2, usage_sessions: 1, estimated_cost_usd: 1 }),
    ]);
    expect(mixed).toContain("Leaves out 2 sessions without usage data.");
    expect(mixed).not.toContain("Cost unavailable");
  });

  test("decant tokens prints no cost when nothing in scope records usage", async () => {
    const dir = mkdtempSync(join(root, "tokens-"));
    const cursorDir = join(dir, "cursor");
    buildCursorChat(join(cursorDir, "workspace", "chat"));
    const dbPath = join(dir, "archive.db");
    const db = openDb(dbPath);
    try {
      sync(db, { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), cursorDir });
    } finally {
      closeDb(db);
    }
    const result = await runCli(["--db", dbPath, "--no-sync", "tokens"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("note: cost unavailable; no session in scope records token usage\n");
    const rows = result.stdout.trim().split("\n");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.split("\t")[3]).toBe("-");
    }

    const mixed = await runCli(["--db", mixedArchive(), "--no-sync", "tokens"]);
    expect(mixed.stderr).toBe("note: cost leaves out 1 session(s) without token usage\n");
    expect(mixed.stdout).toMatch(/\t\d+\.\d{4}\t/);
  });
});
