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

const LABEL_GAP = 6;
const LABEL_MIN_GAP = 10;
const APPROX_CHARACTER_WIDTH = 6;

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
