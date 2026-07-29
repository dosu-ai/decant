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

export function sessionPageExhausted({
  receivedRows,
  requestedRows,
}: {
  receivedRows: number;
  requestedRows: number;
}): boolean {
  return requestedRows > 0 && receivedRows < requestedRows;
}
