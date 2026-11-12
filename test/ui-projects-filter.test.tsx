import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSummary } from "../src/ui/types.ts";
import { filterProjects, ProjectsView } from "../src/ui/views/projects.tsx";

function project(
  overrides: Partial<ProjectSummary> & { id: number; path: string },
): ProjectSummary {
  return {
    name: null,
    sessions: 1,
    usage_sessions: 1,
    estimated_cost_usd: 0,
    last_seen_at: null,
    is_worktree: false,
    root_path: null,
    worktree_label: null,
    worktree_tool: null,
    root_source: "self",
    worktree_count: 0,
    session_tools: [],
    ...overrides,
  };
}

const api = project({ id: 1, path: "/synthetic/acme/api", session_tools: ["claude_code"] });
const web = project({ id: 2, path: "/synthetic/acme/web", session_tools: ["codex"] });
const branch = project({
  id: 3,
  path: "/synthetic/trees/api-login-fix",
  is_worktree: true,
  root_path: "/synthetic/acme/api",
  worktree_label: "login-fix",
  worktree_tool: "conductor",
  root_source: "git",
});
const all = [api, web, branch];

function ids(rows: ProjectSummary[]): number[] {
  return rows.map((row) => row.id);
}

describe("filterProjects", () => {
  test("an empty or blank query keeps every row", () => {
    expect(filterProjects(all, "")).toBe(all);
    expect(filterProjects(all, "   ")).toBe(all);
  });

  test("matches the name, the path and the root, ignoring case", () => {
    expect(ids(filterProjects(all, "WEB"))).toEqual([2]);
    expect(ids(filterProjects(all, "login"))).toEqual([3]);
    // The worktree matches through its root path as well as its own.
    expect(ids(filterProjects(all, "acme/api"))).toEqual([1, 3]);
  });

  test("matches the row kind, the worktree tool and the session tools", () => {
    expect(ids(filterProjects(all, "worktree"))).toEqual([3]);
    expect(ids(filterProjects(all, "conductor"))).toEqual([3]);
    expect(ids(filterProjects(all, "codex"))).toEqual([2]);
    // The badge reads "Copilot Chat" for vscode_copilot, so that text matches.
    const chat = project({ id: 4, path: "/synthetic/ide", session_tools: ["vscode_copilot"] });
    expect(ids(filterProjects([...all, chat], "copilot chat"))).toEqual([4]);
    expect(ids(filterProjects([...all, chat], "vscode_copilot"))).toEqual([4]);
  });

  test("every word must match, in any order and any column", () => {
    expect(ids(filterProjects(all, "api worktree"))).toEqual([3]);
    expect(ids(filterProjects(all, "claude  acme"))).toEqual([1]);
    expect(filterProjects(all, "api codex")).toEqual([]);
  });
});

describe("Projects filter control", () => {
  test("the table offers a filter once there are projects", () => {
    const html = renderToStaticMarkup(
      <ProjectsView onSync={() => {}} projects={all} syncing={false} />,
    );
    expect(html).toContain('aria-label="Filter projects"');
    // Nothing is typed yet, so every row shows and the count stays silent.
    expect(html.match(/<tr>/g)).toHaveLength(all.length + 1);
    expect(html).toContain('<span role="status"></span>');
  });

  test("an archive with no projects shows the sync prompt and no filter", () => {
    const html = renderToStaticMarkup(
      <ProjectsView onSync={() => {}} projects={[]} syncing={false} />,
    );
    expect(html).toContain("No projects");
    expect(html).not.toContain('aria-label="Filter projects"');
  });
});
