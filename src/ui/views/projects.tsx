import { Badge, ToolBadge } from "../badges.tsx";
import { EmptyState, StatCard } from "../common.tsx";
import { relativeTime } from "../date-time.ts";
import { basename, capitalize, formatInt, money } from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link } from "../link.tsx";
import { projectSessionsHref } from "../navigation.ts";
import type { ProjectSummary } from "../types.ts";

export function ProjectsView({
  onSync,
  projects,
  syncing,
}: {
  onSync: () => void;
  projects: ProjectSummary[];
  syncing: boolean;
}) {
  const sorted = projects
    .slice()
    .sort(
      (left, right) =>
        Number(left.is_worktree) - Number(right.is_worktree) ||
        right.sessions - left.sessions ||
        right.estimated_cost_usd - left.estimated_cost_usd ||
        left.path.localeCompare(right.path),
    );
  const worktrees = projects.filter((project) => project.is_worktree);
  const activitySources = new Set(projects.flatMap((project) => project.session_tools));

  return (
    <div className="view-stack">
      <header className="page-heading">
        <h1>Projects</h1>
        <p>Project roots, worktrees, source tools, and local session activity.</p>
      </header>

      <div className="stat-grid projects-stat-grid">
        <StatCard
          icon="folder"
          label="Projects"
          value={formatInt(projects.filter((project) => !project.is_worktree).length)}
        />
        <StatCard icon="folder" label="Worktrees" value={formatInt(worktrees.length)} />
        <StatCard icon="tools" label="Activity sources" value={formatInt(activitySources.size)} />
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Projects and worktrees</h2>
            <p>Worktree source comes from Git pointers, known layouts, or root name matching.</p>
          </div>
        </div>
        {sorted.length === 0 ? (
          <EmptyState
            action={
              <button
                aria-busy={syncing}
                aria-label="Sync session logs"
                className={`primary-button sync-button${syncing ? " is-syncing" : ""}`}
                disabled={syncing}
                onClick={onSync}
                type="button"
              >
                <Icon name="refresh" />
                {syncing ? null : "Sync now"}
              </button>
            }
            icon="folder"
            message="Projects appear after sessions are synced."
            title="No projects"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table projects-table">
              <colgroup>
                <col className="col-project-path" />
                <col className="col-project-kind" />
                <col className="col-project-source" />
                <col className="col-project-root" />
                <col className="col-number" />
                <col className="col-number" />
                <col className="col-project-date" />
              </colgroup>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Root</th>
                  <th className="numeric">Sessions</th>
                  <th className="numeric">Cost</th>
                  <th className="numeric">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((project) => (
                  <tr key={project.id}>
                    <td className="truncate-cell" title={project.path}>
                      <Link className="path-stack" href={projectSessionsHref(project.path)}>
                        <strong>{projectName(project)}</strong>
                        <small>{project.path}</small>
                      </Link>
                    </td>
                    <td>
                      <ProjectKind project={project} />
                    </td>
                    <td>
                      <ProjectSource project={project} />
                    </td>
                    <td className="truncate-cell" title={project.root_path ?? project.path}>
                      {project.is_worktree ? (
                        <span className="path-stack is-compact">
                          <strong>{basename(project.root_path)}</strong>
                          <small>{project.root_path ?? "-"}</small>
                        </span>
                      ) : project.worktree_count > 0 ? (
                        <span className="worktree-count">
                          {formatInt(project.worktree_count)}{" "}
                          {project.worktree_count === 1 ? "worktree" : "worktrees"}
                        </span>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="numeric muted">{formatInt(project.sessions)}</td>
                    <td className="numeric">{money(project.estimated_cost_usd)}</td>
                    <td className="numeric muted">{relativeTime(project.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectKind({ project }: { project: ProjectSummary }) {
  if (project.is_worktree) {
    return <Badge tone="info">worktree</Badge>;
  }
  return <Badge tone="neutral">project</Badge>;
}

export function ProjectSource({ project }: { project: ProjectSummary }) {
  if (project.is_worktree) {
    return (
      <span className="source-stack">
        <Badge tone="accent">{worktreeToolLabel(project.worktree_tool)}</Badge>
        <small>{rootSourceLabel(project.root_source)}</small>
      </span>
    );
  }
  if (project.session_tools.length === 0) {
    return <span className="faint">-</span>;
  }
  return (
    <span className="source-badges">
      {project.session_tools.map((tool) => (
        <ToolBadge key={tool} tool={tool} />
      ))}
    </span>
  );
}

export function projectName(project: ProjectSummary): string {
  if (!project.is_worktree) {
    return project.name ?? basename(project.path);
  }
  const label = project.worktree_label ?? basename(project.path);
  return label === "wt" ? "worktree" : label;
}

export function worktreeToolLabel(value: string | null): string {
  switch (value) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "conductor":
      return "Conductor";
    case "git":
      return "Git";
    case "t3":
      return "T3";
    case "warp":
      return "Warp";
    case null:
      return "Worktree";
    default:
      return capitalize(value);
  }
}

export function rootSourceLabel(value: string | null): string {
  switch (value) {
    case "git":
      return "Git worktree pointer";
    case "intree":
      return "In-project worktrees folder";
    case "namematch":
      return "Matched to project root";
    case "self":
      return "Project root";
    case "synthetic":
      return "Inferred root";
    case null:
      return "Unknown source";
    default:
      return capitalize(value);
  }
}
