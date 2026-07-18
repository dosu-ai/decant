import { describe, expect, test } from "bun:test";
import { layoutContextAnnotations } from "../src/ui/context-window-layout.ts";

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
