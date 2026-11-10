import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withImmediateTransaction } from "./db.ts";

// A project's repository identity, read from the Git config on disk. Decant
// never runs `git` and never contacts the remote: the URL is only a name that
// stays the same across machines and worktrees, which a local path is not.

/** Git's own files here are a few hundred bytes. The cap keeps a planted or
 * mistaken `.git` from being read whole. */
const MAX_GIT_FILE_BYTES = 256 * 1024;

const NETWORK_SCHEMES = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point
const UNSAFE_IDENTITY = /[\x00-\x20\x7f\u0085\u2028\u2029]/;

/** `host/path` for a remote URL, without scheme, credentials, port, query, or
 * a trailing `.git`: `github.com/acme/widget` for both
 * `git@github.com:acme/widget.git` and `https://token@github.com/acme/widget`.
 * Null for a local path or `file:` remote, which names nothing off this
 * machine, and for anything that does not read as a host and a path. */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") {
    return null;
  }
  let host: string;
  let path: string;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!NETWORK_SCHEMES.has(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like `[user@]host:path`. A one-letter host is a Windows drive.
    const scp = /^(?:[^@/\s]+@)?([^@:/\s]{2,}):(.+)$/.exec(trimmed);
    if (scp == null) {
      return null;
    }
    host = scp[1] as string;
    path = scp[2] as string;
  }
  const name = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const identity = `${host.toLowerCase()}/${name}`;
  if (host === "" || name === "" || UNSAFE_IDENTITY.test(identity)) {
    return null;
  }
  return identity;
}

/** The URL of `origin` in a Git config file, or of the only remote when there
 * is no `origin`. With several remotes and no `origin`, none is the obvious
 * identity, so the answer is null. */
export function remoteUrlFromGitConfig(config: string): string | null {
  const urls = new Map<string, string>();
  let remote: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      remote = /^\[\s*remote\s+"([^"]*)"\s*\]$/i.exec(line)?.[1] ?? null;
      continue;
    }
    if (remote == null || urls.has(remote)) {
      continue;
    }
    const value = /^url\s*=\s*(.*)$/i.exec(line)?.[1];
    if (value == null) {
      continue;
    }
    const url = value
      .replace(/\s+[#;].*$/, "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (url !== "") {
      urls.set(remote, url);
    }
  }
  const origin = urls.get("origin");
  if (origin != null) {
    return origin;
  }
  return urls.size === 1 ? ([...urls.values()][0] ?? null) : null;
}

/** The file's text, or null when it is not a regular file, cannot be read, or
 * is over the cap. Everything is decided on the open descriptor, so the file
 * cannot be swapped between a check and the read, and the read itself is
 * bounded, so a file that grows afterward is still refused. */
function readSmallFile(path: string): string | null {
  let fd: number;
  try {
    // Non-blocking, so a FIFO planted at the path cannot hold the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return null;
    }
    const buffer = Buffer.allocUnsafe(MAX_GIT_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) {
        return buffer.toString("utf8", 0, length);
      }
      length += read;
      if (length > MAX_GIT_FILE_BYTES) {
        return null;
      }
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The Git directory `dir` itself owns, if it is the top of a working tree. A
 * worktree or submodule has a `.git` file that points at it. */
function gitDirOf(dir: string): string | null {
  const dotgit = join(dir, ".git");
  if (isDirectory(dotgit)) {
    return dotgit;
  }
  const target = readSmallFile(dotgit)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  return target == null || target === "" ? null : resolve(dir, target);
}

/** The repository identity of the working tree that holds `dir`, or null when
 * `dir` is gone, is not inside a working tree, or its repository has no usable
 * remote. A directory that no longer exists is never looked up through its
 * parents: they would answer for some other repository. */
export function resolveRepoRemote(dir: string): string | null {
  if (!isAbsolute(dir) || !isDirectory(dir)) {
    return null;
  }
  let current = dir;
  for (;;) {
    const gitDir = gitDirOf(current);
    if (gitDir != null) {
      // A linked worktree keeps the shared config in the directory its
      // `commondir` file names.
      const common = readSmallFile(join(gitDir, "commondir"))?.trim();
      const configDir = common == null || common === "" ? gitDir : resolve(gitDir, common);
      const config = readSmallFile(join(configDir, "config"));
      const url = config == null ? null : remoteUrlFromGitConfig(config);
      return url == null ? null : normalizeRemoteUrl(url);
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

interface ProjectRemoteRow {
  id: number;
  path: string;
  rootPath: string | null;
  repoRemote: string | null;
}

/** Record each project's repository identity. A project whose own directory
 * is gone, as a removed worktree's is, takes the identity of the repository
 * root it resolved to. A lookup that finds nothing leaves the stored value
 * alone, so an identity outlives the checkout it was read from. Projects that
 * hold only imported ATIF trajectories are skipped: their path is a job
 * directory, and the repository around it did not produce the sessions. */
export function resolveProjectRemotes(db: Database): void {
  const statement = db.prepare(
    `SELECT p.id, p.path, p.root_path AS rootPath, p.repo_remote AS repoRemote
       FROM project p
      WHERE EXISTS (SELECT 1 FROM session s WHERE s.project_id = p.id AND s.tool <> 'atif')`,
  );
  let projects: ProjectRemoteRow[];
  try {
    projects = statement.all() as ProjectRemoteRow[];
  } finally {
    statement.finalize();
  }

  const resolved = new Map<string, string | null>();
  const lookup = (dir: string): string | null => {
    if (!resolved.has(dir)) {
      resolved.set(dir, resolveRepoRemote(dir));
    }
    return resolved.get(dir) ?? null;
  };
  const writes: { id: number; remote: string }[] = [];
  for (const project of projects) {
    const remote =
      lookup(project.path) ??
      (project.rootPath != null && project.rootPath !== project.path
        ? lookup(project.rootPath)
        : null);
    if (remote != null && remote !== project.repoRemote) {
      writes.push({ id: project.id, remote });
    }
  }
  if (writes.length === 0) {
    return;
  }
  const update = db.prepare("UPDATE project SET repo_remote = ?2 WHERE id = ?1");
  try {
    withImmediateTransaction(db, () => {
      for (const { id, remote } of writes) {
        update.run(id, remote);
      }
    });
  } finally {
    update.finalize();
  }
}
