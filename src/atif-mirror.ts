import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { ARCHIVE_DIR_MODE } from "./db.ts";
import { type AtifTrajectory, exportAtif } from "./export-atif.ts";
import { listSessions } from "./query.ts";

// A folder of ATIF documents, one per session, for other tools to read. Each
// document stands alone: a subagent is its own file that the parent points at
// by relative path, so no session is counted twice. Unchanged files are left
// alone, so a reader can watch the folder or compare modification times.

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

interface SessionFacts {
  tool: string;
  source_session_id: string;
  parent_tool: string | null;
  parent_source_session_id: string | null;
}

/** A session's file within the folder. Tool and source session id are unique
 * together, and neither changes when the archive is rebuilt. */
export function atifMirrorPath(tool: string, sourceSessionId: string): string {
  return `${tool}/${fileName(sourceSessionId)}.atif.json`;
}

/** Percent-encodes what a file name cannot hold on any platform, and a leading
 * dot so no id names a hidden file or `..`. */
function fileName(id: string): string {
  return encodeURIComponent(id).replace(/\*/g, "%2A").replace(/^\./, "%2E");
}

/** The path from one document's folder to another document. */
function relativeTo(from: string, to: string): string {
  const path = posix.relative(posix.dirname(from), to);
  return path.startsWith(".") ? path : `./${path}`;
}

/** The folder may leave the machine, and `extra.repository` names the project
 * without a local path. */
function withoutCwd(trajectory: AtifTrajectory): AtifTrajectory {
  const { cwd: _cwd, ...extra } = trajectory.extra;
  return { ...trajectory, extra };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Replaces the file in one step, so a reader never sees half a document. */
function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: ARCHIVE_DIR_MODE });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function mirrorAtif(db: Database, options: AtifMirrorOptions): AtifMirrorReport {
  // Documents hold transcripts, so a folder Decant creates is owner-only, like
  // the archive's. One that already exists keeps its mode.
  mkdirSync(options.out, { recursive: true, mode: ARCHIVE_DIR_MODE });
  const report: AtifMirrorReport = { out: options.out, written: 0, unchanged: 0, skipped: 0 };

  const facts = db.prepare(
    `SELECT s.tool, s.source_session_id,
            parent.tool AS parent_tool, parent.source_session_id AS parent_source_session_id
       FROM session s LEFT JOIN session parent ON parent.id = s.parent_session_id
      WHERE s.id = ?1`,
  );
  try {
    const sessions = listSessions(db, { limit: Number.MAX_SAFE_INTEGER, includeSubagents: true });
    for (const session of sessions) {
      const row = facts.get(session.id) as SessionFacts | null;
      if (row == null) {
        continue;
      }
      const path = atifMirrorPath(row.tool, row.source_session_id);
      const exported = exportAtif(db, session.id, {
        subagentPath: (subagent) =>
          relativeTo(path, atifMirrorPath(subagent.tool, subagent.source_session_id)),
      });
      if (!exported.ok) {
        report.skipped += 1;
        continue;
      }
      const trajectory = withoutCwd(exported.trajectory);
      // ATIF links a parent to its subagents only; these let a reader of one
      // subagent's file find its parent without reading the whole folder.
      if (row.parent_tool != null && row.parent_source_session_id != null) {
        trajectory.extra.parent_session_id = row.parent_source_session_id;
        trajectory.extra.parent_trajectory_path = relativeTo(
          path,
          atifMirrorPath(row.parent_tool, row.parent_source_session_id),
        );
      }
      const content = `${JSON.stringify(trajectory, null, 2)}\n`;
      const target = join(options.out, path);
      if (readText(target) === content) {
        report.unchanged += 1;
        continue;
      }
      writeAtomically(target, content);
      report.written += 1;
    }
  } finally {
    facts.finalize();
  }
  return report;
}
