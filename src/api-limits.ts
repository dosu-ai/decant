export const SESSION_LIST_MAX_LIMIT = 100;
export const USAGE_LIST_MAX_LIMIT = 1000;

/** Messages in a transcript page when `message_limit` is omitted or zero. */
export const SESSION_MESSAGE_PAGE_DEFAULT = 200;
/** Most messages one transcript request returns; callers page beyond it. */
export const SESSION_MESSAGE_PAGE_MAX = 2000;
/** Most rows one search-index request returns, and the default page size. */
export const SEARCH_INDEX_PAGE_MAX = 5000;
