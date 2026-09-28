import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api.ts";
import { ApiFailureState } from "../api-failure.tsx";
import { EmptyState } from "../common.tsx";
import { TABLE_ROW_LIMIT } from "../constants.ts";
import { dateRangeQuery, withDateQuery } from "../date-range.ts";
import { DateRangeControl } from "../date-range-control.tsx";
import { relativeTime } from "../date-time.ts";
import { basename, capitalize, formatInt } from "../format.ts";
import { Link } from "../link.tsx";
import { projectSessionsHref } from "../navigation.ts";
import {
  type FileSortKey,
  fileSortValue,
  fileTotal,
  nextSort,
  SortableHeader,
  type SortState,
  sortRows,
} from "../sorting.tsx";
import type { DateBounds, DateRangeSelection, FileRow } from "../types.ts";

export function FilesView({
  dateBounds,
  dateRange,
  onDateRangeChange,
  rows,
}: {
  dateBounds: DateBounds | null;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  rows: FileRow[];
}) {
  const [group, setGroup] = useState<"path" | "ext">("path");
  const [op, setOp] = useState<"read" | "edit" | "write" | "delete" | null>(null);
  const [fileRows, setFileRows] = useState(rows);
  const [fileError, setFileError] = useState<unknown>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesRetryKey, setFilesRetryKey] = useState(0);
  const [fileSort, setFileSort] = useState<SortState<FileSortKey>>({
    key: "total",
    direction: "desc",
  });
  const sortedFileRows = useMemo(
    () => sortRows(fileRows, fileSort, fileSortValue),
    [fileRows, fileSort],
  );

  useEffect(() => {
    if (group === "path" && op == null) {
      setFileRows(rows);
    }
  }, [group, op, rows]);

  useEffect(() => {
    void filesRetryKey;
    const controller = new AbortController();
    const opParam = op == null ? "" : `&op=${op}`;
    setFileError(null);
    setFilesLoading(true);
    void getJson<FileRow[]>(
      withDateQuery(
        `/api/files?group=${group}&limit=${TABLE_ROW_LIMIT}${opParam}`,
        dateRangeQuery(dateRange),
      ),
      { signal: controller.signal },
    )
      .then(setFileRows)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setFileError(reason);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFilesLoading(false);
        }
      });
    return () => controller.abort();
  }, [dateRange, filesRetryKey, group, op]);

  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>File hotspots</h1>
          <p>
            What agents touch most. Heavy re-reads with few edits are AGENTS.md / skill candidates;
            heavy edits are churn.
          </p>
        </div>
        <DateRangeControl bounds={dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="segment-row">
        <fieldset className="segmented-control">
          <legend>Group by</legend>
          <button aria-pressed={group === "path"} onClick={() => setGroup("path")} type="button">
            Files
          </button>
          <button aria-pressed={group === "ext"} onClick={() => setGroup("ext")} type="button">
            Languages
          </button>
        </fieldset>
        <fieldset className="segmented-control">
          <legend>Operation</legend>
          <button aria-pressed={op == null} onClick={() => setOp(null)} type="button">
            All ops
          </button>
          {(["read", "edit", "write", "delete"] as const).map((name) => (
            <button aria-pressed={op === name} key={name} onClick={() => setOp(name)} type="button">
              {capitalize(name)}
            </button>
          ))}
        </fieldset>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{group === "ext" ? "Languages" : "Hotspots"}</h2>
            <p>Per-operation counts from tool-call evidence, ordered by activity</p>
          </div>
        </div>
        {fileError != null ? (
          <ApiFailureState error={fileError} onRetry={() => setFilesRetryKey((key) => key + 1)} />
        ) : filesLoading && fileRows.length === 0 ? (
          <div className="panel-body muted">Loading file activity…</div>
        ) : fileRows.length === 0 ? (
          <EmptyState
            icon="file"
            message="Hotspots appear once your session logs contain file activity."
            title="No file activity"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table files-table">
              <colgroup>
                <col className="col-file" />
                {group === "path" ? <col className="col-project" /> : null}
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-sessions" />
                <col className="col-total" />
                <col className="col-date" />
              </colgroup>
              <thead>
                <tr>
                  <SortableHeader
                    label={group === "ext" ? "Extension" : "File"}
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="key"
                  />
                  {group === "path" ? (
                    <SortableHeader
                      label="Project"
                      onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                      sort={fileSort}
                      sortKey="project"
                    />
                  ) : null}
                  <SortableHeader
                    align="right"
                    label="Reads"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="reads"
                  />
                  <SortableHeader
                    align="right"
                    label="Edits"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="edits"
                  />
                  <SortableHeader
                    align="right"
                    label="Writes"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="writes"
                  />
                  <SortableHeader
                    align="right"
                    label="Deletes"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="deletes"
                  />
                  <SortableHeader
                    align="right"
                    label="Sessions"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="sessions"
                  />
                  <SortableHeader
                    align="right"
                    label="Total"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="total"
                  />
                  <SortableHeader
                    align="right"
                    label="Modified"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="last_touched_at"
                  />
                </tr>
              </thead>
              <tbody>
                {sortedFileRows.map((row) => (
                  <tr key={`${group}-${row.project ?? ""}-${row.key}`}>
                    <td className="mono truncate-cell">
                      <Link href={`/search?q=${encodeURIComponent(`"${row.key}"`)}`}>
                        {row.key}
                      </Link>
                    </td>
                    {group === "path" ? (
                      <td className="muted" title={row.project ?? ""}>
                        {row.project == null ? (
                          <span className="faint">-</span>
                        ) : (
                          <Link href={projectSessionsHref(row.project)}>
                            {basename(row.project)}
                          </Link>
                        )}
                      </td>
                    ) : null}
                    <td className="numeric muted">{formatInt(row.reads)}</td>
                    <td className="numeric muted">{formatInt(row.edits)}</td>
                    <td className="numeric muted">{formatInt(row.writes)}</td>
                    <td className="numeric muted">{formatInt(row.deletes)}</td>
                    <td className="numeric muted">{formatInt(row.sessions)}</td>
                    <td className="numeric">{formatInt(fileTotal(row))}</td>
                    <td className="numeric muted">{relativeTime(row.last_touched_at)}</td>
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
