import { SESSION_LIST_MAX_LIMIT } from "../api-limits.ts";

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
  const desiredRows = Math.max(sessionLimit, pageSize);
  const remainingRows = desiredRows - offset;
  const limit = Math.min(SESSION_LIST_MAX_LIMIT, Math.max(0, remainingRows));
  if (limit <= 0) {
    return null;
  }
  return { limit, offset, replace: refreshFirstPage };
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
