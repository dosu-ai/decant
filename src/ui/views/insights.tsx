import { useId, useState } from "react";
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

export type RecommendationAction = "launch" | "copy" | "mark";

/** The action in flight on each row, by row key. */
export type PendingActions = Readonly<Record<string, RecommendationAction>>;

export type RecommendationHandlers = {
  /** Display name of the agent "Run" opens, when launching is available. */
  agentLabel: string | null;
  canLaunch: boolean;
  /** Key of the row whose prompt was just copied, so its button can say so. */
  copiedKey: string | null;
  onComplete: (row: Recommendation) => void;
  onCopy: (row: Recommendation) => void;
  pending: PendingActions;
};

export function RecommendationHero({
  row,
  ...handlers
}: RecommendationHandlers & { row: Recommendation }) {
  const facts = recommendationFacts(row);
  return (
    <article className={`signal-hero tone-${toneName(row.tone)}`}>
      <span className={`signal-icon tone-${toneName(row.tone)}`}>
        <Icon name={recommendationIcon(row)} />
      </span>
      <div>
        <span className="signal-kicker">Top signal</span>
        <div className="signal-hero-title">
          <h3>{row.title}</h3>
          {isPresent(row.impact_label) ? <strong>{row.impact_label}</strong> : null}
        </div>
        {facts.summary != null ? <p className="signal-hero-detail">{facts.summary}</p> : null}
        <RecommendationDetail facts={facts} row={row} {...handlers} />
      </div>
    </article>
  );
}

export function RecommendationRow({
  row,
  ...handlers
}: RecommendationHandlers & { row: Recommendation }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const facts = recommendationFacts(row);
  return (
    <article className={`signal-row${expanded ? " is-expanded" : ""}`}>
      <button
        aria-controls={expanded ? detailId : undefined}
        aria-expanded={expanded}
        className="signal-row-summary"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <span className="signal-row-text">
          <span className="signal-row-title">{row.title}</span>
          {facts.summary != null ? (
            <span className="signal-row-rationale">{facts.summary}</span>
          ) : null}
        </span>
        {isPresent(row.impact_label) ? (
          <strong className="signal-row-impact">{row.impact_label}</strong>
        ) : null}
        <span aria-hidden="true" className="signal-row-expand">
          <span>{expanded ? "Close" : "View"}</span>
          <Icon name={expanded ? "chevronUp" : "chevronDown"} />
        </span>
      </button>
      {expanded ? (
        <div className="signal-row-detail" id={detailId}>
          <RecommendationDetail facts={facts} row={row} {...handlers} />
        </div>
      ) : null}
    </article>
  );
}

/** What a row adds below its title and summary line. */
export function RecommendationDetail({
  facts,
  row,
  ...handlers
}: RecommendationHandlers & { facts: RecommendationFacts; row: Recommendation }) {
  return (
    <div className="signal-detail">
      {facts.suggestion != null ? (
        <div className="signal-fact">
          <span className="signal-label">Suggested</span>
          <p className="signal-fact-text">{facts.suggestion}</p>
        </div>
      ) : null}
      {facts.evidence != null ? (
        <div className="signal-fact">
          <span className="signal-label">Evidence</span>
          <p className="signal-fact-text">{facts.evidence}</p>
        </div>
      ) : null}
      <PromotionPanel row={row} />
      <PromptPreview agentLabel={handlers.agentLabel} canLaunch={handlers.canLaunch} row={row} />
      <RecommendationActions row={row} {...handlers} />
    </div>
  );
}

export type RecommendationFacts = {
  summary: string | null;
  suggestion: string | null;
  evidence: string | null;
};

/**
 * The API repeats one sentence as detail and evidence, and some details only
 * restate the impact label, so each text is kept the first time it appears.
 */
export function recommendationFacts(row: Recommendation): RecommendationFacts {
  const seen = new Set<string>();
  const sameText = (value: string) =>
    value
      .trim()
      .replace(/[.!]+$/, "")
      .toLowerCase();
  if (isPresent(row.impact_label)) {
    seen.add(sameText(row.impact_label));
  }
  const once = (value: string | null): string | null => {
    if (!isPresent(value) || seen.has(sameText(value))) {
      return null;
    }
    seen.add(sameText(value));
    return value.trim();
  };
  const summary = once(row.detail) ?? once(row.suggestion);
  return { summary, suggestion: once(row.suggestion), evidence: once(row.evidence) };
}

export function recommendationAction(
  row: Recommendation,
  canLaunch: boolean,
): RecommendationAction | null {
  if (isPresent(row.prompt)) {
    return canLaunch ? "launch" : "copy";
  }
  return row.action != null || row.suggestion != null ? "mark" : null;
}

const ACTION_COPY: Record<
  RecommendationAction,
  { icon: IconName; label: string; pendingLabel: string }
> = {
  launch: { icon: "bolt", label: "Run", pendingLabel: "Opening" },
  copy: { icon: "copy", label: "Copy setup prompt", pendingLabel: "Copying" },
  mark: { icon: "check", label: "Mark as done", pendingLabel: "Saving" },
};

export function RecommendationActions({
  agentLabel,
  canLaunch,
  copiedKey,
  onComplete,
  onCopy,
  pending,
  row,
}: RecommendationHandlers & { row: Recommendation }) {
  const action = recommendationAction(row, canLaunch);
  const busy = pending[row.key] ?? null;
  const copied = copiedKey === row.key;
  const copyLabel =
    busy === "copy" ? ACTION_COPY.copy.pendingLabel : copied ? "Copied" : ACTION_COPY.copy.label;
  return (
    <div className="recommendation-actions">
      {action === "launch" ? (
        <button
          className="primary-button"
          disabled={busy != null}
          onClick={() => onComplete(row)}
          type="button"
        >
          <Icon name={ACTION_COPY.launch.icon} />
          {busy === "launch"
            ? ACTION_COPY.launch.pendingLabel
            : agentLabel != null
              ? `Run in ${agentLabel}`
              : ACTION_COPY.launch.label}
        </button>
      ) : null}
      {action === "launch" || action === "copy" ? (
        <button
          className="secondary-button"
          disabled={busy != null}
          onClick={() => (action === "copy" ? onComplete(row) : onCopy(row))}
          type="button"
        >
          <Icon name={copied && busy == null ? "check" : ACTION_COPY.copy.icon} />
          {copyLabel}
        </button>
      ) : null}
      {action === "mark" ? (
        <button
          className="secondary-button"
          disabled={busy != null}
          onClick={() => onComplete(row)}
          type="button"
        >
          <Icon name={ACTION_COPY.mark.icon} />
          {busy === "mark" ? ACTION_COPY.mark.pendingLabel : ACTION_COPY.mark.label}
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

// Plain wording for the API's memory layer names. Unknown layers show as sent.
const MEMORY_LAYER_COPY: Record<string, string> = {
  hot: "Loaded in every session",
  procedural: "Loaded when a task calls for it",
  cold: "Looked up when it is needed",
  governance: "Kept as a team rule or an automated check",
};

export function memoryLayerCopy(layer: string): string {
  return MEMORY_LAYER_COPY[layer.trim().toLowerCase()] ?? layer;
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
      <span className="signal-label">Plan</span>
      {compact ? null : (
        <p className="signal-note">
          Where to record this so future agent sessions use it, and how to tell that it worked.
          {isPresent(row.prompt) ? " The prompt below includes this plan." : ""}
        </p>
      )}
      <dl>
        {isPresent(row.promotion_target) ? (
          <div className="promotion-row">
            <dt>Record it in</dt>
            <dd>{row.promotion_target}</dd>
          </div>
        ) : null}
        {isPresent(row.memory_layer) ? (
          <div className="promotion-row">
            <dt>How agents get it</dt>
            <dd>{memoryLayerCopy(row.memory_layer)}</dd>
          </div>
        ) : null}
        {!compact && isPresent(row.trigger) ? (
          <div className="promotion-row">
            <dt>When it applies</dt>
            <dd>{row.trigger}</dd>
          </div>
        ) : null}
        {!compact && isPresent(row.success_metric) ? (
          <div className="promotion-row">
            <dt>It worked when</dt>
            <dd>{row.success_metric}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

const LONG_PROMPT_LINES = 4;
const LONG_PROMPT_CHARS = 320;

export function isLongPrompt(prompt: string): boolean {
  return prompt.length > LONG_PROMPT_CHARS || prompt.split("\n").length > LONG_PROMPT_LINES;
}

/** The text "Run" or "Copy setup prompt" hands to an agent, readable first. */
export function PromptPreview({
  agentLabel,
  canLaunch,
  row,
}: {
  agentLabel: string | null;
  canLaunch: boolean;
  row: Recommendation;
}) {
  if (!isPresent(row.prompt)) {
    return null;
  }
  const prompt = handoffPrompt(row);
  const lines = prompt.split("\n").length;
  return (
    <div className="signal-prompt-block">
      <span className="signal-label">Prompt</span>
      <p className="signal-note">
        {canLaunch
          ? `Run opens ${agentLabel ?? "your coding agent"} in a terminal and sends it this prompt. Read it before you run it.`
          : "Copy setup prompt puts this text on your clipboard. Paste it into your coding agent."}
      </p>
      <details className="signal-prompt" open={!isLongPrompt(prompt)}>
        <summary className="signal-prompt-toggle">
          <span className="signal-prompt-chevron">
            <Icon name="chevronRight" />
          </span>
          <span>Full prompt</span>
          <span className="signal-prompt-count">
            {formatInt(lines)} {lines === 1 ? "line" : "lines"}
          </span>
        </summary>
        <pre className="signal-prompt-text">{prompt}</pre>
        {canLaunch ? (
          <p className="signal-note">
            Run adds one last line that asks the agent to mark this insight done when it has
            verified the work:
            <code className="signal-prompt-command">decant recommendations mark {row.key}</code>
          </p>
        ) : null}
      </details>
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
  const [pending, setPending] = useState<PendingActions>({});
  const [error, setError] = useState<unknown>(null);
  const [failedAction, setFailedAction] = useState<Recommendation | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    kind: "success" | "error";
    key: string;
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
  const agentLabel =
    settingsInfo?.options.agents.find(([key]) => key === settingsInfo.settings.agent)?.[1] ?? null;
  const startAction = (row: Recommendation, action: RecommendationAction) => {
    setError(null);
    setFailedAction(null);
    setCopyFeedback(null);
    setPending((current) => ({ ...current, [row.key]: action }));
  };
  // Each row keeps its own entry, so an action on one row cannot enable
  // another row's buttons while that row's request is still running.
  const finishAction = (row: Recommendation, action: RecommendationAction) => {
    setPending((current) => {
      if (current[row.key] !== action) {
        return current;
      }
      const { [row.key]: _finished, ...rest } = current;
      return rest;
    });
  };
  const copyPrompt = (row: Recommendation) => {
    startAction(row, "copy");
    void copyTextToClipboard(handoffPrompt(row))
      .then(() => {
        setCopyFeedback({
          kind: "success",
          key: row.key,
          message: `Copied the setup prompt for “${row.title}”.`,
        });
      })
      .catch(() => {
        setCopyFeedback({
          kind: "error",
          key: row.key,
          message:
            "Could not copy the setup prompt. Open the full prompt in the row and copy it from there.",
        });
      })
      .finally(() => finishAction(row, "copy"));
  };
  const completeRecommendation = (row: Recommendation) => {
    const action = recommendationAction(row, canLaunch && settingsInfo != null);
    if (action === "launch" && settingsInfo != null) {
      startAction(row, "launch");
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
        .finally(() => finishAction(row, "launch"));
      return;
    }
    if (action === "copy") {
      copyPrompt(row);
      return;
    }
    startAction(row, "mark");
    void getJson<{ ok: boolean }>("/api/recommendations/mark", {
      method: "POST",
      body: JSON.stringify({ key: row.key, source: "ui" }),
    })
      .then(onMarked)
      .catch((err: unknown) => {
        setError(err);
        setFailedAction(row);
      })
      .finally(() => finishAction(row, "mark"));
  };
  const handlers = {
    agentLabel,
    canLaunch,
    copiedKey: copyFeedback?.kind === "success" ? copyFeedback.key : null,
    onComplete: completeRecommendation,
    onCopy: copyPrompt,
    pending,
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

        {hero != null ? <RecommendationHero row={hero} {...handlers} /> : null}

        {rest.length > 0 ? (
          <div className="signal-list">
            {rest.map((row) => (
              <RecommendationRow key={row.key} row={row} {...handlers} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="view-stack insights-section insights-catalog">
        <div className="section-title-row insights-section-heading">
          <div>
            <span className="section-eyebrow">Not from your session logs</span>
            <h2>Setup ideas</h2>
            <p>
              General suggestions that apply to any project. Decant did not derive them from your
              archive.
            </p>
          </div>
        </div>
        {catalogGroups.map(([category, items]) => (
          <div className="catalog-group" key={category}>
            <div className="catalog-group-heading">
              <h3>{category}</h3>
              <span>
                {formatInt(items.length)} {items.length === 1 ? "idea" : "ideas"}
              </span>
            </div>
            <div className="signal-list">
              {items.map((row) => (
                <RecommendationRow key={row.key} row={row} {...handlers} />
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
        <div className="signal-row-text">
          <span className="dosu-card-kicker">Optional · Dosu</span>
          <strong className="signal-row-title">
            Make these patterns available to every coding agent
          </strong>
          <span className="signal-row-rationale">
            Dosu turns repeated fixes and project conventions into durable context your agents can
            retrieve when they need it.
          </span>
        </div>
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
