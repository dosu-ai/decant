import { Icon } from "./icons.tsx";
import { formatMcpServer } from "./mcp-server.ts";
import type { DimensionRow, FileRow, McpRow, ToolRow } from "./types.ts";

export type SortDirection = "asc" | "desc";

export type SortValue = number | string | null | undefined;

export type SortState<Key extends string> = { direction: SortDirection; key: Key };

export type ModelSortKey =
  | "cost"
  | "input_tokens"
  | "key"
  | "output_tokens"
  | "reasoning_tokens"
  | "sessions";

export type ProjectSortKey = "cost" | "key" | "sessions";

export type McpSortKey = "calls" | "errors" | "last_used" | "p50" | "server" | "tools";

export type ToolSortKey = "calls" | "errors" | "kind" | "last_used" | "p50" | "server" | "tool";

export type FileSortKey =
  | "deletes"
  | "edits"
  | "key"
  | "last_touched_at"
  | "project"
  | "reads"
  | "sessions"
  | "total"
  | "writes";

export function nextSort<Key extends string>(sort: SortState<Key>, key: Key): SortState<Key> {
  return {
    key,
    direction: sort.key === key && sort.direction === "desc" ? "asc" : "desc",
  };
}

export function sortRows<Row, Key extends string>(
  rows: Row[],
  sort: SortState<Key>,
  valueFor: (row: Row, key: Key) => SortValue,
): Row[] {
  return rows
    .slice()
    .sort((left, right) =>
      compareSortValue(valueFor(left, sort.key), valueFor(right, sort.key), sort.direction),
    );
}

export function compareSortValue(
  left: SortValue,
  right: SortValue,
  direction: SortDirection,
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof left === "number" || typeof right === "number") {
    return multiplier * ((Number(left) || 0) - (Number(right) || 0));
  }
  return (
    multiplier * String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true })
  );
}

export function modelSortValue(row: DimensionRow, key: ModelSortKey): SortValue {
  switch (key) {
    case "cost":
      return row.estimated_cost_usd;
    case "input_tokens":
      return row.input_tokens;
    case "key":
      return row.key;
    case "output_tokens":
      return row.output_tokens;
    case "reasoning_tokens":
      return row.reasoning_tokens || row.est_reasoning_tokens;
    case "sessions":
      return row.sessions;
  }
}

export function projectSortValue(row: DimensionRow, key: ProjectSortKey): SortValue {
  switch (key) {
    case "cost":
      return row.estimated_cost_usd;
    case "key":
      return row.key;
    case "sessions":
      return row.sessions;
  }
}

export function mcpSortValue(row: McpRow, key: McpSortKey): SortValue {
  switch (key) {
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "last_used":
      return row.last_used_at == null ? 0 : Date.parse(row.last_used_at);
    case "p50":
      return row.p50_ms;
    case "server":
      // The short name on purpose, not the disambiguated label: two
      // registrations of one server sort adjacently, which is where a reader
      // expects to find them.
      return formatMcpServer(row.mcp_server);
    case "tools":
      return row.tools;
  }
}

export function toolSortValue(row: ToolRow, key: ToolSortKey): SortValue {
  switch (key) {
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "kind":
      return row.tool_kind;
    case "last_used":
      return row.last_used_at == null ? 0 : Date.parse(row.last_used_at);
    case "p50":
      return row.p50_ms;
    case "server":
      // The short name on purpose, not the disambiguated label: two
      // registrations of one server sort adjacently, which is where a reader
      // expects to find them.
      return formatMcpServer(row.mcp_server);
    case "tool":
      return row.tool_name;
  }
}

export function fileSortValue(row: FileRow, key: FileSortKey): SortValue {
  switch (key) {
    case "deletes":
      return row.deletes;
    case "edits":
      return row.edits;
    case "key":
      return row.key;
    case "last_touched_at":
      return row.last_touched_at == null ? 0 : Date.parse(row.last_touched_at);
    case "project":
      return row.project;
    case "reads":
      return row.reads;
    case "sessions":
      return row.sessions;
    case "total":
      return fileTotal(row);
    case "writes":
      return row.writes;
  }
}

export function SortableHeader<Key extends string>({
  align = "left",
  label,
  onSort,
  sort,
  sortKey,
}: {
  align?: "left" | "right";
  label: string;
  onSort: (key: Key) => void;
  sort: SortState<Key>;
  sortKey: Key;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "numeric" : undefined}
    >
      <button
        className={`sort-header${align === "right" ? " is-right" : ""}${active ? " is-active" : ""}`}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        <span>{label}</span>
        <Icon name={active && sort.direction === "asc" ? "chevronUp" : "chevronDown"} />
      </button>
    </th>
  );
}

export function fileTotal(row: FileRow): number {
  return row.reads + row.edits + row.writes + row.deletes;
}
