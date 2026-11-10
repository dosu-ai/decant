import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, posix } from "node:path";
import { ARCHIVE_DIR_MODE } from "./db.ts";
import type { AtifTrajectory } from "./export-atif.ts";
import { exportAtif } from "./export-atif.ts";
import { listSessions } from "./query.ts";

// One standalone ATIF document per session, for other tools to read. Subagents
// are separate files, so summing every document counts nothing twice.

export interface AtifMirrorOptions {
  /** The folder to write. Created owner-only when it does not exist. */
  out: string;
}

export interface AtifMirrorReport {
  out: string;
  /** Files created or rewritten because the session changed. */
  written: number;
  /** Files already holding the current document. */
  unchanged: number;
  /** Sessions with no steps to export. */
  skipped: number;
}

export type AtifMirrorResult =
  | { ok: true; report: AtifMirrorReport }
  | { ok: false; reason: "unsafe_path"; path: string };

const DOCUMENT_FILE_MODE = 0o600;

interface SessionRow {
  id: number;
  tool: string;
  source_session_id: string;
  parent_session_id: number | null;
}

/** Windows reserves these names whatever extension follows them. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** A session's file within the folder. Tool and source session id are unique
 * together, and neither changes when the archive is rebuilt. */
export function atifMirrorPath(tool: string, sourceSessionId: string): string {
  return `${tool}/${fileName(sourceSessionId)}.atif.json`;
}

/** Other ids get a digest after `~`, which plain names never hold, so ids that
 * differ only in case stay apart on case-insensitive disks. */
function fileName(id: string): string {
  const stem = id.split(".")[0] ?? "";
  if (/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) && !RESERVED_NAMES.test(stem)) {
    return id;
  }
  const readable = id
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 64);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  return `${readable}~${digest}`;
}

/** The path from one document's folder to another document. */
function relativeTo(from: string, to: string): string {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
}

/** The import files every document under one tool and keys it by
 * `trajectory_id`, so ids from two tools must not meet in one folder. */
function qualified(tool: string, trajectoryId: string): string {
  return `${tool}:${trajectoryId}`;
}

/** The folder may leave the machine, and `extra.repository` names the project
 * without a local path. */
function withoutCwd(trajectory: AtifTrajectory): AtifTrajectory {
  const { cwd: _cwd, ...extra } = trajectory.extra;
  return { ...trajectory, extra };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Null for a link, so the write replaces it instead of following it. */
function currentContent(path: string): string | null {
  if (isSymlink(path)) {
    return null;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** One rename, so a reader never sees half a document; `wx` never follows a link. */
function writeAtomically(path: string, content: string): void {
  const temporary = join(path, "..", `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", DOCUMENT_FILE_MODE);
  try {
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Parents before children. Archived subagents of a written parent are kept,
 * because the parent's document points at them. */
function sessionsInOrder(db: Database): SessionRow[] {
  const rows = db
    .query("SELECT id, tool, source_session_id, parent_session_id FROM session ORDER BY id")
    .all() as SessionRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<number, SessionRow[]>();
  for (const row of rows) {
    if (row.parent_session_id != null) {
      const siblings = children.get(row.parent_session_id) ?? [];
      siblings.push(row);
      children.set(row.parent_session_id, siblings);
    }
  }
  const listed = new Set(
    listSessions(db, { limit: Number.MAX_SAFE_INTEGER, includeSubagents: true }).map(
      (session) => session.id,
    ),
  );
  const queue = rows.filter(
    (row) =>
      listed.has(row.id) && (row.parent_session_id == null || !listed.has(row.parent_session_id)),
  );
  const seen = new Set<number>();
  const ordered: SessionRow[] = [];
  for (let next = 0; next < queue.length; next += 1) {
    const row = queue[next] as SessionRow;
    if (seen.has(row.id) || !byId.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    ordered.push(row);
    queue.push(...(children.get(row.id) ?? []));
  }
  return ordered;
}

export function mirrorAtif(db: Database, options: AtifMirrorOptions): AtifMirrorResult {
  // Documents hold transcripts, so a folder Decant creates is owner-only.
  mkdirSync(options.out, { recursive: true, mode: ARCHIVE_DIR_MODE });
  const report: AtifMirrorReport = { out: options.out, written: 0, unchanged: 0, skipped: 0 };
  const rows = sessionsInOrder(db);
  const parentOf = new Map(rows.map((row) => [row.id, row.parent_session_id]));
  const documents = new Map<number, { path: string; sessionId: string }>();
  const checkedFolders = new Set<string>();

  for (const row of rows) {
    const path = atifMirrorPath(row.tool, row.source_session_id);
    // A tool folder that is a link would send documents outside the mirror.
    if (!checkedFolders.has(row.tool)) {
      const folder = join(options.out, row.tool);
      if (isSymlink(folder)) {
        return { ok: false, reason: "unsafe_path", path: folder };
      }
      mkdirSync(folder, { recursive: true, mode: ARCHIVE_DIR_MODE });
      checkedFolders.add(row.tool);
    }

    const subagentTools = new Map<string, string>();
    const exported = exportAtif(db, row.id, {
      subagentPath: (subagent) => {
        const target = relativeTo(path, atifMirrorPath(subagent.tool, subagent.source_session_id));
        subagentTools.set(target, subagent.tool);
        return target;
      },
    });
    if (!exported.ok) {
      report.skipped += 1;
      continue;
    }
    const trajectory = withoutCwd(exported.trajectory);
    trajectory.trajectory_id = qualified(row.tool, trajectory.trajectory_id);
    for (const step of trajectory.steps) {
      for (const result of step.observation?.results ?? []) {
        for (const ref of result.subagent_trajectory_ref ?? []) {
          const tool = ref.trajectory_path == null ? null : subagentTools.get(ref.trajectory_path);
          if (tool != null) {
            ref.trajectory_id = qualified(tool, ref.trajectory_id);
          }
        }
      }
    }
    // ATIF has no parent field. A parent with nothing to export has no file, so
    // the nearest ancestor that has one stands in.
    let ancestor = parentOf.get(row.id) ?? null;
    const walked = new Set<number>();
    while (ancestor != null && !documents.has(ancestor) && !walked.has(ancestor)) {
      walked.add(ancestor);
      ancestor = parentOf.get(ancestor) ?? null;
    }
    const parent = ancestor == null ? undefined : documents.get(ancestor);
    if (parent != null) {
      trajectory.extra.parent_session_id = parent.sessionId;
      trajectory.extra.parent_trajectory_path = relativeTo(path, parent.path);
    }
    documents.set(row.id, { path, sessionId: trajectory.session_id });

    const content = `${JSON.stringify(trajectory, null, 2)}\n`;
    const target = join(options.out, path);
    if (currentContent(target) === content) {
      report.unchanged += 1;
      continue;
    }
    writeAtomically(target, content);
    report.written += 1;
  }
  return { ok: true, report };
}
