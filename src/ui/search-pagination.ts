export interface SearchPageAvailability {
  lastPageSize: number;
  loaded: number;
  pageSize: number;
  total: number | null;
  totalIsCapped?: boolean;
}

/**
 * A total is supplementary to ranked search results. When it is unavailable,
 * a full page is sufficient evidence to offer another page; an exact multiple
 * may require one final empty probe to establish the end.
 */
export function searchPageMayHaveMore(input: SearchPageAvailability): boolean {
  if (input.total != null && input.loaded < input.total) {
    return true;
  }
  if (input.total != null && input.totalIsCapped !== true) {
    return false;
  }
  return input.lastPageSize === input.pageSize;
}

/** Return an exact remaining count only when the server supplied an exact total. */
export function exactSearchRemaining(
  total: number | null,
  loaded: number,
  totalIsCapped: boolean,
): number | null {
  return total == null || totalIsCapped ? null : Math.max(0, total - loaded);
}
