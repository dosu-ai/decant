import { useState } from "react";
import { getJson } from "../api.ts";
import { ApiFailureState } from "../api-failure.tsx";
import dosuOfficialUrl from "../assets/dosu-official.svg";
import { toneName } from "../badges.tsx";
import { copyTextToClipboard } from "../clipboard.ts";
import { EmptyState, OverflowMenu } from "../common.tsx";
import { dosuLink } from "../dosu-links.ts";
import { field, formatInt, isPresent, shortDate } from "../format.ts";
import { Icon } from "../icons.tsx";
import type { IconName, Recommendation, SettingsInfo } from "../types.ts";

export function RecommendationHero({
  canLaunch,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  return (
    <article className={`signal-hero tone-${toneName(row.tone)}`}>
      <span className={`signal-icon tone-${toneName(row.tone)}`}>
        <Icon name={recommendationIcon(row)} />
      </span>
      <div>
        <span className={`signal-kicker tone-${toneName(row.tone)}`}>Top signal</span>
        <div className="signal-hero-title">
          <h3>{row.title}</h3>
          {row.impact_label != null ? <strong>{row.impact_label}</strong> : null}
        </div>
        {row.detail != null ? <p>{row.detail}</p> : null}
        {row.suggestion != null ? (
          <div className="suggestion-block">
            <span>Suggested</span>
            <p>{row.suggestion}</p>
          </div>
        ) : null}
        <PromotionPanel row={row} />
        <RecommendationActions
          canLaunch={canLaunch}
          onComplete={onComplete}
          pending={pending}
          row={row}
        />
      </div>
    </article>
  );
}

export function RecommendationRow({
  canLaunch,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  const [expanded, setExpanded] = useState(false);
  const rationale = row.detail ?? row.suggestion ?? "Open for the evidence and next step.";
  return (
    <article className={`signal-row${expanded ? " is-expanded" : ""}`}>
      <div className="signal-row-summary">
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <button
          aria-expanded={expanded}
          className="signal-row-title"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {row.title}
        </button>
        <span className="signal-row-rationale">{rationale}</span>
        <strong className="signal-row-impact">{row.impact_label ?? toneName(row.tone)}</strong>
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${row.title}`}
          className="signal-row-expand"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span>{expanded ? "Close" : "View"}</span>
          <Icon name={expanded ? "chevronUp" : "chevronDown"} />
        </button>
      </div>
      {expanded ? (
        <div className="signal-row-detail">
          {row.detail != null ? <p>{row.detail}</p> : null}
          {row.suggestion != null ? (
            <div className="suggestion-block">
              <span>Suggested</span>
              <p>{row.suggestion}</p>
            </div>
          ) : null}
          {row.evidence != null ? (
            <p className="signal-row-evidence">
              <strong>Evidence</strong>
              {row.evidence}
            </p>
          ) : null}
          <PromotionPanel row={row} />
          <RecommendationActions
            canLaunch={canLaunch}
            onComplete={onComplete}
            pending={pending}
            row={row}
          />
        </div>
      ) : null}
    </article>
  );
}

export function RecommendationActions({
  canLaunch,
  compact = false,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  compact?: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  return (
    <div className="recommendation-actions">
      {row.prompt != null || row.action != null || row.suggestion != null ? (
        <button
          className="secondary-button"
          disabled={pending === row.key}
          onClick={() => onComplete(row)}
          type="button"
        >
          <Icon name={canLaunch ? "bolt" : isPresent(row.prompt) ? "copy" : "check"} />
          {pending === row.key
            ? !canLaunch && isPresent(row.prompt)
              ? "Copying"
              : "Saving"
            : compact
              ? "Run"
              : canLaunch
                ? "Run"
                : "Copy setup prompt"}
        </button>
      ) : null}
      {row.url != null ? (
        <OverflowMenu label={`More actions for ${row.title}`}>
          <a href={row.url} rel="noreferrer" target="_blank">
            <span>{row.link_label ?? "Docs"}</span>
            <span aria-hidden="true">↗</span>
          </a>
        </OverflowMenu>
      ) : null}
    </div>
  );
}

export function PromotionPanel({
  compact = false,
  row,
}: {
  compact?: boolean;
  row: Recommendation;
}) {
  if (!hasPromotion(row)) {
    return null;
  }
  return (
    <div className={`promotion-panel${compact ? " is-compact" : ""}`}>
      <span>Memory card</span>
      <dl>
        {row.memory_layer != null ? (
          <div>
            <dt>Layer</dt>
            <dd>{row.memory_layer}</dd>
          </div>
        ) : null}
        {row.promotion_target != null ? (
          <div>
            <dt>Promote to</dt>
            <dd>{row.promotion_target}</dd>
          </div>
        ) : null}
        {!compact && row.trigger != null ? (
          <div>
            <dt>Trigger</dt>
            <dd>{row.trigger}</dd>
          </div>
        ) : null}
        {!compact && row.success_metric != null ? (
          <div>
            <dt>Done when</dt>
            <dd>{row.success_metric}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export function recommendationIcon(row: Recommendation): IconName {
  const icon = row.icon ?? "";
  if (icon.includes("cpu")) {
    return "cpu";
  }
  if (icon.includes("document") || icon.includes("book")) {
    return "file";
  }
  if (icon.includes("wrench")) {
    return "tools";
  }
  if (icon.includes("chart")) {
    return "chart";
  }
  return "lightbulb";
}

export function groupByCategory(rows: Recommendation[]): [string, Recommendation[]][] {
  const groups = new Map<string, Recommendation[]>();
  for (const row of rows) {
    const key = row.category ?? "Recommended";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()];
}

export function hasPromotion(row: Recommendation): boolean {
  return [row.memory_layer, row.promotion_target, row.trigger, row.success_metric].some(isPresent);
}

export function handoffPrompt(row: Recommendation): string {
  return [row.prompt ?? row.action ?? row.suggestion, promotionText(row)]
    .filter(isPresent)
    .join("\n\n");
}

export function promotionText(row: Recommendation): string {
  return [
    `# ${row.title}`,
    `Key: ${row.key}`,
    field("Layer", row.memory_layer),
    field("Promote to", row.promotion_target),
    field("Trigger", row.trigger),
    field("Evidence", row.evidence),
    field("Action", row.action),
    field("Done when", row.success_metric),
  ]
    .filter(isPresent)
    .join("\n");
}

export function InsightsView({
  loading,
  loadFailed,
  rows,
  settingsInfo,
  onMarked,
}: {
  loading: boolean;
  loadFailed: boolean;
  rows: Recommendation[];
  settingsInfo: SettingsInfo | null;
  onMarked: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [failedAction, setFailedAction] = useState<Recommendation | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const openRows = rows.filter((row) => row.status === "open");
  const implementedRows = rows
    .filter((row) => row.status === "implemented")
    .slice()
    .sort(
      (left, right) =>
        implementedTimestamp(right) - implementedTimestamp(left) || right.score - left.score,
    );
  const signals = openRows
    .filter((row) => row.kind === "signal")
    .slice()
    .sort((left, right) => right.score - left.score);
  const [hero, ...rest] = signals;
  const catalogGroups = groupByCategory(openRows.filter((row) => row.kind === "catalog"));
  const canLaunch = settingsInfo?.can_launch === true;
  const completeRecommendation = (row: Recommendation) => {
    setError(null);
    setFailedAction(null);
    setCopyFeedback(null);
    if (isPresent(row.prompt) && canLaunch && settingsInfo != null) {
      setPending(row.key);
      void getJson<{ ok: boolean }>("/api/launch/agent", {
        method: "POST",
        body: JSON.stringify({
          agent: settingsInfo.settings.agent,
          prompt: handoffPrompt(row),
          key: row.key,
        }),
      })
        .then(() => onMarked())
        .catch((err: unknown) => {
          setError(err);
          setFailedAction(row);
        })
        .finally(() => setPending(null));
      return;
    }
    if (isPresent(row.prompt)) {
      setPending(row.key);
      void copyTextToClipboard(handoffPrompt(row))
        .then(() => {
          setCopyFeedback({
            kind: "success",
            message: `Copied the setup prompt for “${row.title}”.`,
          });
        })
        .catch(() => {
          setCopyFeedback({
            kind: "error",
            message: "Could not copy the setup prompt. Select the insight text and try again.",
          });
        })
        .finally(() => setPending(null));
      return;
    }
    setPending(row.key);
    void getJson<{ ok: boolean }>("/api/recommendations/mark", {
      method: "POST",
      body: JSON.stringify({ key: row.key, source: "ui" }),
    })
      .then(onMarked)
      .catch((err: unknown) => {
        setError(err);
        setFailedAction(row);
      })
      .finally(() => setPending(null));
  };

  return (
    <div className="view-stack insights-stack">
      <header className="page-heading insights-heading">
        <span className="page-eyebrow">Session logs → action</span>
        <h1>Insights</h1>
        <p>
          Decant finds recurring patterns in your local sessions, ranks the ones worth acting on,
          and suggests durable improvements for future agent runs.
        </p>
      </header>

      {error != null ? (
        <ApiFailureState
          error={error}
          onRetry={failedAction == null ? undefined : () => completeRecommendation(failedAction)}
        />
      ) : null}
      {copyFeedback != null ? (
        <div
          className={`notice${copyFeedback.kind === "error" ? " danger" : ""}`}
          role={copyFeedback.kind === "error" ? "alert" : "status"}
        >
          {copyFeedback.message}
        </div>
      ) : null}

      <section className="view-stack insights-section">
        <div className="section-title-row insights-section-heading">
          <div>
            <span className="section-eyebrow">Detected in your session logs</span>
            <h2>Patterns worth acting on</h2>
            <p>Evidence-backed signals from your own sessions, ranked by expected impact.</p>
          </div>
          {signals.length > 0 ? (
            <span className="section-count">{formatInt(signals.length)} active</span>
          ) : null}
        </div>

        {loading && signals.length === 0 ? <InsightsSignalsSkeleton /> : null}

        {!loading && !loadFailed && signals.length === 0 ? (
          <EmptyState
            icon="lightbulb"
            message="More session history will surface patterns."
            title="No signals yet"
          />
        ) : null}

        {hero != null ? (
          <RecommendationHero
            pending={pending}
            row={hero}
            onComplete={completeRecommendation}
            canLaunch={canLaunch}
          />
        ) : null}

        {rest.length > 0 ? (
          <div className="signal-list">
            {rest.map((row) => (
              <RecommendationRow
                key={row.key}
                pending={pending}
                row={row}
                onComplete={completeRecommendation}
                canLaunch={canLaunch}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="view-stack insights-section">
        <div className="section-title-row insights-section-heading">
          <div>
            <span className="section-eyebrow">Reusable improvements</span>
            <h2>Set up for future runs</h2>
            <p>Project practices your coding agents can use in every session.</p>
          </div>
        </div>
        {catalogGroups.map(([category, items]) => (
          <div className="catalog-group" key={category}>
            <div className="catalog-group-heading">
              <h3>{category}</h3>
              <span>{formatInt(items.length)}</span>
            </div>
            <div className="signal-list">
              {items.map((row) => (
                <RecommendationRow
                  key={row.key}
                  pending={pending}
                  row={row}
                  onComplete={completeRecommendation}
                  canLaunch={canLaunch}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="signal-list insights-dosu-list">
          <DosuInsightsRow />
        </div>
      </section>

      {implementedRows.length > 0 ? (
        <section className="view-stack insights-history-heading insights-section">
          <div className="section-title-row insights-section-heading">
            <div>
              <span className="section-eyebrow">History</span>
              <h2>Already implemented</h2>
              <p>Improvements you have already marked complete.</p>
            </div>
            <span className="section-count">{formatInt(implementedRows.length)} saved</span>
          </div>
          <div className="implemented-list">
            {implementedRows.map((row) => (
              <ImplementedRecommendationCard key={row.key} row={row} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function InsightsSignalsSkeleton() {
  return (
    <div aria-label="Loading insights" className="insights-signals-skeleton" role="status">
      {["primary", "secondary", "tertiary"].map((key) => (
        <div className="insights-skeleton-card" key={key}>
          <span className="skeleton-line insights-skeleton-kicker" />
          <span className="skeleton-line insights-skeleton-title" />
          <span className="skeleton-line insights-skeleton-detail" />
        </div>
      ))}
    </div>
  );
}

export function DosuInsightsRow() {
  return (
    <article className="signal-row dosu-insights-row">
      <div className="signal-row-summary">
        <span className="signal-icon dosu-row-mark">
          <img alt="" src={dosuOfficialUrl} />
        </span>
        <div className="dosu-row-title">
          <span className="dosu-card-kicker">Optional · Dosu</span>
          <strong>Make these patterns available to every coding agent</strong>
        </div>
        <span className="signal-row-rationale">
          Dosu turns repeated fixes and project conventions into durable context your agents can
          retrieve when they need it.
        </span>
        <strong className="signal-row-impact">Optional</strong>
        <a
          aria-label="See how Dosu works with your agents (opens in a new tab)"
          className="signal-row-expand dosu-row-action"
          href={dosuLink("insights_card")}
          rel="noopener"
          target="_blank"
        >
          <span>See how</span>
          <Icon name="chevronRight" />
        </a>
      </div>
    </article>
  );
}

export function ImplementedRecommendationCard({ row }: { row: Recommendation }) {
  const implementedLabel =
    row.implemented_at == null ? "Implemented" : `Implemented ${shortDate(row.implemented_at)}`;
  return (
    <article className="catalog-card">
      <div>
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <h4>{row.title}</h4>
      </div>
      <p className="settings-note">
        {implementedLabel}
        {isPresent(row.note) ? `: ${row.note}` : ""}
      </p>
      {row.detail != null ? <p>{row.detail}</p> : null}
      {row.suggestion != null ? <p>{row.suggestion}</p> : null}
      <PromotionPanel compact row={row} />
    </article>
  );
}

export function implementedTimestamp(row: Recommendation): number {
  const time = Date.parse(row.implemented_at ?? "");
  return Number.isFinite(time) ? time : 0;
}
