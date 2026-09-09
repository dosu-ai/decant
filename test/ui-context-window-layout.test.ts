import { describe, expect, test } from "bun:test";
import {
  contextCurveAreaPath,
  contextCurveLinePath,
  contextCurveTopology,
  groupContextMarkers,
  layoutContextAnnotations,
  layoutContextCurve,
  layoutContextTooltip,
} from "../src/ui/context-window-layout.ts";

const OPTIONS = {
  labelYs: [28, 41],
  plotLeft: 46,
  plotRight: 500,
};

describe("layoutContextAnnotations", () => {
  test("keeps separated annotations in the first lane", () => {
    const placements = layoutContextAnnotations(
      [
        { text: "compacted · 230.3K → 31.2K", x: 100 },
        { text: "compacted · 220.5K → 32.2K", x: 320 },
      ],
      OPTIONS,
    );

    expect(placements.map(({ anchor, lane }) => ({ anchor, lane }))).toEqual([
      { anchor: "start", lane: 0 },
      { anchor: "start", lane: 0 },
    ]);
  });

  test("uses the second lane when nearby labels would collide", () => {
    const placements = layoutContextAnnotations(
      [
        { text: "compacted · 230.3K → 31.2K", x: 100 },
        { text: "compacted · 220.5K → 32.2K", x: 150 },
      ],
      OPTIONS,
    );

    expect(placements[0]?.lane).toBe(0);
    expect(placements[1]?.lane).toBe(1);
    expect(placements[0]?.textY).toBe(28);
    expect(placements[1]?.textY).toBe(41);
  });

  test("flips a right-edge label left without dropping it into the plot", () => {
    const [placement] = layoutContextAnnotations(
      [{ text: "compacted · 224.9K → 30.7K", x: 480 }],
      OPTIONS,
    );

    expect(placement).toMatchObject({
      anchor: "end",
      lane: 0,
      textY: 28,
    });
    expect(placement?.left).toBeGreaterThanOrEqual(OPTIONS.plotLeft);
    expect(placement?.right).toBeLessThanOrEqual(OPTIONS.plotRight);
  });
});

describe("layoutContextCurve", () => {
  test("normalizes uneven calls by turn and places compactions between exact calls", () => {
    const points = [
      { seq: 1, turn: 1, context_tokens: 100 },
      { seq: 2, turn: 1, context_tokens: 200 },
      { seq: 4, turn: 2, context_tokens: 50 },
    ];
    const compactions = [{ seq: 3 }];
    const topology = contextCurveTopology(points, compactions);

    expect(topology).toMatchObject({
      markerXs: [0.5625],
      segmentIndexes: [[0, 1], [2]],
      slotWidth: 0.5,
      turnOrder: [1, 2],
      xs: [0.125, 0.375, 0.75],
    });

    const pixels = layoutContextCurve(points, compactions, {
      plotLeft: 40,
      plotRight: 440,
      yAt: (tokens) => 300 - tokens,
    });
    expect(pixels.xs).toEqual([90, 190, 340]);
    expect(pixels.markerXs).toEqual([265]);
  });

  test("extends each curve segment to within the marker gap", () => {
    const layout = layoutContextCurve(
      [
        { seq: 1, turn: 1, context_tokens: 100 },
        { seq: 2, turn: 2, context_tokens: 200 },
        { seq: 4, turn: 3, context_tokens: 50 },
        { seq: 5, turn: 4, context_tokens: 75 },
      ],
      [{ seq: 3 }],
      { plotLeft: 0, plotRight: 400, markerGap: 3, yAt: (tokens) => 300 - tokens },
    );

    expect(layout.segments).toHaveLength(2);
    const marker = layout.markerXs[0] ?? 0;
    expect(Math.abs((layout.segments[0]?.at(-1)?.[0] ?? 0) - (marker - 3))).toBeLessThan(0.01);
    expect(Math.abs((layout.segments[1]?.[0]?.[0] ?? 0) - (marker + 3))).toBeLessThan(0.01);
    expect(
      (layout.segments[1]?.[0]?.[0] ?? 0) - (layout.segments[0]?.at(-1)?.[0] ?? 0),
    ).toBeLessThanOrEqual(6.01);
  });

  test("builds the live SVG paths from the shared curve coordinates", () => {
    const coords: [number, number][] = [
      [10, 50],
      [30, 20],
    ];
    expect(contextCurveLinePath(coords)).toBe("M10.0 50.0 L30.0 20.0");
    expect(contextCurveAreaPath(coords, 80)).toBe("M10.0 50.0 L30.0 20.0 L30.0 80 L10.0 80 Z");
  });
});

describe("layoutContextTooltip", () => {
  test("keeps normal and warning tooltips inside every frame edge", () => {
    for (const anchorX of [46, 160, 304]) {
      for (const anchorY of [48, 90, 196]) {
        for (const tooltipHeight of [118, 158]) {
          const layout = layoutContextTooltip({
            anchorX,
            anchorY,
            frameHeight: 214,
            frameWidth: 320,
            tooltipHeight,
            tooltipWidth: 208,
          });
          expect(layout.left).toBeGreaterThanOrEqual(2);
          expect(layout.top).toBeGreaterThanOrEqual(2);
          expect(layout.left + 208).toBeLessThanOrEqual(318);
          expect(layout.top + tooltipHeight).toBeLessThanOrEqual(212);
        }
      }
    }
  });

  test("pins an oversized tooltip to the frame inset", () => {
    expect(
      layoutContextTooltip({
        anchorX: 90,
        anchorY: 100,
        frameHeight: 214,
        frameWidth: 180,
        tooltipHeight: 118,
        tooltipWidth: 208,
      }),
    ).toEqual({ left: 2, top: 76 });
  });
});

describe("groupContextMarkers", () => {
  test("keeps separated markers on their exact x and groups only dense neighbors", () => {
    expect(groupContextMarkers([100, 280, 305, 480])).toEqual([
      { indexes: [0], x: 100 },
      { indexes: [1, 2], x: 292.5 },
      { indexes: [3], x: 480 },
    ]);
  });
});
