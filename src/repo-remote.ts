import type { Database } from "bun:sqlite";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundedFs, type ProbeFs } from "./bounded-fs.ts";
import { withImmediateTransaction } from "./db.ts";

const MAX_GIT_FILE_BYTES = 256 * 1024;

const NETWORK_SCHEMES = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:"]);

function hasUnsafeIdentityChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

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
  if (host === "" || name === "" || hasUnsafeIdentityChar(identity)) {
    return null;
  }
  return identity;
}

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

type GitFs = Pick<ProbeFs, "readSmallFile" | "isDirectory">;

function gitDirOf(dir: string, fs: GitFs): string | null {
  const dotgit = join(dir, ".git");
  if (fs.isDirectory(dotgit)) {
    return dotgit;
  }
  const target = fs
    .readSmallFile(dotgit, MAX_GIT_FILE_BYTES)
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  return target == null || target === "" ? null : resolve(dir, target);
}

export function resolveRepoRemote(dir: string, fs: GitFs = boundedFs): string | null {
  if (!isAbsolute(dir) || !fs.isDirectory(dir)) {
    return null;
  }
  let current = dir;
  for (;;) {
    const gitDir = gitDirOf(current, fs);
    if (gitDir != null) {
      const common = fs.readSmallFile(join(gitDir, "commondir"), MAX_GIT_FILE_BYTES)?.trim();
      const configDir = common == null || common === "" ? gitDir : resolve(gitDir, common);
      const config = fs.readSmallFile(join(configDir, "config"), MAX_GIT_FILE_BYTES);
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

export function resolveProjectRemotes(db: Database, fs: GitFs = boundedFs): void {
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
      resolved.set(dir, resolveRepoRemote(dir, fs));
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
