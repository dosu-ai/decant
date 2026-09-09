export interface ContextAnnotationInput {
  text: string;
  x: number;
}

export interface ContextAnnotationPlacement {
  anchor: "start" | "end";
  lane: number;
  left: number;
  right: number;
  textX: number;
  textY: number;
}

export interface ContextAnnotationLayoutOptions {
  labelYs: readonly number[];
  plotLeft: number;
  plotRight: number;
}

export interface ContextCurvePoint {
  context_tokens: number;
  seq: number;
  turn: number;
}

export interface ContextCurveCompaction {
  seq: number;
}

export interface ContextCurveLayoutOptions {
  markerGap?: number;
  plotLeft: number;
  plotRight: number;
  yAt: (tokens: number) => number;
}

export interface ContextCurveLayout {
  markerXs: number[];
  segments: [number, number][][];
  slotWidth: number;
  turnOrder: number[];
  xs: number[];
}

export interface ContextCurveTopology {
  /** Compaction positions in the same normalized 0..1 space as pointXs. */
  markerXs: number[];
  /** Point indexes split at every compaction boundary. */
  segmentIndexes: number[][];
  /** One horizontal slot per distinct turn, expressed as a fraction of width. */
  slotWidth: number;
  turnOrder: number[];
  /** Call positions normalized to the plot width. */
  xs: number[];
}

export interface ContextTooltipLayoutOptions {
  anchorX: number;
  anchorY: number;
  frameHeight: number;
  frameWidth: number;
  gap?: number;
  inset?: number;
  tooltipHeight: number;
  tooltipWidth: number;
}

export interface ContextMarkerGroup {
  indexes: number[];
  x: number;
}

const LABEL_GAP = 6;
const LABEL_MIN_GAP = 10;
const APPROX_CHARACTER_WIDTH = 6;
const DEFAULT_MARKER_GAP = 3;

export function layoutContextCurve(
  points: readonly ContextCurvePoint[],
  compactions: readonly ContextCurveCompaction[],
  options: ContextCurveLayoutOptions,
): ContextCurveLayout {
  const plotWidth = Math.max(0, options.plotRight - options.plotLeft);
  const topology = contextCurveTopology(points, compactions);
  const xs = topology.xs.map((x) => options.plotLeft + x * plotWidth);
  const markerXs = topology.markerXs.map((x) => options.plotLeft + x * plotWidth);
  const slotWidth = topology.slotWidth * plotWidth;
  const xOf = (index: number) => xs[index] ?? options.plotLeft;
  const markerGap = options.markerGap ?? DEFAULT_MARKER_GAP;

  const boundaryMarks = (previousIndex: number, nextIndex: number): number[] => {
    const previousSeq = points[previousIndex]?.seq ?? Number.NEGATIVE_INFINITY;
    const nextSeq = points[nextIndex]?.seq ?? Number.POSITIVE_INFINITY;
    return compactions.flatMap((compaction, index) =>
      compaction.seq >= previousSeq && compaction.seq < nextSeq
        ? [markerXs[index] ?? options.plotLeft]
        : [],
    );
  };

  const segments = topology.segmentIndexes.map((indexes, segmentIndex) => {
    const coords = indexes.map(
      (index) => [xOf(index), options.yAt(points[index]?.context_tokens ?? 0)] as [number, number],
    );
    const firstIndex = indexes[0];
    const lastIndex = indexes.at(-1);
    if (firstIndex == null || lastIndex == null || coords.length === 0) {
      return coords;
    }

    const previousLastIndex = topology.segmentIndexes[segmentIndex - 1]?.at(-1);
    if (previousLastIndex != null) {
      const marks = boundaryMarks(previousLastIndex, firstIndex);
      const lastMark = marks.at(-1);
      const firstCoord = coords[0];
      if (lastMark != null && firstCoord != null) {
        coords.unshift([Math.min(firstCoord[0], lastMark + markerGap), firstCoord[1]]);
      }
    }

    const nextFirstIndex = topology.segmentIndexes[segmentIndex + 1]?.[0];
    if (nextFirstIndex != null) {
      const marks = boundaryMarks(lastIndex, nextFirstIndex);
      const firstMark = marks[0];
      const lastCoord = coords.at(-1);
      if (firstMark != null && lastCoord != null) {
        coords.push([Math.max(lastCoord[0], firstMark - markerGap), lastCoord[1]]);
      }
    }
    return coords;
  });

  return { markerXs, segments, slotWidth, turnOrder: topology.turnOrder, xs };
}

/**
 * Pure source-of-truth for the context strip's horizontal geometry. Renderers
 * can map this normalized topology to SVG pixels (the live view) or chart
 * coordinates (static reports) without independently deciding where calls and
 * compaction boundaries belong.
 */
export function contextCurveTopology(
  points: readonly ContextCurvePoint[],
  compactions: readonly ContextCurveCompaction[],
): ContextCurveTopology {
  const turnOrder: number[] = [];
  const callsPerTurn = new Map<number, number>();
  for (const point of points) {
    if (!callsPerTurn.has(point.turn)) {
      turnOrder.push(point.turn);
    }
    callsPerTurn.set(point.turn, (callsPerTurn.get(point.turn) ?? 0) + 1);
  }

  const slotByTurn = new Map(turnOrder.map((turn, index) => [turn, index] as const));
  const slotWidth = turnOrder.length === 0 ? 1 : 1 / turnOrder.length;
  const seenInTurn = new Map<number, number>();
  const xs = points.map((point) => {
    const position = seenInTurn.get(point.turn) ?? 0;
    seenInTurn.set(point.turn, position + 1);
    const slot = slotByTurn.get(point.turn) ?? 0;
    const calls = callsPerTurn.get(point.turn) ?? 1;
    return (slot + (position + 0.5) / calls) * slotWidth;
  });
  const xOf = (index: number) => xs[index] ?? 0;

  const markerXs = compactions.map((compaction) => {
    const after = points.findIndex((point) => point.seq > compaction.seq);
    if (after < 0) {
      return xOf(points.length - 1);
    }
    if (after === 0) {
      return xOf(0);
    }
    return (xOf(after - 1) + xOf(after)) / 2;
  });

  const segmentIndexes: number[][] = [];
  let current: number[] = [];
  let nextCompaction = 0;
  points.forEach((point, index) => {
    let cut = false;
    while (
      nextCompaction < compactions.length &&
      (compactions[nextCompaction]?.seq ?? 0) < point.seq
    ) {
      nextCompaction += 1;
      cut = true;
    }
    if (cut && current.length > 0) {
      segmentIndexes.push(current);
      current = [];
    }
    current.push(index);
  });
  if (current.length > 0) {
    segmentIndexes.push(current);
  }

  return { markerXs, segmentIndexes, slotWidth, turnOrder, xs };
}

export function contextCurveLinePath(coords: readonly [number, number][]): string {
  return coords
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
}

export function contextCurveAreaPath(coords: readonly [number, number][], baseY: number): string {
  const first = coords[0];
  const last = coords.at(-1);
  if (first == null || last == null) {
    return "";
  }
  return `${contextCurveLinePath(coords)} L${last[0].toFixed(1)} ${baseY} L${first[0].toFixed(
    1,
  )} ${baseY} Z`;
}

export function layoutContextAnnotations(
  annotations: readonly ContextAnnotationInput[],
  options: ContextAnnotationLayoutOptions,
): ContextAnnotationPlacement[] {
  const labelYs = options.labelYs.length > 0 ? options.labelYs : [0];
  const occupied = labelYs.map(() => [] as { left: number; right: number }[]);

  return annotations.map((annotation) => {
    const width = Math.min(
      options.plotRight - options.plotLeft,
      Math.max(APPROX_CHARACTER_WIDTH, annotation.text.length * APPROX_CHARACTER_WIDTH),
    );
    const preferred: ("start" | "end")[] =
      annotation.x + LABEL_GAP + width <= options.plotRight ? ["start", "end"] : ["end", "start"];

    for (const anchor of preferred) {
      const candidate = annotationBounds(annotation.x, width, anchor);
      if (candidate.left < options.plotLeft || candidate.right > options.plotRight) {
        continue;
      }
      for (const [lane, laneBounds] of occupied.entries()) {
        if (laneBounds.every((bounds) => !overlaps(candidate, bounds))) {
          laneBounds.push(candidate);
          return {
            anchor,
            lane,
            ...candidate,
            textY: labelYs[lane] ?? labelYs[0] ?? 0,
          };
        }
      }
    }

    const anchor = preferred[0] ?? "start";
    const unclamped = annotationBounds(annotation.x, width, anchor);
    const shift =
      unclamped.left < options.plotLeft
        ? options.plotLeft - unclamped.left
        : unclamped.right > options.plotRight
          ? options.plotRight - unclamped.right
          : 0;
    const fallback = {
      left: unclamped.left + shift,
      right: unclamped.right + shift,
      textX: unclamped.textX + shift,
    };
    const lane = leastCrowdedLane(fallback, occupied);
    occupied[lane]?.push(fallback);
    return {
      anchor,
      lane,
      ...fallback,
      textY: labelYs[lane] ?? labelYs[0] ?? 0,
    };
  });
}

export function layoutContextTooltip(options: ContextTooltipLayoutOptions): {
  left: number;
  top: number;
} {
  const inset = options.inset ?? 2;
  const gap = options.gap ?? 12;
  const availableWidth = Math.max(0, options.frameWidth - inset * 2);
  const availableHeight = Math.max(0, options.frameHeight - inset * 2);
  const tooltipWidth = Math.min(options.tooltipWidth, availableWidth);
  const tooltipHeight = Math.min(options.tooltipHeight, availableHeight);
  const placeOnLeft = options.anchorX + gap + tooltipWidth > options.frameWidth - inset;
  const preferredLeft = placeOnLeft ? options.anchorX - gap - tooltipWidth : options.anchorX + gap;
  const preferredTop = options.anchorY - 24;
  return {
    left: clamp(preferredLeft, inset, options.frameWidth - inset - tooltipWidth),
    top: clamp(preferredTop, inset, options.frameHeight - inset - tooltipHeight),
  };
}

export function groupContextMarkers(
  markerXs: readonly number[],
  minimumSeparation = 28,
): ContextMarkerGroup[] {
  const groups: ContextMarkerGroup[] = [];
  for (const [index, x] of markerXs.entries()) {
    const previousX = markerXs[index - 1];
    const current = groups.at(-1);
    if (current != null && previousX != null && x - previousX < minimumSeparation) {
      current.indexes.push(index);
      current.x =
        current.indexes.reduce((total, markerIndex) => total + (markerXs[markerIndex] ?? 0), 0) /
        current.indexes.length;
    } else {
      groups.push({ indexes: [index], x });
    }
  }
  return groups;
}

function annotationBounds(
  markerX: number,
  width: number,
  anchor: "start" | "end",
): { left: number; right: number; textX: number } {
  const textX = anchor === "start" ? markerX + LABEL_GAP : markerX - LABEL_GAP;
  return {
    left: anchor === "start" ? textX : textX - width,
    right: anchor === "start" ? textX + width : textX,
    textX,
  };
}

function overlaps(
  left: { left: number; right: number },
  right: { left: number; right: number },
): boolean {
  return left.left < right.right + LABEL_MIN_GAP && left.right > right.left - LABEL_MIN_GAP;
}

function leastCrowdedLane(
  candidate: { left: number; right: number },
  occupied: readonly { left: number; right: number }[][],
): number {
  let bestLane = 0;
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (const [lane, laneBounds] of occupied.entries()) {
    const overlap = laneBounds.reduce(
      (total, bounds) =>
        total +
        Math.max(
          0,
          Math.min(candidate.right, bounds.right) - Math.max(candidate.left, bounds.left),
        ),
      0,
    );
    if (overlap < bestOverlap) {
      bestLane = lane;
      bestOverlap = overlap;
    }
  }
  return bestLane;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
