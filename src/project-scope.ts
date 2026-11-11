import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeRemoteUrl, resolveRepoRemote } from "./repo-remote.ts";
import { resolveGitRoot } from "./worktree.ts";

// Maps a typed project or repository to the keys the archive stores. Only the
// typed directory is read from disk: stored paths come from logs.

export interface ScopeEnv {
  cwd: string;
  /** Expands a leading `~`. Null or undefined leaves it alone. */
  homeDir?: string | null;
}

export type ProjectMatch = { path: string } | { path: null; tried: string[] };

export type RepoMatch =
  | { kind: "matched"; roots: string[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none"; tried: string[] };

/** The absolute forms a typed path can be stored under: resolved against the
 * current directory, then with symlinks resolved when the directory exists. */
export function pathCandidates(value: string, env: ScopeEnv): string[] {
  const home = env.homeDir;
  const expanded =
    home != null && home !== "" && (value === "~" || value.startsWith("~/"))
      ? join(home, value.slice(1))
      : value;
  // resolve() also drops a trailing slash and folds `.` and `..`.
  const absolute = resolve(env.cwd, expanded);
  const candidates = [absolute];
  try {
    const real = realpathSync(absolute);
    if (real !== absolute) {
      candidates.push(real);
    }
  } catch {
    // A directory that is gone can still be a stored project.
  }
  return candidates;
}

/** The one stored project path `value` names, or the paths that were tried. */
export function resolveProjectPath(db: Database, value: string, env: ScopeEnv): ProjectMatch {
  // The value as typed goes first, so a stored path that is not a local
  // absolute path still matches exactly.
  const resolved = pathCandidates(value, env);
  for (const path of unique([value, ...resolved])) {
    if (db.query("SELECT 1 FROM project WHERE path = ?1").get(path) != null) {
      return { path };
    }
  }
  return { path: null, tried: resolved };
}

/** The repository roots `value` names. Checkouts that share a remote identity
 * are one repository, so the answer can hold several roots. */
export function resolveRepoRoots(db: Database, value: string, env: ScopeEnv): RepoMatch {
  const dirs = pathCandidates(value, env);
  const tree = workingTree(dirs.at(-1) as string);
  // Every key is the typed value or lies in its working tree, so all of them
  // name the same repository.
  const keys = unique([value, ...dirs, ...(tree?.inside ?? []), tree?.mainRoot]);
  const roots = repoGroup(
    db,
    unique(keys.flatMap((key) => rootsForKey(db, key))),
    unique([
      tree?.remote,
      normalizeRemoteUrl(value) ?? value,
      ...keys.flatMap((key) => remotesOf(db, key)),
    ]),
  );
  if (roots.length > 0) {
    return { kind: "matched", roots };
  }

  if (!value.includes("/") && value !== "." && value !== ".." && !value.startsWith("~")) {
    const named = (
      db
        .query("SELECT DISTINCT COALESCE(root_path, path) AS root FROM project ORDER BY root")
        .all() as { root: string }[]
    )
      .map((row) => row.root)
      .filter((root) => lastSegment(root) === value);
    const groups = named.map((root) => repoGroup(db, [root], []));
    const first = groups[0];
    if (first != null) {
      // Two checkouts of one repository share a name and a group.
      const same = groups.every((group) => group.join("\n") === first.join("\n"));
      return same ? { kind: "matched", roots: first } : { kind: "ambiguous", candidates: named };
    }
  }
  return { kind: "none", tried: dirs };
}

interface WorkingTree {
  /** `dir` and its parents up to the top of the working tree. */
  inside: string[];
  /** The main checkout, when the tree is a linked worktree. */
  mainRoot: string | null;
  remote: string | null;
}

/** The Git working tree that holds `dir`. A directory that is gone answers
 * null: its parents would speak for some other repository. */
function workingTree(dir: string): WorkingTree | null {
  if (!exists(dir)) {
    return null;
  }
  const inside: string[] = [];
  let current = dir;
  for (;;) {
    inside.push(current);
    const linked = resolveGitRoot(current);
    if (linked != null || exists(join(current, ".git"))) {
      return { inside, mainRoot: linked?.rootPath ?? null, remote: resolveRepoRemote(current) };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function rootsForKey(db: Database, key: string): string[] {
  return (
    db
      .query(
        `SELECT DISTINCT COALESCE(root_path, path) AS root
           FROM project WHERE path = ?1 OR root_path = ?1`,
      )
      .all(key) as { root: string }[]
  ).map((row) => row.root);
}

function remotesOf(db: Database, path: string): string[] {
  return (
    db
      .query(
        "SELECT repo_remote AS remote FROM project WHERE path = ?1 AND repo_remote IS NOT NULL",
      )
      .all(path) as { remote: string }[]
  ).map((row) => row.remote);
}

// A root from a log written on Windows keeps its backslashes.
function lastSegment(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

/** `roots` plus every root that has one of the remote identities. Of a root's
 * worktrees only those Git resolved are asked: one grouped by name could be
 * another repository. */
function repoGroup(db: Database, roots: string[], remotes: string[]): string[] {
  const group = new Set(roots);
  const identities = new Set(remotes);
  const ofGitWorktrees = db.query(
    `SELECT repo_remote AS remote FROM project
      WHERE root_path = ?1 AND root_source = 'git' AND repo_remote IS NOT NULL`,
  );
  for (const root of roots) {
    for (const remote of remotesOf(db, root)) {
      identities.add(remote);
    }
    for (const row of ofGitWorktrees.all(root) as { remote: string }[]) {
      identities.add(row.remote);
    }
  }
  const byRemote = db.query(
    "SELECT DISTINCT COALESCE(root_path, path) AS root FROM project WHERE repo_remote = ?1",
  );
  for (const remote of identities) {
    for (const row of byRemote.all(remote) as { root: string }[]) {
      group.add(row.root);
    }
  }
  return [...group].sort();
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value !== ""))];
}
