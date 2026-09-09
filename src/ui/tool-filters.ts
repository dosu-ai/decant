export type ToolFilters = {
  errorsOnly: boolean;
  from: string | null;
  minMs: number;
  offset: number;
  server: string;
  to: string | null;
  tool: string;
};

export type ToolDateRange = {
  preset: "all" | "custom";
  from: string | null;
  to: string | null;
};

function validIsoDate(value: string | null): string | null {
  if (value == null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function toolFiltersFromSearch(search: string): ToolFilters {
  const params = new URLSearchParams(search);
  const minMs = Number(params.get("min_ms") ?? "0");
  const offset = Number(params.get("offset") ?? "0");
  return {
    errorsOnly: params.get("errors_only") === "1",
    from: validIsoDate(params.get("from")),
    minMs: Number.isFinite(minMs) && minMs >= 0 ? minMs : 0,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    server: params.get("server") ?? "",
    to: validIsoDate(params.get("to")),
    tool: params.get("tool") ?? "",
  };
}

export function toolFiltersHref(filters: ToolFilters): string {
  const params = new URLSearchParams();
  if (filters.tool !== "") {
    params.set("tool", filters.tool);
  }
  if (filters.server !== "") {
    params.set("server", filters.server);
  }
  if (filters.errorsOnly) {
    params.set("errors_only", "1");
  }
  if (filters.minMs > 0) {
    params.set("min_ms", String(filters.minMs));
  }
  if (filters.from != null) {
    params.set("from", filters.from);
  }
  if (filters.to != null) {
    params.set("to", filters.to);
  }
  if (filters.offset > 0) {
    params.set("offset", String(filters.offset));
  }
  const query = params.toString();
  return query === "" ? "/tools" : `/tools?${query}`;
}

export function toolDateRangeFromFilters(filters: Pick<ToolFilters, "from" | "to">): ToolDateRange {
  if (filters.from == null && filters.to == null) {
    return { preset: "all", from: null, to: null };
  }
  return {
    preset: "custom",
    from: filters.from,
    to: filters.to,
  };
}

export function withToolDateRange(
  filters: ToolFilters,
  range: Pick<ToolDateRange, "from" | "to">,
): ToolFilters {
  return {
    ...filters,
    from: range.from,
    offset: 0,
    to: range.to,
  };
}

export function clearToolCallFilters(filters: Pick<ToolFilters, "from" | "to">): ToolFilters {
  return {
    errorsOnly: false,
    from: filters.from,
    minMs: 0,
    offset: 0,
    server: "",
    to: filters.to,
    tool: "",
  };
}

export function isDrilldownActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
