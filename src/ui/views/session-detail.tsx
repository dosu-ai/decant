import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { getJson } from "../api.ts";
import { ApiFailureState } from "../api-failure.tsx";
import { Badge, ModelBadge, ReasoningBadge, ToolBadge } from "../badges.tsx";
import { OverflowMenu } from "../common.tsx";
import { SESSION_DETAIL_MESSAGE_PAGE_SIZE } from "../constants.ts";
import { ContextWindowPanel } from "../context-window-strip.tsx";
import { useDialogFocusTrap } from "../focus.ts";
import { basename, compact, errorMessage, formatInt, money } from "../format.ts";
import { Icon } from "../icons.tsx";
import { formatIssueBadge, unknownRecordTypeSummary } from "../ingest-issues.ts";
import { Link, visit } from "../link.tsx";
import { projectSessionsHref, sessionsArchivedHref } from "../navigation.ts";
import {
  ReportExportButton,
  SESSION_REPORT_INCLUDES,
  SESSION_REPORT_NEVER_INCLUDES,
} from "../report-export.tsx";
import {
  archiveActionFor,
  DELETE_SESSION_EXPLANATION,
  DELETE_SESSION_EYEBROW,
  type SessionStateUpdate,
  sessionStateRequest,
} from "../session-state.ts";
import { sessionDisplayTitle } from "../session-title.ts";
import { ThreadTocEntry, threadStats, threadToc, threadTocFromOutline } from "../thread-toc.tsx";
import {
  countSubagentRuns,
  messageKey,
  nearestTranscriptSeq,
  renderableMessages,
  scrollTranscriptMessage,
  subagentMap,
  TranscriptTurn,
} from "../transcript.tsx";
import {
  hasOpenModal,
  isInteractiveTarget,
  nextTranscriptSeq,
  type TranscriptNavigationDirection,
  transcriptNavigationDirection,
  transcriptSeqFromHash,
} from "../transcript-navigation.ts";
import {
  appendTranscriptPage,
  prependTranscriptPage,
  previousTranscriptPageRequest,
  runWithTranscriptRequestSlot,
  transcriptPrefixRequest,
} from "../transcript-pagination.ts";
import type {
  ContextWindowTimelineData,
  SessionDetailData,
  SessionIngestIssue,
  SessionOutlineItemData,
  TokenEconomics,
} from "../types.ts";
import { TokenEconomicsPanel } from "./analytics.tsx";
import { DosuProvenanceBadge } from "./sessions.tsx";

export function DeleteSessionDialog({
  error,
  onClose,
  onConfirm,
  open,
  pending,
  title,
}: {
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
  title: string;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => onCloseRef.current(), []);
  useDialogFocusTrap(open, dialogRef, requestClose);
  if (!open) {
    return null;
  }
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and explicit Cancel/close controls.
    <div
      className="report-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) {
          requestClose();
        }
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="report-review-sheet session-delete-dialog"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="section-eyebrow">{DELETE_SESSION_EYEBROW}</span>
            <h2 id={titleId}>Delete session?</h2>
          </div>
          <button
            aria-label="Close delete confirmation"
            className="icon-button"
            disabled={pending}
            onClick={requestClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="report-review-body">
          <p className="session-delete-title">{title}</p>
          <p className="session-delete-copy" id={descriptionId}>
            {DELETE_SESSION_EXPLANATION}
          </p>
          {error != null ? (
            <div className="notice danger" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <footer>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={requestClose}
            type="button"
          >
            Cancel
          </button>
          <button className="danger-button" disabled={pending} onClick={onConfirm} type="button">
            <Icon name="trash" />
            {pending ? "Deleting…" : "Delete from Decant"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function SessionDetailView({
  id,
  onSync,
  syncing,
}: {
  id: number;
  onSync: () => void;
  syncing: boolean;
}) {
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [outline, setOutline] = useState<SessionOutlineItemData[] | null>(null);
  const [economics, setEconomics] = useState<TokenEconomics | null>(null);
  const [contextWindow, setContextWindow] = useState<ContextWindowTimelineData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [economicsError, setEconomicsError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Separate from loadMoreError: the two loads fail in different places and
  // retry in opposite directions, so one shared message would report a failed
  // backward load at the foot of the transcript under the wrong wording.
  const [loadEarlierError, setLoadEarlierError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [issues, setIssues] = useState<SessionIngestIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<unknown>(null);
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionStatePending, setSessionStatePending] = useState<SessionStateUpdate | null>(null);
  const [sessionStateError, setSessionStateError] = useState<string | null>(null);
  const [sessionStateNotice, setSessionStateNotice] = useState<string | null>(null);
  const [jumpingToSeq, setJumpingToSeq] = useState<number | null>(null);
  const [activeMessageSeq, setActiveMessageSeq] = useState<number | null>(null);
  const detailRef = useRef<SessionDetailData | null>(null);
  const activeMessageSeqRef = useRef<number | null>(null);
  const handledMessageHashRef = useRef<string | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMorePromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionVersionRef = useRef(0);
  const jumpGenerationRef = useRef(0);
  const sessionStateMutationGenerationRef = useRef(0);

  useEffect(() => {
    void id;
    sessionStateMutationGenerationRef.current += 1;
    setDeleteDialogOpen(false);
    setSessionStatePending(null);
    setSessionStateError(null);
    setSessionStateNotice(null);
    return () => {
      sessionStateMutationGenerationRef.current += 1;
    };
  }, [id]);

  useEffect(() => {
    void detailRetryKey;
    const sessionVersion = sessionVersionRef.current + 1;
    sessionVersionRef.current = sessionVersion;
    let cancelled = false;
    setDetail(null);
    detailRef.current = null;
    loadMorePromiseRef.current = null;
    setOutline(null);
    setEconomics(null);
    setContextWindow(null);
    setError(null);
    setEconomicsError(null);
    setLoadingMore(false);
    setLoadMoreError(null);
    setLoadEarlierError(null);
    setShowIssues(false);
    setIssues(null);
    setIssuesError(null);
    setJumpingToSeq(null);
    jumpGenerationRef.current += 1;
    activeMessageSeqRef.current = null;
    handledMessageHashRef.current = null;
    setActiveMessageSeq(null);
    if (!Number.isFinite(id)) {
      setError("Invalid session id.");
      return;
    }
    void getJson<SessionDetailData>(
      `/api/sessions/${id}?message_limit=${SESSION_DETAIL_MESSAGE_PAGE_SIZE}`,
    )
      .then((nextDetail) => {
        if (!cancelled && sessionVersionRef.current === sessionVersion) {
          detailRef.current = nextDetail;
          setDetail(nextDetail);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err);
        }
      });
    void getJson<SessionOutlineItemData[]>(`/api/sessions/${id}/outline`)
      .then((nextOutline) => {
        if (!cancelled && sessionVersionRef.current === sessionVersion) {
          setOutline(nextOutline);
        }
      })
      .catch(() => {
        // The loaded transcript still supplies a progressive outline.
      });
    void getJson<TokenEconomics>(`/api/sessions/${id}/token-economics`)
      .then((nextEconomics) => {
        if (!cancelled) {
          setEconomics(nextEconomics);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEconomicsError(errorMessage(err));
        }
      });
    void getJson<ContextWindowTimelineData>(`/api/sessions/${id}/context-window`)
      .then((nextTimeline) => {
        if (!cancelled) {
          setContextWindow(nextTimeline);
        }
      })
      .catch(() => {
        // The context strip is progressive enhancement; the transcript stands alone.
      });
    return () => {
      cancelled = true;
    };
  }, [detailRetryKey, id]);

  // Ingest issues are fetched lazily, on first expand, rather than eagerly
  // alongside outline/economics/context-window above: most sessions have
  // none, and the raw_line the row can join against is display-local by
  // design (never logged), so there is no reason to pull it over the wire
  // before the user asks to see it.
  useEffect(() => {
    if (!showIssues || issues != null || issuesError != null) {
      return;
    }
    let cancelled = false;
    void getJson<SessionIngestIssue[]>(`/api/sessions/${id}/issues`)
      .then((nextIssues) => {
        if (!cancelled) {
          setIssues(nextIssues);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setIssuesError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, showIssues, issues, issuesError]);

  const loadMoreMessages = useCallback((): Promise<boolean> => {
    if (loadMorePromiseRef.current != null) {
      return loadMorePromiseRef.current;
    }
    const current = detailRef.current;
    if (current == null || current.has_more_messages !== true) {
      return Promise.resolve(false);
    }
    const sessionVersion = sessionVersionRef.current;
    const offset = (current.message_offset ?? 0) + current.messages.length;
    setLoadingMore(true);
    setLoadMoreError(null);
    const request = getJson<SessionDetailData>(
      `/api/sessions/${id}?message_limit=${SESSION_DETAIL_MESSAGE_PAGE_SIZE}&message_offset=${offset}`,
    )
      .then((page) => {
        if (sessionVersionRef.current !== sessionVersion) {
          return false;
        }
        const latest = detailRef.current;
        if (latest == null || latest.summary.id !== id) {
          return false;
        }
        const messages = appendTranscriptPage(latest.messages, page.messages);
        const nextDetail = {
          ...latest,
          messages,
          message_offset: latest.message_offset ?? 0,
          message_limit: SESSION_DETAIL_MESSAGE_PAGE_SIZE,
          has_more_messages: page.has_more_messages === true,
        };
        detailRef.current = nextDetail;
        setDetail(nextDetail);
        return page.has_more_messages === true;
      })
      .catch((err: unknown) => {
        if (sessionVersionRef.current === sessionVersion) {
          setLoadMoreError(errorMessage(err));
        }
        return false;
      })
      .finally(() => {
        if (loadMorePromiseRef.current === request) {
          loadMorePromiseRef.current = null;
        }
        if (sessionVersionRef.current === sessionVersion) {
          setLoadingMore(false);
        }
      });
    loadMorePromiseRef.current = request;
    return request;
  }, [id]);

  /** A deep link, outline click or compaction jump lands mid-session; without this ArrowUp stops at the window's top. */
  const loadPreviousMessages = useCallback((): Promise<boolean> => {
    const sessionVersion = sessionVersionRef.current;
    return runWithTranscriptRequestSlot(
      loadMorePromiseRef,
      () => sessionVersionRef.current === sessionVersion,
      false,
      async () => {
        const current = detailRef.current;
        if (current == null || current.summary.id !== id) {
          return false;
        }
        const request = previousTranscriptPageRequest(
          current.message_offset ?? 0,
          SESSION_DETAIL_MESSAGE_PAGE_SIZE,
        );
        if (request == null) {
          return false;
        }
        setLoadingMore(true);
        setLoadEarlierError(null);
        return getJson<SessionDetailData>(
          `/api/sessions/${id}?message_limit=${request.limit}&message_offset=${request.offset}`,
        )
          .then((page) => {
            if (sessionVersionRef.current !== sessionVersion) {
              return false;
            }
            const latest = detailRef.current;
            if (latest == null || latest.summary.id !== id) {
              return false;
            }
            if (page.messages.length === 0) {
              return false;
            }
            // Browser scroll anchoring does not compensate for prepended turns
            // (measured in Chromium), so the correction below is required.
            // Anchor on a surviving turn rather than scrollHeight: the
            // content-visibility placeholders only estimate their height.
            let anchorSeq: number | null = null;
            let anchorTop: number | null = null;
            for (const message of latest.messages) {
              const top = document
                .getElementById(`message-${message.seq}`)
                ?.getBoundingClientRect().top;
              if (top != null) {
                anchorSeq = message.seq;
                anchorTop = top;
                break;
              }
            }
            const nextDetail = {
              ...latest,
              messages: prependTranscriptPage(latest.messages, page.messages),
              message_offset: request.offset,
            };
            detailRef.current = nextDetail;
            // flushSync so the measurement sees the new DOM and the shifted
            // position is never painted before it is corrected.
            flushSync(() => {
              setDetail(nextDetail);
            });
            if (anchorSeq != null && anchorTop != null) {
              const after = document
                .getElementById(`message-${anchorSeq}`)
                ?.getBoundingClientRect().top;
              if (after != null && after !== anchorTop) {
                window.scrollBy({ behavior: "auto", top: after - anchorTop });
              }
            }
            return true;
          })
          .catch((err: unknown) => {
            if (sessionVersionRef.current === sessionVersion) {
              setLoadEarlierError(errorMessage(err));
            }
            return false;
          })
          .finally(() => {
            if (sessionVersionRef.current === sessionVersion) {
              setLoadingMore(false);
            }
          });
      },
    );
  }, [id]);

  const loadMessageWindow = useCallback(
    async (seq: number): Promise<boolean> => {
      const sessionVersion = sessionVersionRef.current;
      return runWithTranscriptRequestSlot(
        loadMorePromiseRef,
        () => sessionVersionRef.current === sessionVersion,
        false,
        async () => {
          const current = detailRef.current;
          if (current == null || current.summary.id !== id) {
            return false;
          }
          if (
            (current.message_offset ?? 0) === 0 &&
            current.messages.some((message) => message.seq === seq)
          ) {
            return true;
          }
          const request = transcriptPrefixRequest(
            seq,
            current.summary.message_count,
            SESSION_DETAIL_MESSAGE_PAGE_SIZE,
          );
          setLoadingMore(true);
          setLoadMoreError(null);
          return getJson<SessionDetailData>(
            `/api/sessions/${id}?message_limit=${request.limit}&message_offset=${request.offset}`,
          )
            .then((page) => {
              if (sessionVersionRef.current !== sessionVersion) {
                return false;
              }
              // Never trade a populated transcript for an empty one. The clamp
              // above keeps the offset in range against the count we hold, but
              // that count can lag the archive after a re-sync.
              if (page.messages.length === 0) {
                return false;
              }
              const latest = detailRef.current;
              if (latest == null || latest.summary.id !== id) {
                return false;
              }
              const messages =
                (latest.message_offset ?? 0) > 0
                  ? appendTranscriptPage(page.messages, latest.messages)
                  : page.messages;
              const nextDetail = {
                ...page,
                messages,
                message_offset: 0,
                message_limit: request.limit,
                has_more_messages:
                  messages.length < latest.summary.message_count ||
                  page.has_more_messages === true ||
                  latest.has_more_messages === true,
              };
              detailRef.current = nextDetail;
              flushSync(() => {
                setDetail(nextDetail);
              });
              return nextDetail.messages.some((message) => message.seq === seq);
            })
            .catch((err: unknown) => {
              if (sessionVersionRef.current === sessionVersion) {
                setLoadMoreError(errorMessage(err));
              }
              return false;
            })
            .finally(() => {
              if (sessionVersionRef.current === sessionVersion) {
                setLoadingMore(false);
              }
            });
        },
      );
    },
    [id],
  );

  const jumpToMessage = useCallback(
    async (seq: number) => {
      const sessionVersion = sessionVersionRef.current;
      const jumpGeneration = jumpGenerationRef.current + 1;
      jumpGenerationRef.current = jumpGeneration;
      const hash = `#message-${seq}`;
      handledMessageHashRef.current = `${id}:${seq}`;
      window.history.replaceState(null, "", hash);
      setJumpingToSeq(seq);
      try {
        const loaded = await loadMessageWindow(seq);
        if (
          !loaded ||
          sessionVersionRef.current !== sessionVersion ||
          jumpGenerationRef.current !== jumpGeneration
        ) {
          return;
        }
        activeMessageSeqRef.current = seq;
        setActiveMessageSeq(seq);
        requestAnimationFrame(() => {
          if (
            sessionVersionRef.current === sessionVersion &&
            jumpGenerationRef.current === jumpGeneration
          ) {
            scrollTranscriptMessage(
              seq,
              true,
              () =>
                sessionVersionRef.current === sessionVersion &&
                jumpGenerationRef.current === jumpGeneration,
            );
          }
        });
      } finally {
        if (
          sessionVersionRef.current === sessionVersion &&
          jumpGenerationRef.current === jumpGeneration
        ) {
          setJumpingToSeq((current) => (current === seq ? null : current));
        }
      }
    },
    [id, loadMessageWindow],
  );

  const loadedMessageCount = detail?.messages.length ?? 0;
  useEffect(() => {
    if (detail == null) {
      return;
    }
    const followMessageHash = () => {
      const seq = transcriptSeqFromHash(window.location.hash);
      if (seq == null) {
        return;
      }
      const key = `${id}:${seq}`;
      if (handledMessageHashRef.current === key) {
        return;
      }
      handledMessageHashRef.current = key;
      void jumpToMessage(seq);
    };
    followMessageHash();
    window.addEventListener("hashchange", followMessageHash);
    return () => window.removeEventListener("hashchange", followMessageHash);
  }, [detail, id, jumpToMessage]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (
      sentinel == null ||
      loadedMessageCount === 0 ||
      detail?.has_more_messages !== true ||
      loadMoreError != null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreMessages();
        }
      },
      { rootMargin: "700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [detail?.has_more_messages, loadedMessageCount, loadMoreError, loadMoreMessages]);

  const navigateTranscript = useCallback(
    async (direction: TranscriptNavigationDirection) => {
      const sessionVersion = sessionVersionRef.current;
      let current = detailRef.current;
      if (current == null) {
        return;
      }
      let sequences = renderableMessages(current.messages).map((message) => message.seq);
      let activeSeq = activeMessageSeqRef.current;
      if (activeSeq == null || !sequences.includes(activeSeq)) {
        activeSeq = nearestTranscriptSeq(sequences);
      }
      let targetSeq = nextTranscriptSeq(sequences, activeSeq, direction);
      const canLoadForward = direction === 1 && current.has_more_messages === true;
      const canLoadBackward = direction === -1 && (current.message_offset ?? 0) > 0;
      if (targetSeq == null && (canLoadForward || canLoadBackward)) {
        await (canLoadForward ? loadMoreMessages() : loadPreviousMessages());
        if (sessionVersionRef.current !== sessionVersion) {
          return;
        }
        current = detailRef.current;
        sequences =
          current == null
            ? sequences
            : renderableMessages(current.messages).map((message) => message.seq);
        targetSeq = nextTranscriptSeq(sequences, activeSeq, direction);
      }
      if (targetSeq == null) {
        return;
      }
      activeMessageSeqRef.current = targetSeq;
      setActiveMessageSeq(targetSeq);
      handledMessageHashRef.current = `${id}:${targetSeq}`;
      window.history.replaceState(null, "", `#message-${targetSeq}`);
      requestAnimationFrame(() => {
        if (sessionVersionRef.current === sessionVersion) {
          scrollTranscriptMessage(targetSeq);
        }
      });
    },
    [id, loadMoreMessages, loadPreviousMessages],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = transcriptNavigationDirection(event);
      if (
        direction == null ||
        event.repeat ||
        isInteractiveTarget(event.target) ||
        isInteractiveTarget(document.activeElement) ||
        hasOpenModal(document)
      ) {
        return;
      }
      event.preventDefault();
      void navigateTranscript(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateTranscript]);

  const mutateSessionState = useCallback(
    (state: SessionStateUpdate) => {
      const mutationGeneration = sessionStateMutationGenerationRef.current + 1;
      sessionStateMutationGenerationRef.current = mutationGeneration;
      setSessionStatePending(state);
      setSessionStateError(null);
      setSessionStateNotice(null);
      const request = sessionStateRequest(id, state);
      void getJson<{ ok: true }>(request.path, request.init)
        .then(() => {
          if (sessionStateMutationGenerationRef.current !== mutationGeneration) {
            return;
          }
          if (state === "deleted") {
            setDeleteDialogOpen(false);
            visit("/sessions");
            return;
          }
          setDeleteDialogOpen(false);
          if (state === "visible") {
            setSessionStateNotice("Session restored to the default views.");
          }
          setDetailRetryKey((key) => key + 1);
        })
        .catch((err: unknown) => {
          if (sessionStateMutationGenerationRef.current === mutationGeneration) {
            setSessionStateError(errorMessage(err));
          }
        })
        .finally(() => {
          if (sessionStateMutationGenerationRef.current === mutationGeneration) {
            setSessionStatePending(null);
          }
        });
    },
    [id],
  );

  // Hoisted above the early returns because hooks cannot run conditionally.
  // TranscriptTurn is memoized, and a Map rebuilt every render would defeat
  // that for every turn on the screen.
  const subagents = detail?.subagents;
  const subagentsByToolUse = useMemo(() => subagentMap(subagents ?? []), [subagents]);
  const detailMessages = detail?.messages;
  const messages = useMemo(() => renderableMessages(detailMessages ?? []), [detailMessages]);
  const toc = useMemo(
    () => (outline == null ? threadToc(messages) : threadTocFromOutline(outline)),
    [messages, outline],
  );
  const compactions = contextWindow?.compactions;
  const compactionBySeq = useMemo(
    () => new Map((compactions ?? []).map((compaction) => [compaction.seq, compaction] as const)),
    [compactions],
  );
  const compactionNumberBySeq = useMemo(
    () => new Map((compactions ?? []).map((compaction, index) => [compaction.seq, index + 1])),
    [compactions],
  );

  if (error != null) {
    return (
      <ApiFailureState
        error={error}
        onRetry={() => setDetailRetryKey((key) => key + 1)}
        onSync={onSync}
      />
    );
  }

  if (detail == null) {
    return <SessionDetailSkeleton />;
  }

  const stats = threadStats(
    detail.summary,
    messages,
    toc,
    contextWindow?.turn_count,
    detail.totals,
  );
  const subagentRuns = countSubagentRuns(detail.subagents);
  const windowTokens = contextWindow?.window_tokens ?? null;
  const detailTitle = sessionDisplayTitle(detail.summary);
  const archiveAction = archiveActionFor(detail.summary);
  const sessionsHref = detail.summary.is_user_archived
    ? sessionsArchivedHref("/sessions", true)
    : "/sessions";

  return (
    <div className="session-detail">
      <header className="thread-header">
        <div className="thread-header-inner">
          <div className="thread-header-title-row">
            <h1>{detailTitle}</h1>
            <div className="thread-header-actions">
              <ReportExportButton
                excluded={SESSION_REPORT_NEVER_INCLUDES}
                href={`/api/reports/session/${detail.summary.id}.html`}
                includes={SESSION_REPORT_INCLUDES}
                previewHref={`/reports/session/${detail.summary.id}`}
                title="Review session report"
              />
              <OverflowMenu label={`More actions for ${detailTitle}`}>
                {archiveAction != null ? (
                  <button
                    disabled={sessionStatePending != null}
                    onClick={() => mutateSessionState(archiveAction)}
                    type="button"
                  >
                    <Icon name="archive" />
                    <span>
                      {archiveAction === "visible" ? "Unarchive session" : "Archive session"}
                    </span>
                  </button>
                ) : null}
                <button
                  className="is-danger"
                  disabled={sessionStatePending != null}
                  onClick={() => {
                    setSessionStateError(null);
                    setDeleteDialogOpen(true);
                  }}
                  type="button"
                >
                  <Icon name="trash" />
                  <span>Delete session</span>
                </button>
              </OverflowMenu>
            </div>
          </div>
          <div className="thread-badges">
            <ToolBadge tool={detail.summary.tool} />
            <ModelBadge model={detail.summary.model} />
            <DosuProvenanceBadge session={detail.summary} />
            <ReasoningBadge
              effort={detail.summary.reasoning_effort}
              levels={detail.summary.reasoning_effort_levels}
              totalReasoningTokens={detail.summary.total_reasoning_tokens}
              reasoningSource={detail.summary.reasoning_source}
              labeled
            />
            {detail.summary.ingest_issue_count > 0 ? (
              <button
                aria-expanded={showIssues}
                aria-label={`${showIssues ? "Hide" : "Show"} ingest diagnostics`}
                className="badge-button"
                onClick={() => setShowIssues((value) => !value)}
                type="button"
              >
                <Badge tone="warning">{formatIssueBadge(detail.summary.ingest_issue_count)}</Badge>
              </button>
            ) : null}
            {detail.summary.project_path != null ? (
              <Link
                className="project-chip"
                href={projectSessionsHref(detail.summary.project_path)}
                title={detail.summary.project_path}
              >
                <Icon name="folder" />
                {basename(detail.summary.project_path)}
              </Link>
            ) : null}
          </div>
          <div className="thread-stats">
            <span>
              <strong>{formatInt(stats.turns)}</strong> turns
            </span>
            <span>
              <strong>{formatInt(stats.replies)}</strong> replies
            </span>
            <span>
              <strong>{formatInt(stats.toolCalls)}</strong> tool calls
            </span>
            <span>
              <strong>{compact(stats.tokens)}</strong> tokens
            </span>
            <span>
              <strong>{money(detail.summary.estimated_cost_usd)}</strong>
            </span>
          </div>
        </div>
      </header>

      {detail.summary.is_user_archived ? (
        <div className="notice session-state-banner" role="status">
          <span>
            {detail.summary.user_state === "archived"
              ? "This session is archived and hidden from default lists, search, and analytics."
              : "This session is archived with a parent session."}
          </span>
          {detail.summary.user_state === "archived" ? (
            <button
              className="secondary-button"
              disabled={sessionStatePending != null}
              onClick={() => mutateSessionState("visible")}
              type="button"
            >
              Unarchive
            </button>
          ) : null}
        </div>
      ) : sessionStateNotice != null ? (
        <div className="notice session-state-banner" role="status">
          {sessionStateNotice}
        </div>
      ) : null}
      {sessionStateError != null && !deleteDialogOpen ? (
        <div className="notice danger session-state-banner" role="alert">
          <span>{sessionStateError}</span>
          {archiveAction != null ? (
            <button
              className="secondary-button"
              disabled={sessionStatePending != null}
              onClick={() => mutateSessionState(archiveAction)}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {showIssues ? (
        <IngestIssuesPanel
          error={issuesError}
          issues={issues}
          onResync={onSync}
          onRetry={() => setIssuesError(null)}
          syncing={syncing}
        />
      ) : null}

      <Link className="back-link" href={sessionsHref}>
        <Icon name="arrowLeft" />
        Sessions
      </Link>

      <DeleteSessionDialog
        error={deleteDialogOpen ? sessionStateError : null}
        onClose={() => {
          if (sessionStatePending == null) {
            setDeleteDialogOpen(false);
            setSessionStateError(null);
          }
        }}
        onConfirm={() => mutateSessionState("deleted")}
        open={deleteDialogOpen}
        pending={sessionStatePending === "deleted"}
        title={detailTitle}
      />

      {economics != null ? (
        <TokenEconomicsPanel
          compact
          description="Estimated agent activity inside this session, including nested subagents; capped user response time is shown separately."
          economics={economics}
          subagentRuns={subagentRuns}
          title="Activity breakdown"
        />
      ) : economicsError != null ? (
        <div className="notice inline-notice">Activity breakdown unavailable: {economicsError}</div>
      ) : (
        <SessionEconomicsSkeleton />
      )}

      <ContextWindowPanel onJump={jumpToMessage} timeline={contextWindow} />

      <div className="transcript-layout">
        <aside className="toc">
          <div className="toc-inner">
            <div className="toc-title">In this thread</div>
            <div className="toc-hotkeys">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
              </span>
              Move through messages
            </div>
            {toc.length === 0 ? <p>No prompts or Dosu calls to list</p> : null}
            {toc.map((item) => (
              <ThreadTocEntry
                current={activeMessageSeq === item.seq}
                item={item}
                jumping={jumpingToSeq === item.seq}
                key={item.key}
                onJump={jumpToMessage}
              />
            ))}
          </div>
        </aside>

        <div className="transcript-column">
          {(detail.message_offset ?? 0) > 0 ? (
            <div className="transcript-window-start">
              {/* Count of missing messages: the offset is a zero-based row
                  index and would contradict the #message-<seq> anchor as an ordinal. */}
              <span>
                {formatInt(detail.message_offset ?? 0)} earlier{" "}
                {(detail.message_offset ?? 0) === 1 ? "message" : "messages"} not loaded
              </span>
              {loadEarlierError != null ? (
                <span className="transcript-window-start-error" role="status">
                  Couldn’t load the earlier messages: {loadEarlierError}
                </span>
              ) : null}
              <span className="transcript-window-start-actions">
                <button
                  className="button small secondary"
                  disabled={loadingMore}
                  onClick={() => void loadPreviousMessages()}
                  type="button"
                >
                  {loadEarlierError != null
                    ? "Try again"
                    : loadingMore
                      ? "Loading…"
                      : "Load earlier"}
                </button>
                <button
                  className="button small secondary"
                  onClick={() => void jumpToMessage(0)}
                  type="button"
                >
                  Start at the beginning
                </button>
              </span>
            </div>
          ) : null}
          {messages.map((message) => (
            <TranscriptTurn
              active={activeMessageSeq === message.seq}
              compaction={compactionBySeq.get(message.seq) ?? null}
              compactionNumber={compactionNumberBySeq.get(message.seq) ?? null}
              key={messageKey(message)}
              message={message}
              sessionIsSubagent={detail.summary.is_subagent}
              subagentsByToolUse={subagentsByToolUse}
              tool={detail.summary.tool}
              windowTokens={windowTokens}
            />
          ))}
          {detail.has_more_messages === true ? (
            <div
              aria-live="polite"
              className="transcript-load-more"
              ref={loadMoreSentinelRef}
              role="status"
            >
              {loadMoreError != null ? (
                <>
                  <span>Couldn’t load the next messages: {loadMoreError}</span>
                  <button
                    className="button small secondary"
                    onClick={() => void loadMoreMessages()}
                    type="button"
                  >
                    Try again
                  </button>
                </>
              ) : (
                <span>
                  {loadingMore ? "Loading more messages…" : "Keep scrolling to load more"}
                  <small>
                    {formatInt(detail.messages.length)} of {formatInt(detail.summary.message_count)}
                  </small>
                </span>
              )}
            </div>
          ) : (
            <div className="transcript-end">
              {(detail.message_offset ?? 0) === 0
                ? `All ${formatInt(detail.summary.message_count)} messages loaded`
                : "Reached the end of this session"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IngestIssuesPanel({
  error,
  issues,
  onResync,
  onRetry,
  syncing,
}: {
  error: unknown;
  issues: SessionIngestIssue[] | null;
  onResync: () => void;
  onRetry: () => void;
  syncing: boolean;
}) {
  const unknownIssues = issues?.filter((issue) => issue.code === "unknown_record_type") ?? [];
  const otherIssues = issues?.filter((issue) => issue.code !== "unknown_record_type") ?? [];
  const unknownSummary = unknownRecordTypeSummary(unknownIssues.map((issue) => issue.error));
  return (
    <section className="panel ingest-issues-panel">
      <div className="panel-heading">
        <div>
          <h2>Ingest diagnostics</h2>
          <p>
            A source line could not be parsed, so this session may be incomplete. Informational
            parser notes are included here for context.
          </p>
        </div>
        <button
          aria-busy={syncing}
          aria-label="Re-sync session logs"
          className={`secondary-button sync-button${syncing ? " is-syncing" : ""}`}
          disabled={syncing}
          onClick={onResync}
          type="button"
        >
          <Icon name="refresh" />
          {syncing ? null : "Re-sync"}
        </button>
      </div>
      <div className="panel-body">
        {error != null ? (
          <ApiFailureState error={error} onRetry={onRetry} />
        ) : issues == null ? (
          <p className="faint">Loading issues…</p>
        ) : issues.length === 0 ? (
          <p className="faint">No issues recorded for this session.</p>
        ) : (
          <div className="signal-list">
            {unknownSummary.count > 0 ? (
              <div className="ingest-issue-row is-informational">
                <div className="muted">
                  Decant safely preserved or ignored {formatInt(unknownSummary.count)} unknown
                  source {unknownSummary.count === 1 ? "record type" : "record types"}
                  {unknownSummary.types.length > 0
                    ? `: ${unknownSummary.types.map((type) => `“${type}”`).join(", ")}`
                    : ""}
                  .{" "}
                  <a
                    href="https://github.com/dosu-ai/decant/releases"
                    rel="noopener"
                    target="_blank"
                  >
                    Check for a Decant update
                  </a>{" "}
                  before re-syncing.
                </div>
              </div>
            ) : null}
            {otherIssues.map((issue, index) => (
              // No stable id in the wire shape; composite of the fields shown
              // plus the map index, since byte-identical rows (e.g. repeated
              // duplicate_tool_result issues) would otherwise collide.
              <div
                className={`ingest-issue-row ${
                  issue.code === "unparsed_line" ? "is-warning" : "is-informational"
                }`}
                // biome-ignore lint/suspicious/noArrayIndexKey: fetched once and never reorders; index only disambiguates byte-identical rows.
                key={`${issue.code}-${issue.line_no}-${issue.error}-${index}`}
              >
                <div>
                  <div>
                    <code className="mono">{issue.code}</code>
                    {issue.line_no != null ? (
                      <span className="faint"> · line {issue.line_no}</span>
                    ) : null}
                  </div>
                  <div className="muted">{issue.error}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function SessionDetailSkeleton() {
  return (
    <div
      className="session-detail session-detail-skeleton"
      aria-label="Loading session"
      role="status"
    >
      <header className="thread-header">
        <div className="thread-header-inner">
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-badges" />
          <span className="skeleton-line skeleton-stats" />
        </div>
      </header>
      <span className="skeleton-line skeleton-back" />
      <SessionEconomicsSkeleton />
      <div className="transcript-layout">
        <aside className="toc">
          <div className="toc-inner">
            <span className="skeleton-line skeleton-toc-title" />
            {["one", "two", "three", "four", "five", "six", "seven"].map((key) => (
              <span className="skeleton-line skeleton-toc-row" key={key} />
            ))}
          </div>
        </aside>
        <div className="transcript-column">
          {["prompt", "reply", "tool", "followup", "summary"].map((key) => (
            <article className="turn skeleton-turn" key={key}>
              <span className="skeleton-line skeleton-meta" />
              <span className="skeleton-line skeleton-copy" />
              <span className="skeleton-line skeleton-copy short" />
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionEconomicsSkeleton() {
  return (
    <section
      aria-label="Loading activity breakdown"
      className="panel token-economics-panel is-compact skeleton-panel"
      role="status"
    >
      <div className="panel-heading">
        <div>
          <span className="skeleton-line skeleton-heading" />
          <span className="skeleton-line skeleton-subheading" />
        </div>
        <span className="skeleton-line skeleton-summary" />
      </div>
      <div className="activity-table-wrap">
        <div className="skeleton-table">
          {["context", "planning", "code", "communicating"].map((key) => (
            <span className="skeleton-line" key={key} />
          ))}
        </div>
      </div>
    </section>
  );
}
