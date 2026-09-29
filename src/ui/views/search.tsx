import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getJson } from "../api.ts";
import { ApiFailureState } from "../api-failure.tsx";
import { Badge } from "../badges.tsx";
import { EmptyState } from "../common.tsx";
import { basename, formatInt, shortDate } from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link, updateSearchRoute, visit } from "../link.tsx";
import { readRecentSearches, rememberSearch } from "../recent-searches.ts";
import { exactSearchRemaining, searchPageMayHaveMore } from "../search-pagination.ts";
import { searchRequestScope } from "../search-request.ts";
import { searchSnippetParts, visuallyOrderedSearchHits } from "../search-results.ts";
import type { DateRangeSelection, SearchHit, SearchResponse } from "../types.ts";

export function SearchView({ dateRange, path }: { dateRange: DateRangeSelection; path: string }) {
  const pageSize = 25;
  const initialQuery = new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [totalIsCapped, setTotalIsCapped] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [retryKey, setRetryKey] = useState(0);
  const [recentSearches, setRecentSearches] = useState(readRecentSearches);
  const searchEpochRef = useRef(0);
  const resultsQueryRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const hitsLengthRef = useRef(0);
  const totalRef = useRef<number | null>(null);
  const totalIsCappedRef = useRef(false);
  hitsLengthRef.current = hits.length;
  totalRef.current = total;
  totalIsCappedRef.current = totalIsCapped;
  const rangeFrom = dateRange.from;
  const rangeTo = dateRange.to;
  const requestScope = useMemo(
    () => searchRequestScope(path, { from: rangeFrom, to: rangeTo }),
    [path, rangeFrom, rangeTo],
  );
  const requestScopeKey = JSON.stringify(requestScope);

  useLayoutEffect(() => {
    void requestScopeKey;
    searchEpochRef.current += 1;
    resultsQueryRef.current = null;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setHits([]);
    setTotal(null);
    totalRef.current = null;
    setTotalIsCapped(false);
    totalIsCappedRef.current = false;
    setHasMore(false);
    setElapsedMs(0);
    setActiveIndex(-1);
    setQuery(initialQuery);
    return () => {
      loadMoreControllerRef.current?.abort();
    };
  }, [initialQuery, requestScopeKey]);

  useEffect(() => {
    const epoch = searchEpochRef.current + 1;
    searchEpochRef.current = epoch;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    const trimmed = query.trim();
    void retryKey;
    if (trimmed.length < 2) {
      resultsQueryRef.current = null;
      setHits([]);
      setTotal(null);
      totalRef.current = null;
      setTotalIsCapped(false);
      totalIsCappedRef.current = false;
      setHasMore(false);
      setElapsedMs(0);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getJson<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: trimmed,
          include_subagents: true,
          include_total: false,
          limit: pageSize,
          offset: 0,
          ...requestScope,
        }),
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted || searchEpochRef.current !== epoch) {
            return;
          }
          setHits(response.results);
          setHasMore(
            searchPageMayHaveMore({
              lastPageSize: response.results.length,
              loaded: response.results.length,
              pageSize,
              total: totalRef.current,
              totalIsCapped: totalIsCappedRef.current,
            }),
          );
          setElapsedMs(response.elapsed_ms);
          setActiveIndex(response.results.length > 0 ? 0 : -1);
          resultsQueryRef.current = trimmed;
          setRecentSearches(rememberSearch(trimmed));
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted && searchEpochRef.current === epoch) {
            setError(err);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && searchEpochRef.current === epoch) {
            setSearching(false);
          }
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, requestScope, retryKey]);

  useEffect(() => {
    const trimmed = query.trim();
    void retryKey;
    if (trimmed.length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const epoch = searchEpochRef.current;
      void getJson<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: trimmed,
          include_subagents: true,
          include_total: true,
          limit: 1,
          offset: 0,
          ...requestScope,
        }),
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted || searchEpochRef.current !== epoch) {
            return;
          }
          totalRef.current = response.total;
          totalIsCappedRef.current = response.total_is_capped;
          setTotal(response.total);
          setTotalIsCapped(response.total_is_capped);
          setHasMore(
            searchPageMayHaveMore({
              lastPageSize: 0,
              loaded: hitsLengthRef.current,
              pageSize,
              total: response.total,
              totalIsCapped: response.total_is_capped,
            }),
          );
        })
        .catch(() => {
          // A count is supplementary; keep the fast ranked results usable when
          // the slower total request is interrupted or unavailable.
        });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, requestScope, retryKey]);

  const orderedHits = visuallyOrderedSearchHits(hits);
  const groups = groupSearchHits(orderedHits);
  const exactRemaining = exactSearchRemaining(total, hits.length, totalIsCapped);
  const activeHit = activeIndex < 0 ? null : (orderedHits[activeIndex] ?? null);
  const activeHitId = activeHit == null ? undefined : `search-hit-${activeHit.block_id}`;
  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  const loadMore = () => {
    const trimmed = query.trim();
    if (searching || !hasMore || trimmed.length < 2) {
      return;
    }
    setSearching(true);
    setError(null);
    const epoch = searchEpochRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    void getJson<SearchResponse>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: trimmed,
        include_subagents: true,
        include_total: false,
        limit: pageSize,
        offset: hits.length,
        ...requestScope,
      }),
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted || searchEpochRef.current !== epoch) {
          return;
        }
        const loaded = hits.length + response.results.length;
        setHits((current) => [...current, ...response.results]);
        setHasMore(
          searchPageMayHaveMore({
            lastPageSize: response.results.length,
            loaded,
            pageSize,
            total: totalRef.current,
            totalIsCapped: totalIsCappedRef.current,
          }),
        );
        setElapsedMs(response.elapsed_ms);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted && searchEpochRef.current === epoch) {
          setError(err);
        }
      })
      .finally(() => {
        if (loadMoreControllerRef.current === controller) {
          loadMoreControllerRef.current = null;
        }
        if (!controller.signal.aborted && searchEpochRef.current === epoch) {
          setSearching(false);
        }
      });
  };

  return (
    <div className="search-page">
      <header className="page-heading">
        <h1>Search</h1>
        <p>Full-text search across every message and tool call in your session logs.</p>
      </header>

      <form className="search-form" onSubmit={(event) => event.preventDefault()}>
        <Icon name="search" />
        <input
          aria-activedescendant={activeHitId}
          aria-autocomplete="list"
          aria-busy={searching}
          aria-controls="search-results-listbox"
          aria-expanded={orderedHits.length > 0}
          autoComplete="off"
          onChange={(event) => {
            searchEpochRef.current += 1;
            resultsQueryRef.current = null;
            loadMoreControllerRef.current?.abort();
            loadMoreControllerRef.current = null;
            setHits([]);
            setTotal(null);
            totalRef.current = null;
            setTotalIsCapped(false);
            totalIsCappedRef.current = false;
            setHasMore(false);
            setElapsedMs(0);
            setActiveIndex(-1);
            setSearching(event.target.value.trim().length >= 2);
            updateSearchRoute(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && orderedHits.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1 + orderedHits.length) % orderedHits.length);
            } else if (event.key === "ArrowUp" && orderedHits.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + orderedHits.length) % orderedHits.length);
            } else if (
              event.key === "Enter" &&
              !searching &&
              activeHit != null &&
              resultsQueryRef.current === query.trim()
            ) {
              event.preventDefault();
              visit(activeHit.href);
            } else if (event.key === "Escape") {
              event.preventDefault();
              updateSearchRoute("");
            }
          }}
          placeholder="Search across all sessions and tool calls..."
          role="combobox"
          value={query}
        />
      </form>

      {query.trim().length >= 2 && (searching || hits.length > 0 || total != null) ? (
        <p className="result-caption">
          {total == null
            ? hits.length === 0
              ? "Finding matches"
              : `Showing ${formatInt(hits.length)} matches`
            : `${formatInt(total)}${totalIsCapped ? "+" : ""} ${
                total === 1 ? "result" : "results"
              }`}{" "}
          · {formatSearchTime(elapsedMs)}
        </p>
      ) : null}
      {error != null ? (
        <ApiFailureState error={error} onRetry={() => setRetryKey((key) => key + 1)} />
      ) : null}

      <div className="search-results">
        {searching && hits.length === 0 ? <div className="searching-state">Searching…</div> : null}
        {!searching && query.trim().length < 2 ? (
          <EmptyState
            action={
              recentSearches.length > 0 ? (
                <div className="recent-searches">
                  {recentSearches.map((recent) => (
                    <button
                      className="secondary-button"
                      key={recent}
                      onClick={() => updateSearchRoute(recent)}
                      type="button"
                    >
                      {recent}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
            icon="search"
            message="Type at least two characters to search messages, tools, and sessions."
            title="Search your session logs"
          />
        ) : null}
        {!searching && query.trim().length >= 2 && hits.length === 0 ? (
          <EmptyState
            action={
              <button
                className="secondary-button"
                onClick={() => updateSearchRoute("")}
                type="button"
              >
                Clear search
              </button>
            }
            icon="inbox"
            message="Nothing matched your search. Try a different term."
            title="No matches"
          />
        ) : null}
        <div aria-label="Search results" id="search-results-listbox" role="listbox">
          {groups.map((group) => (
            <section className="search-result-group" key={group.sessionId} role="presentation">
              <header className="search-group-heading">
                <div className="search-group-title">
                  <strong>{group.title}</strong>
                  <span>{basename(group.project)}</span>
                </div>
                <span>{shortDate(group.timestamp ?? "")}</span>
              </header>
              <div role="presentation">
                {group.hits.map((hit) => {
                  const index = orderedHits.indexOf(hit);
                  return (
                    <Link
                      aria-current={index === activeIndex ? "true" : undefined}
                      aria-selected={index === activeIndex}
                      className="result-card search-hit-row"
                      data-search-index={index}
                      href={hit.href}
                      id={`search-hit-${hit.block_id}`}
                      key={hit.block_id}
                      onMouseEnter={() => setActiveIndex(index)}
                      role="option"
                    >
                      <div className="result-card-heading">
                        <Badge tone="neutral">{searchHitLabel(hit)}</Badge>
                        <span>message {hit.message_seq}</span>
                      </div>
                      <p>
                        <HighlightedSnippet snippet={hit.snippet} />
                      </p>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        {hasMore ? (
          <button
            className="secondary-button search-load-more"
            disabled={searching}
            onClick={loadMore}
            type="button"
          >
            {searching
              ? "Loading…"
              : exactRemaining == null
                ? "Load more"
                : `Load more · ${formatInt(exactRemaining)} remaining`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function groupSearchHits(hits: SearchHit[]) {
  const groups = new Map<
    number,
    {
      hits: SearchHit[];
      project: string | null;
      sessionId: number;
      timestamp: string | null;
      title: string;
    }
  >();
  for (const hit of hits) {
    const group = groups.get(hit.session_id);
    if (group == null) {
      groups.set(hit.session_id, {
        hits: [hit],
        project: hit.project,
        sessionId: hit.session_id,
        timestamp: hit.timestamp,
        title: hit.session_title ?? `Session ${hit.session_id}`,
      });
    } else {
      group.hits.push(hit);
    }
  }
  return [...groups.values()];
}

export function searchHitLabel(hit: SearchHit): string {
  if (hit.block_type === "tool_use") {
    return hit.tool === "" ? "tool call" : hit.tool;
  }
  return hit.role === "" ? hit.block_type : hit.role;
}

export function formatSearchTime(elapsedMs: number): string {
  return elapsedMs < 1 ? "<1 ms" : `${Math.round(elapsedMs)} ms`;
}

export function HighlightedSnippet({ snippet }: { snippet: string }) {
  return (
    <>
      {searchSnippetParts(snippet).map((part) =>
        part.match ? (
          <mark key={part.key}>{part.text}</mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </>
  );
}
