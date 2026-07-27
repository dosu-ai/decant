import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { compareCodePoints } from "./order.ts";

export type RootSource = "self" | "git" | "intree" | "namematch" | "synthetic";

export interface Resolution {
  isWorktree: boolean;
  rootPath: string;
  worktreeLabel: string | null;
  worktreeTool: string | null;
  source: RootSource;
}

export interface KnownRoot {
  path: string;
  basename: string;
  sessions: number;
  lastSeen: string | null;
}

interface ProjectRow {
  id: number;
  path: string;
  isWorktree: number;
  rootPath: string | null;
  source: string | null;
  worktreeLabel: string | null;
  worktreeTool: string | null;
  sessions: number;
  lastSeen: string | null;
}

interface ExternalContainer {
  tool: string;
  leaf: string;
}

function segments(path: string): { absolute: boolean; parts: string[] } {
  return {
    absolute: path.startsWith("/"),
    parts: path.split("/").filter((segment) => segment !== ""),
  };
}

function joinSegments(absolute: boolean, parts: string[]): string {
  const body = parts.join("/");
  return absolute ? `/${body}` : body;
}

export function basename(path: string): string {
  return (path.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? path).toString();
}

export function classifyIntree(path: string): Resolution | null {
  const { absolute, parts } = segments(path);
  const index = parts.findIndex(
    (segment) =>
      segment === ".worktrees" || segment === ".claude-worktrees" || segment === ".codex-worktrees",
  );
  if (index === -1 || index === 0 || index + 1 >= parts.length) {
    return null;
  }
  return {
    isWorktree: true,
    rootPath: joinSegments(absolute, parts.slice(0, index)),
    worktreeLabel: parts.slice(index + 1).join("/"),
    worktreeTool:
      parts[index] === ".claude-worktrees"
        ? "claude"
        : parts[index] === ".codex-worktrees"
          ? "codex"
          : "git",
    source: "intree",
  };
}

export function externalContainer(path: string): ExternalContainer | null {
  const { parts } = segments(path);
  for (const [index, segment] of parts.entries()) {
    const tool =
      segment === ".warp-worktrees"
        ? "warp"
        : segment === ".t3-worktrees"
          ? "t3"
          : segment === ".codex-worktrees"
            ? "codex"
            : segment === "workspaces" && index > 0 && parts[index - 1] === "conductor"
              ? "conductor"
              : segment === "worktrees" && index > 0 && parts[index - 1] === ".warp"
                ? "warp"
                : segment === "worktrees" && index > 0 && parts[index - 1] === ".codex"
                  ? "codex"
                  : null;
    if (tool == null) {
      continue;
    }
    if (segment === "worktrees") {
      const repo = parts[index + 1];
      const leaf = parts[index + 2];
      return repo != null && leaf != null ? { tool, leaf: `${repo}-${leaf}` } : null;
    }
    const leaf = parts[index + 1];
    return leaf == null ? null : { tool, leaf };
  }
  return null;
}

export function classifyExternal(
  tool: string,
  leaf: string,
  path: string,
  knownRoots: readonly KnownRoot[],
): Resolution {
  const best = knownRoots
    .filter((root) => root.basename !== "")
    .filter((root) => leaf === root.basename || leaf.startsWith(`${root.basename}-`))
    .sort(compareKnownRoots)
    .at(-1);

  if (best != null) {
    return {
      isWorktree: true,
      rootPath: best.path,
      worktreeLabel: leaf.startsWith(`${best.basename}-`)
        ? leaf.slice(best.basename.length + 1)
        : null,
      worktreeTool: tool,
      source: "namematch",
    };
  }

  const key = stripCodename(tool, leaf);
  if (key === "") {
    return {
      isWorktree: true,
      rootPath: path,
      worktreeLabel: null,
      worktreeTool: tool,
      source: "synthetic",
    };
  }
  return {
    isWorktree: true,
    rootPath: key,
    worktreeLabel: leaf.startsWith(`${key}-`) ? leaf.slice(key.length + 1) : null,
    worktreeTool: tool,
    source: "synthetic",
  };
}

function compareKnownRoots(left: KnownRoot, right: KnownRoot): number {
  return (
    left.basename.length - right.basename.length ||
    left.sessions - right.sessions ||
    compareNullableString(left.lastSeen, right.lastSeen) ||
    compareCodePoints(left.path, right.path)
  );
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return -1;
  }
  if (right == null) {
    return 1;
  }
  return compareCodePoints(left, right);
}

function stripCodename(tool: string, leaf: string): string {
  if (tool === "t3") {
    const index = leaf.indexOf("-t3code-");
    return index === -1 ? leaf : leaf.slice(0, index);
  }
  if (tool === "warp") {
    const tokens = leaf.split("-");
    return tokens.length >= 3 ? tokens.slice(0, -2).join("-") : leaf;
  }
  if (tool === "conductor") {
    const tokens = leaf.split("-");
    return tokens.length >= 2 ? tokens.slice(0, -1).join("-") : leaf;
  }
  return leaf;
}

export function resolveGitRoot(dir: string): Resolution | null {
  const dotgit = `${dir}/.git`;
  // Read unconditionally instead of stat-then-read: a regular repo's `.git`
  // directory throws EISDIR and an absent one ENOENT, both meaning "not a
  // worktree leaf", with no window for the path to change between check and
  // use.
  let raw: string;
  try {
    raw = readFileSync(dotgit, "utf8");
  } catch {
    return null;
  }
  const target = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (target == null || !isAbsolute(target)) {
    return null;
  }
  const marker = "/.git/worktrees/";
  const index = target.lastIndexOf(marker);
  if (index === -1) {
    return null;
  }
  const rootPath = target.slice(0, index);
  const worktreeLabel = target.slice(index + marker.length).replace(/\/+$/, "");
  if (rootPath === "" || worktreeLabel === "") {
    return null;
  }
  return {
    isWorktree: true,
    rootPath,
    worktreeLabel,
    worktreeTool: inferTool(dir),
    source: "git",
  };
}

export function inferTool(path: string): string {
  const external = externalContainer(path);
  if (external != null) {
    return external.tool;
  }
  const { parts } = segments(path);
  if (parts.includes(".claude-worktrees")) {
    return "claude";
  }
  if (parts.includes(".codex-worktrees")) {
    return "codex";
  }
  return "git";
}

export function resolveWorktreeRoots(db: Database): void {
  const projects = db
    .query(
      `SELECT p.id, p.path, p.is_worktree AS isWorktree, p.root_path AS rootPath,
              p.root_source AS source, p.worktree_label AS worktreeLabel,
              p.worktree_tool AS worktreeTool, COUNT(s.id) AS sessions,
              MAX(s.started_at) AS lastSeen
       FROM project p LEFT JOIN session s ON s.project_id = p.id
       GROUP BY p.id`,
    )
    .all() as ProjectRow[];

  const writes: { id: number; resolution: Resolution }[] = [];
  const deferred: { id: number; path: string; tool: string; leaf: string }[] = [];
  const roots = new Map<string, { sessions: number; lastSeen: string | null }>();
  const noteRoot = (rootPath: string, sessions: number, lastSeen: string | null): void => {
    const entry = roots.get(rootPath) ?? { sessions: 0, lastSeen: null };
    entry.sessions += sessions;
    if (compareNullableString(lastSeen, entry.lastSeen) > 0) {
      entry.lastSeen = lastSeen;
    }
    roots.set(rootPath, entry);
  };

  for (const project of projects) {
    if (project.source === "git") {
      noteRoot(project.rootPath ?? project.path, project.sessions, project.lastSeen);
      continue;
    }
    const git = resolveGitRoot(project.path);
    if (git != null) {
      noteRoot(git.rootPath, project.sessions, project.lastSeen);
      writes.push({ id: project.id, resolution: git });
      continue;
    }
    const intree = classifyIntree(project.path);
    if (intree != null) {
      noteRoot(intree.rootPath, project.sessions, project.lastSeen);
      writes.push({ id: project.id, resolution: intree });
      continue;
    }
    const external = externalContainer(project.path);
    if (external != null) {
      deferred.push({ id: project.id, path: project.path, ...external });
      continue;
    }
    noteRoot(project.path, project.sessions, project.lastSeen);
    writes.push({
      id: project.id,
      resolution: {
        isWorktree: false,
        rootPath: project.path,
        worktreeLabel: null,
        worktreeTool: null,
        source: "self",
      },
    });
  }

  const knownRoots = [...roots.entries()].map(
    ([path, value]): KnownRoot => ({
      path,
      basename: basename(path),
      sessions: value.sessions,
      lastSeen: value.lastSeen,
    }),
  );
  for (const deferredProject of deferred) {
    writes.push({
      id: deferredProject.id,
      resolution: classifyExternal(
        deferredProject.tool,
        deferredProject.leaf,
        deferredProject.path,
        knownRoots,
      ),
    });
  }

  const update = db.prepare(
    `UPDATE project
       SET is_worktree = ?2, root_path = ?3, worktree_label = ?4,
           worktree_tool = ?5, root_source = ?6
     WHERE id = ?1`,
  );
  const byId = new Map(projects.map((project) => [project.id, project]));
  const apply = db.transaction((items: typeof writes) => {
    for (const { id, resolution } of items) {
      const project = byId.get(id);
      if (project == null || unchanged(project, resolution)) {
        continue;
      }
      update.run(
        id,
        resolution.isWorktree ? 1 : 0,
        resolution.rootPath,
        resolution.worktreeLabel,
        resolution.worktreeTool,
        resolution.source,
      );
    }
  });
  apply(writes);
}

function unchanged(project: ProjectRow, resolution: Resolution): boolean {
  return (
    project.isWorktree === Number(resolution.isWorktree) &&
    project.rootPath === resolution.rootPath &&
    project.source === resolution.source &&
    project.worktreeLabel === resolution.worktreeLabel &&
    project.worktreeTool === resolution.worktreeTool
  );
}
