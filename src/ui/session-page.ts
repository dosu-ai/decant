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
  const scopeKey = JSON.stringify([dateQuery, project, includeArchived, reloadKey]);
  const requestKey = `${scopeKey}:${page}`;
  const cached = cacheRef.current.get(requestKey) ?? null;
  const visible = cached ?? (settled.loaded?.scopeKey === scopeKey ? settled.loaded : null);
  const currentError = settled.failed?.requestKey === requestKey ? settled.failed.error : null;
  const loading = enabled && cached == null && currentError == null;

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
    sessions: visible?.sessions ?? [],
  };
}
