import { SESSION_LIST_MAX_LIMIT } from "../api-limits.ts";

export type SessionLoadPlan = {
  limit: number;
  offset: number;
  page: number;
};

const NEXT_PAGE_PROBE_ROWS = 1;

export function planSessionPageLoad({
  page,
  pageSize,
}: {
  page: number;
  pageSize: number;
}): SessionLoadPlan {
  const requestedPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const normalizedPageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 1;
  const candidateOffset = (requestedPage - 1) * normalizedPageSize;
  const offset = Number.isSafeInteger(candidateOffset) ? candidateOffset : 0;
  const normalizedPage = offset === candidateOffset ? requestedPage : 1;
  const limit = Math.min(SESSION_LIST_MAX_LIMIT, normalizedPageSize + NEXT_PAGE_PROBE_ROWS);
  return { limit, offset, page: normalizedPage };
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
