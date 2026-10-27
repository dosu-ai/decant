import { useEffect, useRef, useState } from "react";
import { getJson } from "./api.ts";
import { SESSION_PAGE_CACHE_LIMIT, SESSION_PAGE_SIZE } from "./constants.ts";
import { withDateQuery } from "./date-range.ts";
import { planSessionPageLoad, sessionPageExhausted } from "./loading-state.ts";
import type { LoadedSessionPage, SessionPageState, SessionSummary } from "./types.ts";

export function rememberSessionPage(
  cache: Map<string, LoadedSessionPage>,
  page: LoadedSessionPage,
): void {
  cache.delete(page.requestKey);
  cache.set(page.requestKey, page);
  while (cache.size > SESSION_PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest == null) {
      return;
    }
    cache.delete(oldest);
  }
}

/**
 * Chooses the rows to show for a page request. A reload of the same scope
 * (Update, a finished sync, or a live Sessions refresh) keeps the rows already
 * on screen until the new page arrives, so the table never drops back to a
 * skeleton while someone is reading it. Re-showing the requested page's own
 * rows is not loading, but another page's rows still are, so pagination stays
 * busy until the page asked for arrives. Rows from a different scope (date
 * range, project, archive toggle) are never shown.
 */
export function sessionPageView({
  cached,
  currentError,
  enabled,
  page,
  scopeKey,
  settled,
}: {
  cached: LoadedSessionPage | null;
  currentError: unknown;
  enabled: boolean;
  page: number;
  scopeKey: string;
  settled: LoadedSessionPage | null;
}): { loading: boolean; refreshing: boolean; visible: LoadedSessionPage | null } {
  const visible = cached ?? (settled?.scopeKey === scopeKey ? settled : null);
  const revalidating = cached == null && visible?.page === page;
  const fetching = enabled && cached == null && currentError == null;
  return { loading: fetching && !revalidating, refreshing: fetching && revalidating, visible };
}

/**
 * How a failed page load shows. A failed reload of the page already on screen,
 * such as a live refresh that hit a transient error, keeps those rows under a
 * notice instead of replacing what someone is reading with an error screen.
 * Any other failure has no rows of its own to show.
 */
export function sessionPageFailure(
  state: Pick<SessionPageState, "error" | "loadedPage" | "sessions">,
  page: number,
): "notice" | "replace" | null {
  if (state.error == null) {
    return null;
  }
  return state.loadedPage === page && state.sessions.length > 0 ? "notice" : "replace";
}

export function useSessionPage({
  dateQuery,
  enabled,
  includeArchived,
  page,
  project,
  reloadKey,
}: {
  dateQuery: string;
  enabled: boolean;
  includeArchived: boolean;
  page: number;
  project: string | null;
  reloadKey: number;
}): SessionPageState {
  const cacheRef = useRef(new Map<string, LoadedSessionPage>());
  const [settled, setSettled] = useState<{
    failed: { error: unknown; requestKey: string } | null;
    loaded: LoadedSessionPage | null;
  }>({ failed: null, loaded: null });
  const scopeKey = JSON.stringify([dateQuery, project, includeArchived]);
  const requestKey = `${scopeKey}:${page}:${reloadKey}`;
  const cached = cacheRef.current.get(requestKey) ?? null;
  const currentError = settled.failed?.requestKey === requestKey ? settled.failed.error : null;
  const { loading, refreshing, visible } = sessionPageView({
    cached,
    currentError,
    enabled,
    page,
    scopeKey,
    settled: settled.loaded,
  });

  useEffect(() => {
    if (!enabled || cacheRef.current.has(requestKey)) {
      return;
    }
    const controller = new AbortController();
    const plan = planSessionPageLoad({ page, pageSize: SESSION_PAGE_SIZE });
    const projectParam = project == null ? "" : `&project=${encodeURIComponent(project)}`;
    const archivedParam = includeArchived ? "&include_archived=true" : "";
    void getJson<SessionSummary[]>(
      withDateQuery(
        `/api/sessions?limit=${plan.limit}&offset=${plan.offset}` +
          `&with_subagents=true${projectParam}${archivedParam}`,
        dateQuery,
      ),
      { signal: controller.signal },
    )
      .then((sessions) => {
        const loaded: LoadedSessionPage = {
          exhausted: sessionPageExhausted({
            receivedRows: sessions.length,
            requestedRows: plan.limit,
          }),
          page: plan.page,
          requestKey,
          scopeKey,
          sessions: sessions.slice(0, SESSION_PAGE_SIZE),
        };
        rememberSessionPage(cacheRef.current, loaded);
        setSettled({ failed: null, loaded });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled((current) => ({ ...current, failed: { error, requestKey } }));
      });
    return () => controller.abort();
  }, [dateQuery, enabled, includeArchived, page, project, requestKey, scopeKey]);

  return {
    error: currentError,
    exhausted: visible?.exhausted ?? false,
    loadedPage: visible?.page ?? null,
    loading,
    refreshing,
    sessions: visible?.sessions ?? [],
  };
}
