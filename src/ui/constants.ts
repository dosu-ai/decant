export const SESSION_PAGE_SIZE = 50;

// The Files view refetches with filters but must match the route slice's page of rows.
export const TABLE_ROW_LIMIT = 100;

export const SESSION_DETAIL_MESSAGE_PAGE_SIZE = 160;

export const SESSION_TABLE_SKELETON_KEYS = Array.from(
  { length: SESSION_PAGE_SIZE },
  (_, index) => `session-row-skeleton-${index}`,
);

export const EMPTY_SESSION_IDS = new Set<number>();

export const SESSION_PAGE_CACHE_LIMIT = 12;
