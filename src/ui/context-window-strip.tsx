import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  contextCurveAreaPath,
  contextCurveLinePath,
  groupContextMarkers,
  layoutContextCurve,
  layoutContextTooltip,
} from "./context-window-layout.ts";
import { contextWindowDisplayMode, isFullCacheMiss } from "./context-window-state.ts";
import { compact, formatInt } from "./format.ts";
import { Icon } from "./icons.tsx";
import type { ContextWindowCompactionData, ContextWindowTimelineData } from "./types.ts";

export const STRIP_HEIGHT = 214;

export const STRIP_PLOT_TOP = 44;

export const STRIP_RUG_HEIGHT = 30;

export const STRIP_PAD_LEFT = 46;

export const STRIP_PAD_RIGHT = 16;

export const STRIP_WINDOW_LABEL_Y = 13;

/** Auto-compact fires near the top of the window; the exact threshold varies
 * by version, so the zone is a directional hint, not a promise. */
export const STRIP_AUTO_COMPACT_ZONE = 0.8;

export function ContextWindowPanel({
  onJump,
  timeline,
}: {
  onJump: (seq: number) => void | Promise<void>;
  timeline: ContextWindowTimelineData | null;
}) {
  const mode = contextWindowDisplayMode(timeline);
  if (mode === "hidden" || timeline == null) {
    return null;
  }
  if (mode === "unavailable" || timeline.window_tokens == null) {
    return <ContextWindowUnavailable timeline={timeline} />;
  }
  return (
    <ContextWindowStrip onJump={onJump} timeline={timeline} windowTokens={timeline.window_tokens} />
  );
}

export function ContextWindowUnavailable({ timeline }: { timeline: ContextWindowTimelineData }) {
  const hasUsage = timeline.points.length > 0;
  return (
    <section className="panel context-window-panel">
      <div className="panel-heading">
        <div>
          <h2>Context window</h2>
          <p>How full the model's context window was at each API call across the session.</p>
        </div>
        <div className="activity-summary">
          {timeline.window_tokens != null ? (
            <span>
              <strong>{compact(timeline.window_tokens)}</strong>
              capacity
            </span>
          ) : null}
          {hasUsage ? (
            <span>
              <strong>{compact(timeline.peak_tokens)}</strong>
              peak tokens
            </span>
          ) : null}
        </div>
      </div>
      <div className="ctx-unavailable">
        <Icon name="info" />
        <div>
          <strong>
            {hasUsage
              ? "Window capacity not recorded or inferred"
              : "Per-call usage wasn’t recorded"}
          </strong>
          <p>
            {hasUsage
              ? "The transcript includes token usage, but Decant has no explicit context-window value and no model-based capacity for this source, so a trustworthy percentage is unavailable."
              : "This source session does not include the per-call token readings needed to reconstruct context usage."}
          </p>
        </div>
      </div>
    </section>
  );
}

export function ContextWindowStrip({
  onJump,
  timeline,
  windowTokens,
}: {
  onJump: (seq: number) => void | Promise<void>;
  timeline: ContextWindowTimelineData;
  windowTokens: number;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverCompactionGroup, setHoverCompactionGroup] = useState<number | null>(null);
  const [selectedCompactionGroup, setSelectedCompactionGroup] = useState<number | null>(null);
  const [tooltipSize, setTooltipSize] = useState({ height: 158, width: 208 });

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (element == null) {
      return;
    }
    const measure = () => setWidth(Math.floor(element.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // Fallback keeps the strip drawable even when measurement is delayed (e.g. a
  // hot-reloaded page whose effects did not re-run); the observer corrects it.
  const stripWidth = width > 0 ? width : 960;

  const layout = useMemo(() => {
    const points = timeline.points;
    const compactions = [...timeline.compactions].sort((a, b) => a.seq - b.seq);
    const peakLabel =
      timeline.peak_pct == null
        ? compact(timeline.peak_tokens)
        : `${Math.round(timeline.peak_pct * 100)}%`;

    const plotLeft = STRIP_PAD_LEFT;
    const plotRight = Math.max(plotLeft + 40, stripWidth - STRIP_PAD_RIGHT);
    const baseY = STRIP_HEIGHT - STRIP_RUG_HEIGHT;
    const yAt = (tokens: number) =>
      STRIP_PLOT_TOP + (1 - Math.min(1, tokens / windowTokens)) * (baseY - STRIP_PLOT_TOP);

    const { markerXs, segments, slotWidth, turnOrder, xs } = layoutContextCurve(
      points,
      compactions,
      { plotLeft, plotRight, yAt },
    );
    const xOf = (index: number) => xs[index] ?? plotLeft;

    const compactionMarks = compactions.map((compaction, index) => ({
      compaction,
      x: markerXs[index] ?? plotLeft,
    }));
    const compactionGroups = groupContextMarkers(compactionMarks.map(({ x }) => x));

    // Regular turn axis: a boundary tick at each slot edge, labels centered in
    // their slot for every labelStep-th turn.
    const labelStep = turnLabelStep(turnOrder.length);
    const turnMarks = turnOrder.map((turn, index) => ({
      turn,
      boundaryX: plotLeft + index * slotWidth,
      centerX: plotLeft + (index + 0.5) * slotWidth,
      labeled: index === 0 || turn % labelStep === 0,
    }));

    const lastIndex = points.length - 1;
    const lastPoint = points[lastIndex];
    const peakIndex = points.reduce(
      (best, point, index) =>
        point.context_tokens > (points[best]?.context_tokens ?? 0) ? index : best,
      0,
    );
    const peakPoint = points[peakIndex];
    const endY = lastPoint == null ? baseY : yAt(lastPoint.context_tokens);
    const peakX = xOf(peakIndex);
    const peakY = peakPoint == null ? baseY : yAt(peakPoint.context_tokens);
    return {
      baseY,
      compactionGroups,
      compactionMarks,
      compactions,
      endX: xOf(lastIndex),
      endY,
      // The live readout sits inside the plot, above the line when there is
      // room and below it when the session ended near the ceiling.
      endLabelAbove: endY > STRIP_PLOT_TOP + 30,
      lastIndex,
      lastPoint,
      peakIndex,
      peakLabel,
      peakLabelOnLeft: peakX > plotLeft + 70,
      peakLabelY: Math.max(STRIP_PLOT_TOP + 10, peakY - 7),
      peakPoint,
      peakX,
      peakY,
      plotLeft,
      plotRight,
      points,
      segments,
      turnMarks,
      xOf,
      xs,
      yAt,
    };
  }, [timeline, stripWidth, windowTokens]);
  const { baseY, compactionGroups, compactions, lastPoint, peakLabel, points, xOf, xs, yAt } =
    layout;

  // The static plot depends only on the layout; keeping its elements stable
  // lets React skip them while the pointer moves and only the hover overlay
  // and tooltip change. The handlers below only call state setters and onJump.
  const plot = useMemo(() => {
    const {
      baseY,
      compactionGroups,
      compactionMarks,
      compactions,
      endLabelAbove,
      endX,
      endY,
      lastIndex,
      lastPoint,
      peakIndex,
      peakLabel,
      peakLabelOnLeft,
      peakLabelY,
      peakPoint,
      peakX,
      peakY,
      plotLeft,
      plotRight,
      segments,
      turnMarks,
      yAt,
    } = layout;
    let previousTickLabelX = Number.NEGATIVE_INFINITY;
    return (
      <>
        <rect
          className="ctx-strip-band"
          height={yAt(windowTokens * STRIP_AUTO_COMPACT_ZONE) - yAt(windowTokens)}
          width={plotRight - plotLeft}
          x={plotLeft}
          y={yAt(windowTokens)}
        />
        <text
          className="ctx-strip-band-label"
          x={plotLeft + 4}
          y={yAt(windowTokens * STRIP_AUTO_COMPACT_ZONE) - 4}
        >
          auto-compact zone
        </text>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <g className="ctx-strip-grid" key={`grid-${fraction}`}>
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={yAt(windowTokens * fraction)}
              y2={yAt(windowTokens * fraction)}
            />
            <text textAnchor="end" x={plotLeft - 8} y={yAt(windowTokens * fraction) + 3.5}>
              {compact(windowTokens * fraction)}
            </text>
          </g>
        ))}
        <line
          className="ctx-strip-window"
          x1={plotLeft}
          x2={plotRight}
          y1={yAt(windowTokens)}
          y2={yAt(windowTokens)}
        />
        <text className="ctx-strip-label" x={plotLeft + 4} y={STRIP_WINDOW_LABEL_Y}>
          window · {compact(windowTokens)}
          {timeline.window_inferred ? " (inferred)" : ""}
        </text>
        {segments.map((coords) => (
          <g key={`seg-${coords[0]?.[0] ?? 0}`}>
            <path className="ctx-strip-area" d={contextCurveAreaPath(coords, baseY)} />
            <path className="ctx-strip-line" d={contextCurveLinePath(coords)} />
          </g>
        ))}
        <g className="ctx-strip-rug">
          {turnMarks.slice(1).map((mark) => (
            <line
              key={`tick-${mark.turn}`}
              x1={mark.boundaryX}
              x2={mark.boundaryX}
              y1={baseY + 3}
              y2={baseY + 8}
            />
          ))}
          {turnMarks.map((mark) => {
            if (!mark.labeled || mark.centerX - previousTickLabelX < 44) {
              return null;
            }
            previousTickLabelX = mark.centerX;
            return (
              <text
                key={`tick-label-${mark.turn}`}
                textAnchor="middle"
                x={mark.centerX}
                y={baseY + 20}
              >
                turn {mark.turn}
              </text>
            );
          })}
        </g>
        {compactionMarks.map(({ compaction, x }) => (
          <g className="ctx-strip-compaction" key={`compaction-mark-${compaction.seq}`}>
            <line x1={x} x2={x} y1={STRIP_PLOT_TOP} y2={baseY} />
            <rect
              fill="transparent"
              height={baseY - STRIP_PLOT_TOP}
              width={16}
              x={x - 8}
              y={STRIP_PLOT_TOP}
            >
              <title>{compactionLabel(compaction)}</title>
            </rect>
          </g>
        ))}
        {compactionGroups.map((group, groupIndex) => {
          const first = (group.indexes[0] ?? 0) + 1;
          const last = (group.indexes.at(-1) ?? 0) + 1;
          const firstCompaction = compactions[group.indexes[0] ?? 0];
          const label = first === last ? `${first}` : `${first}–${last}`;
          const markerWidth = first === last ? 18 : Math.max(28, label.length * 6 + 10);
          return (
            <a
              aria-label={
                first === last && firstCompaction != null
                  ? `Compaction ${first}: ${compactionTokenRange(firstCompaction)} tokens`
                  : `Compactions ${first} through ${last}`
              }
              href={`#message-${firstCompaction?.seq ?? 0}`}
              key={`compaction-group-${first}-${last}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const seq = firstCompaction?.seq;
                if (group.indexes.length > 1) {
                  setHoverIndex(null);
                  setSelectedCompactionGroup(groupIndex);
                } else if (seq != null) {
                  setSelectedCompactionGroup(null);
                  void onJump(seq);
                }
              }}
              onFocus={() => {
                setHoverIndex(null);
                setHoverCompactionGroup(groupIndex);
                if (group.indexes.length > 1) {
                  setSelectedCompactionGroup(groupIndex);
                }
              }}
              onMouseEnter={() => {
                setHoverIndex(null);
                setHoverCompactionGroup(groupIndex);
              }}
              onMouseMove={(event) => event.stopPropagation()}
            >
              <g className="ctx-strip-compaction-marker">
                <rect
                  height={18}
                  rx={9}
                  width={markerWidth}
                  x={group.x - markerWidth / 2}
                  y={STRIP_PLOT_TOP - 21}
                />
                <text textAnchor="middle" x={group.x} y={STRIP_PLOT_TOP - 8}>
                  {label}
                </text>
              </g>
            </a>
          );
        })}
        {peakPoint != null && peakIndex !== lastIndex ? (
          <g className="ctx-strip-peak">
            <circle cx={peakX} cy={peakY} r={2.5}>
              <title>
                Peak {peakLabel} · {compact(peakPoint.context_tokens)} tokens
              </title>
            </circle>
            <text
              textAnchor={peakLabelOnLeft ? "end" : "start"}
              x={peakX + (peakLabelOnLeft ? -6 : 6)}
              y={peakLabelY}
            >
              peak {peakLabel}
            </text>
          </g>
        ) : null}
        <g className="ctx-strip-end">
          <circle className="ctx-strip-end-halo" cx={endX} cy={endY} r={6.5} />
          <circle cx={endX} cy={endY} r={3}>
            <title>End · {compact(lastPoint?.context_tokens ?? 0)} tokens</title>
          </circle>
          <text textAnchor="end" x={endX - 9} y={endLabelAbove ? endY - 9 : endY + 18}>
            {Math.round(((lastPoint?.context_tokens ?? 0) / windowTokens) * 100)}% ·{" "}
            {compact(lastPoint?.context_tokens ?? 0)}
          </text>
        </g>
      </>
    );
  }, [layout, onJump, timeline.window_inferred, windowTokens]);

  const handleMove = (event: { clientX: number; currentTarget: SVGSVGElement }) => {
    setHoverCompactionGroup(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    let nearest = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, x] of xs.entries()) {
      const distance = Math.abs(x - mouseX);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = index;
      }
    }
    setHoverIndex(nearest);
  };
  const hovered = hoverIndex == null ? null : (points[hoverIndex] ?? null);
  const hoveredIsFullCacheMiss =
    hoverIndex != null && isFullCacheMiss(points, hoverIndex, compactions);
  const activeCompactionGroup = selectedCompactionGroup ?? hoverCompactionGroup;
  const hoveredCompactions =
    activeCompactionGroup == null ? null : (compactionGroups[activeCompactionGroup] ?? null);
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (element == null || (hovered == null && activeCompactionGroup == null)) {
      return;
    }
    const next = {
      height: Math.ceil(element.getBoundingClientRect().height),
      width: Math.ceil(element.getBoundingClientRect().width),
    };
    setTooltipSize((current) =>
      current.height === next.height && current.width === next.width ? current : next,
    );
  }, [hovered, activeCompactionGroup]);
  const tooltipAnchor =
    hoveredCompactions != null
      ? { x: hoveredCompactions.x, y: STRIP_PLOT_TOP }
      : hovered != null && hoverIndex != null
        ? { x: xOf(hoverIndex), y: yAt(hovered.context_tokens) }
        : null;
  const tooltipLayout =
    tooltipAnchor != null
      ? layoutContextTooltip({
          anchorX: tooltipAnchor.x,
          anchorY: tooltipAnchor.y,
          frameHeight: STRIP_HEIGHT,
          frameWidth: stripWidth,
          tooltipHeight: tooltipSize.height,
          tooltipWidth: tooltipSize.width,
        })
      : null;
  const handleJump = () => {
    if (hovered == null) {
      return;
    }
    void onJump(hovered.seq);
  };

  return (
    <section className="panel context-window-panel">
      <div className="panel-heading">
        <div>
          <h2>Context window</h2>
          <p>How full the model's context window was at each API call across the session.</p>
        </div>
        <div className="activity-summary">
          <span>
            <strong>{peakLabel}</strong>
            peak
          </span>
          <span>
            <strong>{formatInt(timeline.turn_count)}</strong>
            {timeline.turn_count === 1 ? "turn" : "turns"}
          </span>
          <span>
            <strong>{formatInt(points.length)}</strong>
            calls
          </span>
          <span>
            <strong>{formatInt(compactions.length)}</strong>
            {compactions.length === 1 ? "compaction" : "compactions"}
          </span>
        </div>
      </div>
      <div className="ctx-strip-wrap">
        <div className="ctx-strip-frame" ref={frameRef}>
          {lastPoint != null ? (
            <>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-jump is a
                  pointer-only shortcut; keyboard users reach the same turns via the
                  thread TOC and the compaction markers, which are real anchors. */}
              <svg
                aria-label={`Context window usage across ${points.length} API calls and ${timeline.turn_count} turns; peak ${peakLabel} of ${compact(windowTokens)}`}
                className="ctx-strip"
                height={STRIP_HEIGHT}
                onClick={(event) => {
                  setSelectedCompactionGroup(null);
                  handleJump();
                  event.currentTarget.focus();
                }}
                onMouseLeave={() => {
                  setHoverIndex(null);
                  setHoverCompactionGroup(null);
                }}
                onMouseMove={handleMove}
                width={stripWidth}
              >
                {plot}
                {hovered != null && hoverIndex != null ? (
                  <g className="ctx-strip-hover">
                    <line
                      x1={xOf(hoverIndex)}
                      x2={xOf(hoverIndex)}
                      y1={STRIP_PLOT_TOP}
                      y2={baseY}
                    />
                    <circle cx={xOf(hoverIndex)} cy={yAt(hovered.context_tokens)} r={3} />
                  </g>
                ) : null}
              </svg>
              {hoveredCompactions != null ? (
                <div
                  className={`ctx-tooltip ctx-compaction-tooltip${
                    selectedCompactionGroup != null ? " is-interactive" : ""
                  }`}
                  style={{
                    left: tooltipLayout?.left ?? 2,
                    top: tooltipLayout?.top ?? 2,
                  }}
                  ref={tooltipRef}
                >
                  <div className="ctx-tooltip-when">Context boundary</div>
                  <strong>
                    {hoveredCompactions.indexes.length === 1
                      ? `Compaction ${(hoveredCompactions.indexes[0] ?? 0) + 1}`
                      : `Compactions ${(hoveredCompactions.indexes[0] ?? 0) + 1}–${
                          (hoveredCompactions.indexes.at(-1) ?? 0) + 1
                        }`}
                  </strong>
                  <div className="ctx-tooltip-rows">
                    {hoveredCompactions.indexes.map((compactionIndex) => {
                      const compaction = compactions[compactionIndex];
                      return compaction == null ? null : selectedCompactionGroup != null ? (
                        <a
                          href={`#message-${compaction.seq}`}
                          key={`compaction-link-${compaction.seq}`}
                          onClick={(event) => {
                            event.preventDefault();
                            setSelectedCompactionGroup(null);
                            setHoverCompactionGroup(null);
                            void onJump(compaction.seq);
                          }}
                        >
                          <span>Compaction {compactionIndex + 1}</span>
                          <span>{compactionTokenRange(compaction)}</span>
                        </a>
                      ) : (
                        <span
                          className="ctx-tooltip-compaction-row"
                          key={`compaction-row-${compaction.seq}`}
                        >
                          <span>Compaction {compactionIndex + 1}</span>
                          <span>{compactionTokenRange(compaction)}</span>
                        </span>
                      );
                    })}
                  </div>
                  <div className="ctx-tooltip-hint">
                    {selectedCompactionGroup != null
                      ? "Choose a compaction to jump to the thread."
                      : hoveredCompactions.indexes.length > 1
                        ? "Select the numbered group to choose an exact compaction."
                        : "Select the marker to jump to the thread."}
                  </div>
                </div>
              ) : hovered != null && hoverIndex != null ? (
                <div
                  className="ctx-tooltip"
                  style={{
                    left: tooltipLayout?.left ?? 2,
                    top: tooltipLayout?.top ?? 2,
                  }}
                  ref={tooltipRef}
                >
                  <div className="ctx-tooltip-when">
                    turn {hovered.turn} · call {hoverIndex + 1} of {points.length}
                  </div>
                  <strong>
                    {Math.round((hovered.context_tokens / windowTokens) * 100)}% ·{" "}
                    {formatInt(hovered.context_tokens)} tokens in context
                  </strong>
                  <div className="ctx-tooltip-rows">
                    <span>cache read</span>
                    <span>{compact(hovered.cache_read_tokens)}</span>
                    <span>cache write</span>
                    <span>{compact(hovered.cache_creation_tokens)}</span>
                    {/* Claude Code sometimes reports raw input_tokens as a
                        small streaming placeholder; keeping it separate is
                        still more honest than folding it into cache writes. */}
                    <span>uncached input</span>
                    <span>{compact(hovered.input_tokens)}</span>
                  </div>
                  <div className="ctx-tooltip-output">
                    <span>output · this call</span>
                    <span>{compact(hovered.output_tokens)} tokens</span>
                  </div>
                  {hoveredIsFullCacheMiss ? (
                    <div className="ctx-tooltip-warning">
                      full cache miss — entire prompt re-sent
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function turnLabelStep(turnCount: number): number {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) {
    if (turnCount / step <= 8) {
      return step;
    }
  }
  return 1000;
}

export function compactionTokenRange(compaction: ContextWindowCompactionData): string {
  if (compaction.pre_tokens == null) {
    return "Token count unavailable";
  }
  const post = compaction.post_tokens != null ? ` → ${compact(compaction.post_tokens)}` : "";
  return `${compact(compaction.pre_tokens)}${post}`;
}

export function compactionLabel(compaction: ContextWindowCompactionData): string {
  const trigger = compaction.trigger != null ? `${compaction.trigger} compaction` : "compaction";
  if (compaction.pre_tokens == null) {
    return trigger;
  }
  const post = compaction.post_tokens != null ? ` → ${compact(compaction.post_tokens)}` : "";
  return `${trigger} · ${compact(compaction.pre_tokens)}${post} tokens`;
}
