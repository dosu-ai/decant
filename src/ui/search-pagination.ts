export interface SearchPageAvailability {
  lastPageSize: number;
  loaded: number;
  pageSize: number;
  total: number | null;
  totalIsCapped?: boolean;
}

export function searchPageMayHaveMore(input: SearchPageAvailability): boolean {
  if (input.total != null && input.loaded < input.total) {
    return true;
  }
  if (input.total != null && input.totalIsCapped !== true) {
    return false;
  }
  return input.lastPageSize === input.pageSize;
}

export function exactSearchRemaining(
  total: number | null,
  loaded: number,
  totalIsCapped: boolean,
): number | null {
  return total == null || totalIsCapped ? null : Math.max(0, total - loaded);
}
