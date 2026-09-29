import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getJson } from "./api.ts";
import {
  buildCommandPaletteGroups,
  type CommandPaletteItem,
  flattenCommandPaletteItems,
  pointerMovementChangesSelection,
  reconcileCommandPaletteActiveIndex,
  reduceCommandPaletteKey,
} from "./command-palette.ts";
import { fullDateTime } from "./date-time.ts";
import { useDialogFocusTrap } from "./focus.ts";
import {
  createSessionSearchIndex,
  type SessionHighlightRange,
  type SessionHighlights,
  type SessionSearchIndex,
  type SessionSearchIndexRow,
} from "./fuzzy.ts";
import { Icon } from "./icons.tsx";
import { locationPath } from "./link.tsx";
import { navItems } from "./nav-items.ts";
import { readRecentSearches, rememberSearch } from "./recent-searches.ts";
import { searchRouteHref } from "./search-request.ts";
import type { IconName } from "./types.ts";

export type PaletteItemKind = "recent" | "session" | "page" | "action" | "content-search";

export interface PaletteItem extends CommandPaletteItem {
  activate: () => void;
  detail?: string;
  highlights?: SessionHighlights;
  icon: IconName;
  kind: PaletteItemKind;
  row?: SessionSearchIndexRow;
}

export function CommandPalette({
  open,
  refreshKey,
  ...dialogProps
}: {
  analyticsReportHref: string;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onRunSync: () => void;
  onToggleTheme: () => void;
  open: boolean;
  refreshKey: number;
  syncing: boolean;
}) {
  const [rows, setRows] = useState<SessionSearchIndexRow[]>([]);
  const [loadedRefreshKey, setLoadedRefreshKey] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [indexError, setIndexError] = useState<unknown>(null);

  useEffect(() => {
    if (!open || loadedRefreshKey === refreshKey) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setIndexError(null);
    void getJson<SessionSearchIndexRow[]>("/api/sessions/search-index", {
      signal: controller.signal,
    })
      .then((nextRows) => {
        if (controller.signal.aborted) {
          return;
        }
        setRows(nextRows);
        setLoadedRefreshKey(refreshKey);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setIndexError(error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [loadedRefreshKey, open, refreshKey]);

  const fuzzyIndex: SessionSearchIndex = useMemo(() => createSessionSearchIndex(rows), [rows]);

  // The index survives here across open and close; only the dialog body, which
  // builds every item on each render, is unmounted while the palette is shut.
  return open ? (
    <CommandPaletteDialog
      {...dialogProps}
      fuzzyIndex={fuzzyIndex}
      indexError={indexError}
      loading={loading}
      rows={rows}
    />
  ) : null;
}

export function CommandPaletteDialog({
  analyticsReportHref,
  fuzzyIndex,
  indexError,
  loading,
  onClose,
  onNavigate,
  onRunSync,
  onToggleTheme,
  rows,
  syncing,
}: {
  analyticsReportHref: string;
  fuzzyIndex: SessionSearchIndex;
  indexError: unknown;
  loading: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onRunSync: () => void;
  onToggleTheme: () => void;
  rows: SessionSearchIndexRow[];
  syncing: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);
  const activeItemIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const listboxId = useId();
  closeRef.current = onClose;
  const requestClose = useCallback(() => closeRef.current(), []);
  useDialogFocusTrap(true, dialogRef, requestClose);

  const normalizedQuery = query.trim();
  const matches = useMemo(
    () => (normalizedQuery === "" ? [] : fuzzyIndex.search(normalizedQuery, 10)),
    [fuzzyIndex, normalizedQuery],
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const recentItems: PaletteItem[] = recentSearches.map((recent) => ({
    id: `recent:${recent}`,
    label: recent,
    detail: "Search transcript content",
    icon: "clock",
    kind: "recent",
    activate: () => {
      rememberSearch(recent);
      onNavigate(searchRouteHref(recent, locationPath()));
    },
  }));
  const sessionMatches =
    normalizedQuery === ""
      ? rows.slice(0, 6).map((row) => ({ id: row.id, highlights: {} }))
      : matches;
  const sessionItems: PaletteItem[] = sessionMatches.flatMap((match) => {
    const row = rowById.get(match.id);
    if (row == null) {
      return [];
    }
    return [
      {
        id: `session:${row.id}`,
        label: row.title?.trim() || `Session ${row.id}`,
        detail: paletteSessionDetail(row),
        highlights: match.highlights,
        icon: "sessions",
        kind: "session",
        row,
        activate: () => onNavigate(`/sessions/${row.id}`),
      },
    ];
  });
  const pageItems: PaletteItem[] = navItems
    .filter((item) => commandPaletteTextMatches(normalizedQuery, item.label))
    .map((item) => ({
      id: `page:${item.key}`,
      label: item.label,
      detail: item.href,
      icon: item.icon,
      kind: "page",
      activate: () => onNavigate(item.href),
    }));
  const availableActions: PaletteItem[] = [
    ...(syncing
      ? []
      : [
          {
            id: "action:sync",
            label: "Run sync",
            detail: "Ingest changed local session logs",
            icon: "refresh" as const,
            kind: "action" as const,
            activate: onRunSync,
          },
        ]),
    {
      id: "action:theme",
      label: "Toggle theme",
      detail: "Cycle system, light, and dark",
      icon: "sun",
      kind: "action",
      activate: () => {
        onToggleTheme();
        requestClose();
      },
    },
    {
      id: "action:report",
      label: "Analytics report",
      detail: "Review and export the active date range",
      icon: "chart",
      kind: "action",
      activate: () => onNavigate(analyticsReportHref),
    },
    {
      id: "action:settings",
      label: "Settings",
      detail: "Agent, terminal, and editor preferences",
      icon: "settings",
      kind: "action",
      activate: () => onNavigate("/settings"),
    },
  ];
  const actionItems = availableActions.filter((item) =>
    commandPaletteTextMatches(normalizedQuery, `${item.label} ${item.detail ?? ""}`),
  );
  const contentSearch: PaletteItem | null =
    normalizedQuery === ""
      ? null
      : {
          id: "content-search",
          label: `Search transcript content for “${normalizedQuery}”`,
          detail: "Messages, tool calls, and results",
          icon: "search",
          kind: "content-search",
          activate: () => {
            const remembered = rememberSearch(normalizedQuery);
            setRecentSearches(remembered);
            onNavigate(searchRouteHref(normalizedQuery, locationPath()));
          },
        };
  const groups = buildCommandPaletteGroups({
    query,
    recent: recentItems,
    sessions: sessionItems,
    pages: pageItems,
    actions: actionItems,
    contentSearch,
  });
  const items = flattenCommandPaletteItems(groups);
  const renderedItemKey = items.map((item) => item.id).join("\u0000");

  useLayoutEffect(() => {
    void renderedItemKey;
    const nextIndex = reconcileCommandPaletteActiveIndex(activeItemIdRef.current, items);
    activeItemIdRef.current = nextIndex == null ? null : (items[nextIndex]?.id ?? null);
    setActiveIndex(nextIndex);
  }, [items, renderedItemKey]);

  const selectPaletteIndex = (index: number | null) => {
    const nextIndex = index != null && items[index] != null ? index : null;
    activeItemIdRef.current = nextIndex == null ? null : (items[nextIndex]?.id ?? null);
    setActiveIndex(nextIndex);
  };

  useEffect(() => {
    if (activeIndex == null) {
      return;
    }
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const renderedActiveIndex =
    activeIndex != null && items[activeIndex] != null ? activeIndex : null;
  const activeItem = renderedActiveIndex == null ? null : (items[renderedActiveIndex] ?? null);
  const activeDescendant =
    renderedActiveIndex == null ? undefined : `command-palette-item-${renderedActiveIndex}`;
  const quickMatchCount = sessionItems.length + pageItems.length + actionItems.length;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="command-palette"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="sr-only" id={titleId}>
          Search and commands
        </h2>
        <div className="command-palette-input-row">
          <Icon name="search" />
          <input
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={true}
            aria-label="Search sessions and commands"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const result = reduceCommandPaletteKey(
                { activeIndex },
                {
                  key: event.key,
                  itemCount: items.length,
                  isComposing: event.nativeEvent.isComposing,
                },
              );
              if (!result.handled) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              if (result.effect === "close") {
                requestClose();
                return;
              }
              if (result.effect === "activate") {
                activeItem?.activate();
                return;
              }
              selectPaletteIndex(result.activeIndex);
            }}
            placeholder="Search sessions or run a command…"
            role="combobox"
            value={query}
          />
          <button
            aria-label="Close command palette"
            className="icon-button command-palette-close"
            onClick={requestClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
        <div aria-live="polite" className="command-palette-state-region">
          {loading && rows.length === 0 ? (
            <p className="command-palette-state" role="status">
              Loading session index…
            </p>
          ) : null}
          {indexError != null && rows.length === 0 ? (
            <p className="command-palette-state is-error" role="status">
              Session shortcuts are unavailable. Pages and actions still work.
            </p>
          ) : null}
          {normalizedQuery !== "" && quickMatchCount === 0 && !loading && indexError == null ? (
            <p className="command-palette-state">No quick matches. Try transcript search below.</p>
          ) : null}
        </div>
        <div className="command-palette-results" id={listboxId} role="listbox">
          {groups.map((group) => {
            const labelId = `${listboxId}-${group.id}-label`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: fieldset is not a valid listbox child; this div is an explicit ARIA group.
              <div
                aria-labelledby={labelId}
                className={`command-palette-group is-${group.id}`}
                key={group.id}
                role="group"
              >
                <div
                  className={group.label == null ? "sr-only" : "command-palette-group-label"}
                  id={labelId}
                >
                  {group.label ?? "Transcript search"}
                </div>
                {group.items.map((item) => {
                  const index = items.indexOf(item);
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is owned by the combobox through aria-activedescendant.
                    <div
                      aria-selected={index === activeIndex}
                      className={`command-palette-item is-${item.kind}${
                        index === activeIndex ? " is-active" : ""
                      }`}
                      data-palette-index={index}
                      id={`command-palette-item-${index}`}
                      key={item.id}
                      onClick={() => item.activate()}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={(event) => {
                        if (pointerMovementChangesSelection(event)) {
                          selectPaletteIndex(index);
                        }
                      }}
                      role="option"
                      tabIndex={-1}
                    >
                      <span className="command-palette-item-icon">
                        <Icon name={item.icon} />
                      </span>
                      <span className="command-palette-item-copy">
                        <strong>
                          <PaletteHighlightedText
                            ranges={item.highlights?.title}
                            text={item.label}
                          />
                        </strong>
                        {item.kind === "session" && item.row != null ? (
                          <PaletteSessionMeta highlights={item.highlights} row={item.row} />
                        ) : item.detail == null ? null : (
                          <span>{item.detail}</span>
                        )}
                      </span>
                      {item.kind === "session" && item.row?.started_at != null ? (
                        <time
                          className="command-palette-item-date"
                          dateTime={item.row.started_at}
                          title={fullDateTime(item.row.started_at) ?? item.row.started_at}
                        >
                          <PaletteHighlightedText
                            ranges={item.highlights?.started_at}
                            text={item.row.started_at.slice(0, 10)}
                          />
                        </time>
                      ) : item.kind === "content-search" ? (
                        <kbd>↵</kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer className="command-palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function commandPaletteTextMatches(query: string, text: string): boolean {
  if (query === "") {
    return true;
  }
  const lower = text.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((term) => lower.includes(term));
}

export function paletteSessionDetail(row: SessionSearchIndexRow): string {
  return [row.project, row.tool, row.model]
    .filter((value) => value != null && value !== "")
    .join(" · ");
}

export function PaletteSessionMeta({
  highlights,
  row,
}: {
  highlights: SessionHighlights | undefined;
  row: SessionSearchIndexRow;
}) {
  const values = [
    { field: "project" as const, value: row.project },
    { field: "tool" as const, value: row.tool },
    { field: "model" as const, value: row.model },
  ].filter(
    (entry): entry is { field: "project" | "tool" | "model"; value: string } =>
      entry.value != null && entry.value !== "",
  );
  return (
    <span>
      {values.map((entry, index) => (
        <span key={entry.field}>
          {index > 0 ? " · " : null}
          <PaletteHighlightedText ranges={highlights?.[entry.field]} text={entry.value} />
        </span>
      ))}
    </span>
  );
}

export function PaletteHighlightedText({
  ranges,
  text,
}: {
  ranges: readonly SessionHighlightRange[] | undefined;
  text: string;
}) {
  if (ranges == null || ranges.length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    const [start, end] = range;
    if (start > cursor) {
      parts.push(<span key={`text-${index}`}>{text.slice(cursor, start)}</span>);
    }
    parts.push(<mark key={`match-${index}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(<span key="text-tail">{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}
