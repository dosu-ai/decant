export type SessionLoadPlan = {
  limit: number;
  offset: number;
  replace: boolean;
};

export function planSessionLoad({
  loadedRequestKey,
  loadedRows,
  pageSize,
  requestKey,
  sessionLimit,
}: {
  loadedRequestKey: string | null;
  loadedRows: number;
  pageSize: number;
  requestKey: string;
  sessionLimit: number;
}): SessionLoadPlan | null {
  const refreshFirstPage = loadedRequestKey !== requestKey;
  const offset = refreshFirstPage ? 0 : loadedRows;
  const desiredLimit = refreshFirstPage
    ? Math.max(sessionLimit, pageSize)
    : sessionLimit - loadedRows;
  const limit = Math.max(0, desiredLimit);
  if (limit <= 0) {
    return null;
  }
  return { limit, offset, replace: offset === 0 };
}

export function shouldShowSessionSkeleton({
  isLoading,
  loadedRows,
  query,
}: {
  isLoading: boolean;
  loadedRows: number;
  query: string;
}): boolean {
  return isLoading && loadedRows === 0 && query.trim() === "";
}

export type SessionTableBody = "empty" | "error" | "rows" | "skeleton";

/**
 * What the sessions table body shows. A failed fetch with nothing loaded gets
 * an inline error with a retry instead of a skeleton or a misleading "no
 * sessions" empty state; once rows are on screen they stay visible through
 * background refreshes and even through a failed refresh.
 */
export function sessionTableBodyState({
  errored,
  filteredRows,
  isLoading,
  loadedRows,
  query,
}: {
  errored: boolean;
  filteredRows: number;
  isLoading: boolean;
  loadedRows: number;
  query: string;
}): SessionTableBody {
  if (errored && loadedRows === 0) {
    return "error";
  }
  if (shouldShowSessionSkeleton({ isLoading, loadedRows, query })) {
    return "skeleton";
  }
  if (filteredRows === 0) {
    return "empty";
  }
  return "rows";
}
